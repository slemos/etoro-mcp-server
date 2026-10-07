import { randomBytes, randomUUID } from "node:crypto";
import type { AuditFn } from "../audit.js";
import type { Config, EtoroEnv } from "../config.js";
import { EtoroApiError, PolicyError } from "../errors.js";
import { HistoryDb } from "../history/db.js";
import { ApprovalGrant } from "./grant.js";

export type ProposalStatus = "pending" | "executing" | "executed" | "rejected" | "expired" | "failed";

export interface ProposalRow {
  label: string;
  value: string;
}

export interface ActionRefs {
  orderId?: number;
  positionId?: number;
  instrumentId?: number;
}

export interface ProposalInput {
  tool: string;
  /** One line describing the exact action, shown on the approval page and in the audit log. */
  summary: string;
  /** Detail lines for the approval page. */
  rows: ProposalRow[];
  warnings?: string[];
  /** Money at risk or moved by this action, counted against the session and daily caps. */
  exposureUsd: number;
  /** Ids the action is about, so the history can be searched by them. */
  refs?: ActionRefs;
  /** Sends the request to eToro. Runs only after the user presses Execute. */
  run: (ctx: { requestId: string; grant: ApprovalGrant }) => Promise<unknown>;
}

/** A write operation that has been previewed. Claude can create it; only the user can execute it. */
export interface Proposal {
  id: string;
  /** Secret in the approval page's address. Never given to the model unless ETORO_SHOW_APPROVAL_URL is set. */
  token: string;
  /** Anti-CSRF value embedded in the approval page's forms. */
  csrf: string;
  tool: string;
  summary: string;
  rows: ProposalRow[];
  warnings: string[];
  env: EtoroEnv;
  /** Reused on every attempt so a retried execution is idempotent at eToro. */
  requestId: string;
  exposureUsd: number;
  refs: ActionRefs;
  createdAt: number;
  expiresAt: number;
  status: ProposalStatus;
  decidedAt?: number;
  result?: unknown;
  error?: string;
  run: ProposalInput["run"];
}

export interface ExecuteOutcome {
  /** "blocked": a local limit stopped it; the proposal stays pending and can be executed again later. */
  outcome: "executed" | "failed" | "blocked" | "not_pending";
  message?: string;
  proposal: Proposal;
}

const MAX_PENDING = 20;
const MAX_KEPT = 200;
const KEEP_AFTER_EXPIRY_MS = 60 * 60_000;

const nopAudit: AuditFn = () => {};
const MAX_STORED_RESULT_CHARS = 50_000;

/** Looks for a numeric id under one of `keys` in an eToro answer (shapes vary: orderId, OrderID, nested objects). */
function findId(value: unknown, keys: string[], depth = 0): number | undefined {
  if (depth > 4 || value === null || typeof value !== "object") return undefined;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (keys.includes(k.toLowerCase()) && typeof v === "number" && Number.isSafeInteger(v) && v > 0) return v;
  }
  for (const v of Object.values(value as Record<string, unknown>)) {
    const found = findId(v, keys, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * True only when eToro clearly answered "no" (a 4xx other than a timeout), so the request had no effect and its daily
 * allowance can be given back. A network error, a timeout or a 5xx is ambiguous: the order may have gone through, so it stays counted.
 */
function surelyNotExecuted(err: unknown): boolean {
  return err instanceof EtoroApiError && err.status >= 400 && err.status < 500 && err.status !== 408;
}

/** eToro's answer as stored in the history: whole when small, otherwise a marker, so one odd answer cannot bloat the file. */
function storable(result: unknown): unknown {
  const text = JSON.stringify(result) ?? "null";
  return text.length <= MAX_STORED_RESULT_CHARS ? result : { truncated: true, characters: text.length, preview: text.slice(0, 2000) };
}

export class ProposalStore {
  private readonly items = new Map<string, Proposal>();
  private executions: number[] = [];
  private spentUsd = 0;

  constructor(
    private readonly cfg: Config,
    private readonly now: () => number = Date.now,
    private readonly audit: AuditFn = nopAudit,
    private readonly explain: (err: unknown) => string = (err) => (err instanceof Error ? err.message : String(err)),
    /** The durable record and the daily ledger. Tests that do not care get a throwaway in-memory one. */
    readonly db: HistoryDb = new HistoryDb(":memory:", now),
  ) {}

  /** Audit trail line + the same event in the history database. A history failure never stops an action. */
  private emit(event: Record<string, unknown>): void {
    this.audit(event);
    this.persist(() => this.db.recordEvent(this.cfg.env, event));
  }

  private persist(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.audit({ event: "history_error", error: err instanceof Error ? err.message : String(err) });
    }
  }

  create(input: ProposalInput): Proposal {
    this.sweep();
    const pending = [...this.items.values()].filter((p) => p.status === "pending").length;
    if (pending >= MAX_PENDING) {
      throw new PolicyError("Too many proposals waiting for the user. Execute or reject them, or wait for them to expire.");
    }
    const t = this.now();
    const proposal: Proposal = {
      id: randomUUID(),
      token: randomBytes(32).toString("base64url"),
      csrf: randomBytes(16).toString("base64url"),
      tool: input.tool,
      summary: input.summary,
      rows: input.rows,
      warnings: input.warnings ?? [],
      env: this.cfg.env,
      requestId: randomUUID(),
      exposureUsd: input.exposureUsd,
      refs: input.refs ?? {},
      createdAt: t,
      expiresAt: t + this.cfg.confirmTtlMs,
      status: "pending",
      run: input.run,
    };
    this.items.set(proposal.id, proposal);
    this.persist(() =>
      this.db.insertAction({
        id: proposal.id,
        env: proposal.env,
        tool: proposal.tool,
        summary: proposal.summary,
        rows: proposal.rows,
        warnings: proposal.warnings,
        exposureUsd: proposal.exposureUsd,
        status: proposal.status,
        createdAt: proposal.createdAt,
        expiresAt: proposal.expiresAt,
        ...proposal.refs,
      }),
    );
    this.emit({
      event: "prepared",
      tool: proposal.tool,
      actionId: proposal.id,
      summary: proposal.summary,
      ...(proposal.exposureUsd > 0 ? { exposureUsd: proposal.exposureUsd } : {}),
    });
    return proposal;
  }

  get(id: string): Proposal | undefined {
    this.sweep();
    return this.items.get(id);
  }

  getByToken(token: string): Proposal | undefined {
    this.sweep();
    for (const p of this.items.values()) if (p.token === token) return p;
    return undefined;
  }

  /** Throws PolicyError if executing `proposal` now would break a per-minute or per-session limit (the daily limits are checked in the database). */
  assertWithinLimits(proposal: Proposal): void {
    const cutoff = this.now() - 60_000;
    this.executions = this.executions.filter((t) => t > cutoff);
    if (this.executions.length >= this.cfg.maxWritesPerMinute) {
      throw new PolicyError(
        `Write rate limit reached (${this.cfg.maxWritesPerMinute} per minute, ETORO_MAX_WRITES_PER_MINUTE). Wait a minute and press Execute again.`,
      );
    }
    if (this.spentUsd + proposal.exposureUsd > this.cfg.maxSessionUsd) {
      throw new PolicyError(
        `Session exposure cap reached: $${this.spentUsd.toFixed(2)} already executed + $${proposal.exposureUsd.toFixed(2)} ` +
          `would exceed ETORO_MAX_SESSION_USD ($${this.cfg.maxSessionUsd}). Restart the server to reset the counter.`,
      );
    }
  }

  /** Called when the user presses Execute on the approval page (and nowhere else). */
  async execute(id: string): Promise<ExecuteOutcome> {
    const proposal = this.get(id);
    if (!proposal) throw new PolicyError("Unknown action.");
    if (proposal.status !== "pending") return { outcome: "not_pending", proposal };
    try {
      this.assertWithinLimits(proposal);
      // The daily limits are counted in the shared database, so they hold across server processes and restarts. Fail closed.
      this.db.reserve({
        actionId: id,
        env: proposal.env,
        exposureUsd: proposal.exposureUsd,
        now: this.now(),
        maxUsd: this.cfg.maxDailyUsd,
        maxWrites: this.cfg.maxDailyWrites,
        timezone: this.cfg.timezone,
      });
    } catch (err) {
      const message = err instanceof PolicyError ? err.message : `Could not check the daily limits, so nothing was sent: ${err instanceof Error ? err.message : String(err)}`;
      this.emit({ event: "blocked", tool: proposal.tool, actionId: id, reason: message });
      return { outcome: "blocked", message, proposal };
    }
    proposal.status = "executing";
    proposal.decidedAt = this.now();
    this.persist(() => this.db.updateAction(id, { status: "executing", decidedAt: proposal.decidedAt }));
    this.emit({ event: "approved_by_user", tool: proposal.tool, actionId: id });
    try {
      proposal.result = await proposal.run({ requestId: proposal.requestId, grant: ApprovalGrant.mint() });
      proposal.status = "executed";
      this.executions.push(this.now());
      this.spentUsd += proposal.exposureUsd;
      const orderId = proposal.refs.orderId ?? findId(proposal.result, ["orderid"]);
      const positionId = proposal.refs.positionId ?? findId(proposal.result, ["positionid"]);
      this.persist(() => this.db.updateAction(id, { status: "executed", result: storable(proposal.result), ...(orderId !== undefined ? { orderId } : {}), ...(positionId !== undefined ? { positionId } : {}) }));
      this.emit({ event: "executed", tool: proposal.tool, actionId: id, summary: proposal.summary });
      return { outcome: "executed", proposal };
    } catch (err) {
      proposal.status = "failed";
      proposal.error = this.explain(err).split("\n")[0];
      if (surelyNotExecuted(err)) this.persist(() => this.db.release(id));
      this.persist(() => this.db.updateAction(id, { status: "failed", error: proposal.error }));
      this.emit({ event: "failed", tool: proposal.tool, actionId: id, error: proposal.error });
      return { outcome: "failed", message: proposal.error, proposal };
    }
  }

  /** Called when the user presses Reject on the approval page. */
  reject(id: string): Proposal {
    const proposal = this.get(id);
    if (!proposal) throw new PolicyError("Unknown action.");
    if (proposal.status === "pending") {
      proposal.status = "rejected";
      proposal.decidedAt = this.now();
      this.persist(() => this.db.updateAction(id, { status: "rejected", decidedAt: proposal.decidedAt }));
      this.emit({ event: "rejected", tool: proposal.tool, actionId: id });
    }
    return proposal;
  }

  /** What the model may see about a proposal: never the token or the anti-CSRF value. */
  view(proposal: Proposal): Record<string, unknown> {
    return {
      actionId: proposal.id,
      tool: proposal.tool,
      environment: proposal.env,
      status: proposal.status,
      summary: proposal.summary,
      createdAt: new Date(proposal.createdAt).toISOString(),
      expiresAt: new Date(proposal.expiresAt).toISOString(),
      ...(proposal.decidedAt !== undefined ? { decidedAt: new Date(proposal.decidedAt).toISOString() } : {}),
      ...(proposal.status === "executed" ? { result: proposal.result } : {}),
      ...(proposal.status === "failed" ? { error: proposal.error } : {}),
    };
  }

  /** Marks overdue proposals as expired and forgets old ones. */
  private sweep(): void {
    const t = this.now();
    for (const [id, p] of this.items) {
      if (p.status === "pending" && p.expiresAt <= t) {
        p.status = "expired";
        p.decidedAt = t;
        this.persist(() => this.db.updateAction(id, { status: "expired", decidedAt: t }));
        this.emit({ event: "expired", tool: p.tool, actionId: id });
      }
      if (p.status !== "pending" && p.status !== "executing" && p.expiresAt + KEEP_AFTER_EXPIRY_MS <= t) this.items.delete(id);
    }
    while (this.items.size > MAX_KEPT) {
      const oldest = this.items.keys().next().value;
      if (oldest === undefined) break;
      this.items.delete(oldest);
    }
  }
}
