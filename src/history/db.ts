/**
 * The local record of what this server prepared and executed: one SQLite file (node:sqlite, no native dependency).
 *
 *  - `actions`: one row per prepared action and its life cycle, with eToro's answer;
 *  - `events`: the audit trail, in order, so an action's timeline can be shown;
 *  - `ledger`: what each executed (or executing) action counts against the daily limits.
 *
 * Several server processes can share the file (Claude Desktop and Claude Code each start their own): WAL mode plus
 * `BEGIN IMMEDIATE` make "check the daily limit and reserve the amount" one atomic step across all of them.
 * Nothing here ever stores API keys or approval tokens, and every query is parameterized.
 */
import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { EtoroEnv } from "../config.js";
import { PolicyError } from "../errors.js";
import type { ProposalRow, ProposalStatus } from "../approval/proposals.js";
import { dayKey } from "./time.js";

const SCHEMA_VERSION = 1;
/** An action stuck in "executing" for longer than this belongs to a process that died before recording eToro's answer. */
const STALE_EXECUTING_MS = 10 * 60_000;

export interface ActionRecord {
  id: string;
  env: EtoroEnv;
  tool: string;
  summary: string;
  rows: ProposalRow[];
  warnings: string[];
  exposureUsd: number;
  status: ProposalStatus;
  createdAt: number;
  expiresAt: number;
  decidedAt?: number;
  result?: unknown;
  error?: string;
  orderId?: number;
  positionId?: number;
  instrumentId?: number;
}

/** A row of the history list: everything but the bulky detail. */
export type ActionSummary = Omit<ActionRecord, "rows" | "warnings" | "result">;

export interface EventRecord {
  id: number;
  ts: number;
  env: string;
  event: string;
  tool?: string;
  actionId?: string;
  detail: Record<string, unknown>;
}

export interface HistoryFilter {
  /** Free text: words match the summary, the tool or an id (order, position, instrument, action). All words must match. */
  q?: string;
  env?: EtoroEnv;
  tool?: string;
  status?: ProposalStatus;
  /** Inclusive lower bound and exclusive upper bound of the creation time, in ms. */
  from?: number;
  to?: number;
  limit?: number;
  offset?: number;
}

export interface Usage {
  day: string;
  usd: number;
  writes: number;
}

export interface Reservation {
  actionId: string;
  env: EtoroEnv;
  exposureUsd: number;
  now: number;
  maxUsd: number;
  maxWrites: number;
  timezone: string;
}

type Row = Record<string, unknown>;

const SCHEMA = `
CREATE TABLE actions (
  id TEXT PRIMARY KEY,
  env TEXT NOT NULL,
  tool TEXT NOT NULL,
  summary TEXT NOT NULL,
  rows_json TEXT NOT NULL,
  warnings_json TEXT NOT NULL,
  exposure_usd REAL NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  decided_at INTEGER,
  result_json TEXT,
  error TEXT,
  order_id INTEGER,
  position_id INTEGER,
  instrument_id INTEGER
);
CREATE INDEX actions_created ON actions (created_at);
CREATE INDEX actions_status ON actions (status);
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  env TEXT NOT NULL,
  event TEXT NOT NULL,
  tool TEXT,
  action_id TEXT,
  detail_json TEXT NOT NULL
);
CREATE INDEX events_action ON events (action_id);
CREATE TABLE ledger (
  action_id TEXT PRIMARY KEY,
  env TEXT NOT NULL,
  day TEXT NOT NULL,
  ts INTEGER NOT NULL,
  exposure_usd REAL NOT NULL
);
CREATE INDEX ledger_day ON ledger (env, day);
`;

const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

function parseJson<T>(text: unknown, fallback: T): T {
  if (typeof text !== "string") return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/** Escapes LIKE wildcards so a search word is matched literally. */
function likePattern(word: string): string {
  return `%${word.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

function toSummary(r: Row): ActionSummary {
  return {
    id: String(r.id),
    env: r.env === "real" ? "real" : "demo",
    tool: String(r.tool),
    summary: String(r.summary),
    exposureUsd: num(r.exposure_usd) ?? 0,
    status: String(r.status) as ProposalStatus,
    createdAt: num(r.created_at) ?? 0,
    expiresAt: num(r.expires_at) ?? 0,
    ...(num(r.decided_at) !== undefined ? { decidedAt: num(r.decided_at) } : {}),
    ...(str(r.error) !== undefined ? { error: str(r.error) } : {}),
    ...(num(r.order_id) !== undefined ? { orderId: num(r.order_id) } : {}),
    ...(num(r.position_id) !== undefined ? { positionId: num(r.position_id) } : {}),
    ...(num(r.instrument_id) !== undefined ? { instrumentId: num(r.instrument_id) } : {}),
  };
}

export class HistoryDb {
  private readonly db: DatabaseSync;

  constructor(
    readonly path: string,
    private readonly now: () => number = Date.now,
  ) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      // Create the file private before SQLite does; its -wal and -shm files copy these permissions.
      closeSync(openSync(path, "a", 0o600));
      try {
        chmodSync(path, 0o600);
      } catch {
        // Not every file system supports modes (Windows).
      }
    }
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA busy_timeout = 5000");
    if (path !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL");
    this.migrate();
    this.recoverStale();
  }

  get persistent(): boolean {
    return this.path !== ":memory:";
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    const version = num((this.db.prepare("PRAGMA user_version").get() as Row).user_version) ?? 0;
    if (version > SCHEMA_VERSION) {
      throw new Error(`The history database ${this.path} was written by a newer version of this server (schema ${version}). Update the server or point ETORO_HISTORY_DB elsewhere.`);
    }
    if (version === 0) {
      this.transaction(() => {
        this.db.exec(SCHEMA);
        this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      });
    }
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // The original error matters more.
      }
      throw err;
    }
  }

  /** Marks actions whose server died mid-execution, and pending ones past their expiry, so the history never lies. */
  recoverStale(): void {
    const t = this.now();
    this.db
      .prepare("UPDATE actions SET status = 'failed', error = ? WHERE status = 'executing' AND decided_at < ?")
      .run("Interrupted: the server stopped before eToro's answer was recorded. Check the account in eToro.", t - STALE_EXECUTING_MS);
    this.db.prepare("UPDATE actions SET status = 'expired', decided_at = expires_at WHERE status = 'pending' AND expires_at < ?").run(t);
  }

  // ------------------------------------------------------------------ writes
  insertAction(a: ActionRecord): void {
    this.db
      .prepare(
        `INSERT INTO actions (id, env, tool, summary, rows_json, warnings_json, exposure_usd, status, created_at, expires_at, decided_at, result_json, error, order_id, position_id, instrument_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        a.id,
        a.env,
        a.tool,
        a.summary,
        JSON.stringify(a.rows),
        JSON.stringify(a.warnings),
        a.exposureUsd,
        a.status,
        a.createdAt,
        a.expiresAt,
        a.decidedAt ?? null,
        a.result === undefined ? null : JSON.stringify(a.result),
        a.error ?? null,
        a.orderId ?? null,
        a.positionId ?? null,
        a.instrumentId ?? null,
      );
  }

  updateAction(id: string, patch: Partial<Pick<ActionRecord, "status" | "decidedAt" | "result" | "error" | "orderId" | "positionId" | "instrumentId">>): void {
    const sets: string[] = [];
    const values: Array<string | number | null> = [];
    const set = (column: string, value: string | number | null) => {
      sets.push(`${column} = ?`);
      values.push(value);
    };
    if (patch.status !== undefined) set("status", patch.status);
    if (patch.decidedAt !== undefined) set("decided_at", patch.decidedAt);
    if (patch.result !== undefined) set("result_json", JSON.stringify(patch.result));
    if (patch.error !== undefined) set("error", patch.error);
    if (patch.orderId !== undefined) set("order_id", patch.orderId);
    if (patch.positionId !== undefined) set("position_id", patch.positionId);
    if (patch.instrumentId !== undefined) set("instrument_id", patch.instrumentId);
    if (sets.length === 0) return;
    this.db.prepare(`UPDATE actions SET ${sets.join(", ")} WHERE id = ?`).run(...values, id);
  }

  recordEvent(env: string, event: Record<string, unknown>): void {
    const { event: name, tool, actionId, ...detail } = event;
    this.db
      .prepare("INSERT INTO events (ts, env, event, tool, action_id, detail_json) VALUES (?, ?, ?, ?, ?, ?)")
      .run(this.now(), env, String(name ?? "unknown"), typeof tool === "string" ? tool : null, typeof actionId === "string" ? actionId : null, JSON.stringify(detail));
  }

  // ------------------------------------------------------- the daily ledger
  /** What has been executed (or is executing) today in `env`. */
  usage(env: EtoroEnv, at: number, timezone: string): Usage {
    const day = dayKey(at, timezone);
    const r = this.db.prepare("SELECT COALESCE(SUM(exposure_usd), 0) AS usd, COUNT(*) AS writes FROM ledger WHERE env = ? AND day = ?").get(env, day) as Row;
    return { day, usd: num(r.usd) ?? 0, writes: num(r.writes) ?? 0 };
  }

  /**
   * Checks the daily limits and, in the same transaction, counts this action against them. Throws PolicyError when it
   * would break a limit. The caller must `release` the reservation if the request then fails.
   */
  reserve(r: Reservation): Usage {
    return this.transaction(() => {
      const used = this.usage(r.env, r.now, r.timezone);
      if (used.writes + 1 > r.maxWrites) {
        throw new PolicyError(
          `Daily write limit reached for the ${r.env} account: ${used.writes} of ${r.maxWrites} writes executed on ${used.day} (${r.timezone}). ` +
            "The limit is ETORO_MAX_DAILY_WRITES; it counts every server process and resets at midnight in ETORO_TIMEZONE.",
        );
      }
      if (used.usd + r.exposureUsd > r.maxUsd) {
        throw new PolicyError(
          `Daily exposure limit reached for the ${r.env} account: $${used.usd.toFixed(2)} already executed on ${used.day} (${r.timezone}) + $${r.exposureUsd.toFixed(2)} ` +
            `would exceed ETORO_MAX_DAILY_USD ($${r.maxUsd}). It counts every server process and resets at midnight in ETORO_TIMEZONE.`,
        );
      }
      this.db.prepare("INSERT OR REPLACE INTO ledger (action_id, env, day, ts, exposure_usd) VALUES (?, ?, ?, ?, ?)").run(r.actionId, r.env, used.day, r.now, r.exposureUsd);
      return { day: used.day, usd: used.usd + r.exposureUsd, writes: used.writes + 1 };
    });
  }

  /** Gives back a reservation whose request failed. */
  release(actionId: string): void {
    this.db.prepare("DELETE FROM ledger WHERE action_id = ?").run(actionId);
  }

  // ------------------------------------------------------------------ reads
  private where(f: HistoryFilter): { sql: string; params: Array<string | number> } {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (f.env) {
      clauses.push("env = ?");
      params.push(f.env);
    }
    if (f.tool) {
      clauses.push("tool = ?");
      params.push(f.tool);
    }
    if (f.status) {
      clauses.push("status = ?");
      params.push(f.status);
    }
    if (f.from !== undefined) {
      clauses.push("created_at >= ?");
      params.push(f.from);
    }
    if (f.to !== undefined) {
      clauses.push("created_at < ?");
      params.push(f.to);
    }
    for (const word of (f.q ?? "").split(/\s+/).filter(Boolean).slice(0, 8)) {
      const like = likePattern(word);
      const ids = /^\d{1,15}$/.test(word) ? Number(word) : undefined;
      clauses.push(
        `(summary LIKE ? ESCAPE '\\' OR tool LIKE ? ESCAPE '\\' OR id LIKE ? ESCAPE '\\' OR error LIKE ? ESCAPE '\\'${ids !== undefined ? " OR order_id = ? OR position_id = ? OR instrument_id = ?" : ""})`,
      );
      params.push(like, like, like, like);
      if (ids !== undefined) params.push(ids, ids, ids);
    }
    return { sql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
  }

  search(f: HistoryFilter = {}): { total: number; rows: ActionSummary[] } {
    this.recoverStale();
    const { sql, params } = this.where(f);
    const total = num((this.db.prepare(`SELECT COUNT(*) AS n FROM actions ${sql}`).get(...params) as Row).n) ?? 0;
    const limit = Math.min(Math.max(Math.trunc(f.limit ?? 25), 1), 10_000);
    const offset = Math.max(Math.trunc(f.offset ?? 0), 0);
    const rows = this.db
      .prepare(
        `SELECT id, env, tool, summary, exposure_usd, status, created_at, expires_at, decided_at, error, order_id, position_id, instrument_id
         FROM actions ${sql} ORDER BY created_at DESC, id LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as Row[];
    return { total, rows: rows.map(toSummary) };
  }

  get(id: string): ActionRecord | undefined {
    this.recoverStale();
    const r = this.db.prepare("SELECT * FROM actions WHERE id = ?").get(id) as Row | undefined;
    if (!r) return undefined;
    return {
      ...toSummary(r),
      rows: parseJson<ProposalRow[]>(r.rows_json, []),
      warnings: parseJson<string[]>(r.warnings_json, []),
      ...(typeof r.result_json === "string" ? { result: parseJson<unknown>(r.result_json, null) } : {}),
    };
  }

  events(actionId: string): EventRecord[] {
    const rows = this.db.prepare("SELECT * FROM events WHERE action_id = ? ORDER BY id").all(actionId) as Row[];
    return rows.map((r) => ({
      id: num(r.id) ?? 0,
      ts: num(r.ts) ?? 0,
      env: String(r.env),
      event: String(r.event),
      ...(str(r.tool) !== undefined ? { tool: str(r.tool) } : {}),
      ...(str(r.action_id) !== undefined ? { actionId: str(r.action_id) } : {}),
      detail: parseJson<Record<string, unknown>>(r.detail_json, {}),
    }));
  }

  /** The tools that appear in the history, for the page's filter. */
  tools(): string[] {
    return (this.db.prepare("SELECT DISTINCT tool FROM actions ORDER BY tool").all() as Row[]).map((r) => String(r.tool));
  }
}
