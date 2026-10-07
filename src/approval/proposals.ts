import { randomBytes, randomUUID } from "node:crypto";
import type { AuditFn } from "../audit.js";
import type { Config, EtoroEnv } from "../config.js";
import { PolicyError } from "../errors.js";
import { ApprovalGrant } from "./grant.js";

export type ProposalStatus = "pending" | "executing" | "executed" | "rejected" | "expired" | "failed";

export interface ProposalRow {
  label: string;
  value: string;
}

export interface ProposalInput {
  tool: string;
  /** One line describing the exact action, shown on the approval page and in the audit log. */
  summary: string;
  /** Detail lines for the approval page. */
  rows: ProposalRow[];
  warnings?: string[];
  /** Money at risk or moved by this action, counted against the session cap. */
  exposureUsd: number;
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

export class ProposalStore {
  private readonly items = new Map<string, Proposal>();
  private executions: number[] = [];
  private spentUsd = 0;

  constructor(
    private readonly cfg: Config,
    private readonly now: () => number = Date.now,
    private readonly audit: AuditFn = nopAudit,
    private readonly explain: (err: unknown) => string = (err) => (err instanceof Error ? err.message : String(err)),
  ) {}

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
      createdAt: t,
      expiresAt: t + this.cfg.confirmTtlMs,
      status: "pending",
      run: input.run,
    };
    this.items.set(proposal.id, proposal);
    this.audit({
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

  /** Throws PolicyError if executing `proposal` now would break a rate or exposure limit. */
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
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.audit({ event: "blocked", tool: proposal.tool, actionId: id, reason: message });
      return { outcome: "blocked", message, proposal };
    }
    proposal.status = "executing";
    proposal.decidedAt = this.now();
    this.audit({ event: "approved_by_user", tool: proposal.tool, actionId: id });
    try {
      proposal.result = await proposal.run({ requestId: proposal.requestId, grant: ApprovalGrant.mint() });
      proposal.status = "executed";
      this.executions.push(this.now());
      this.spentUsd += proposal.exposureUsd;
      this.audit({ event: "executed", tool: proposal.tool, actionId: id, summary: proposal.summary });
      return { outcome: "executed", proposal };
    } catch (err) {
      proposal.status = "failed";
      proposal.error = this.explain(err).split("\n")[0];
      this.audit({ event: "failed", tool: proposal.tool, actionId: id, error: proposal.error });
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
      this.audit({ event: "rejected", tool: proposal.tool, actionId: id });
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
        this.audit({ event: "expired", tool: p.tool, actionId: id });
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
