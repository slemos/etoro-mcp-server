import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AuditFn } from "../audit.js";
import type { EtoroClient } from "../client.js";
import type { Config } from "../config.js";
import type { KeyGuard } from "../environment.js";
import { EtoroApiError, InputError, PolicyError } from "../errors.js";
import type { PendingStore } from "../safety.js";

export interface ToolContext {
  mcp: McpServer;
  cfg: Config;
  client: EtoroClient;
  pending: PendingStore;
  audit: AuditFn;
  guard: KeyGuard;
}

let maxChars = 120_000;

/** Sets the output size cap (called once at startup from ETORO_MAX_RESPONSE_CHARS). */
export function configureOutput(opts: { maxChars: number }): void {
  maxChars = opts.maxChars;
}

export interface Trim {
  path: string;
  kept: number;
  total: number;
}

function shrink(value: unknown, keep: number, trims: Trim[], path: string): unknown {
  if (Array.isArray(value)) {
    if (value.length > keep) trims.push({ path: path || "(root)", kept: keep, total: value.length });
    return value.slice(0, keep).map((item, i) => shrink(item, keep, trims, `${path}[${i}]`));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, shrink(v, keep, trims, path ? `${path}.${k}` : k)]),
    );
  }
  return value;
}

/**
 * Serializes a result. When it exceeds the size cap, arrays are shortened to their
 * first N items (largest N that fits) so the output stays valid JSON, and a
 * `_truncated` list reports every shortened array with its real length.
 */
export function render(data: unknown, limit: number = maxChars): { text: string; trimmed: Trim[] } {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  if (text.length <= limit || typeof data !== "object" || data === null) {
    if (text.length <= limit) return { text, trimmed: [] };
    return { text: `${text.slice(0, limit)}\n... [truncated ${text.length - limit} characters]`, trimmed: [] };
  }
  for (const keep of [200, 100, 50, 25, 10, 5, 3, 1, 0]) {
    const trims: Trim[] = [];
    const shrunk = shrink(data, keep, trims, "");
    const note = {
      note: `Arrays were shortened to their first ${keep} items to fit the ${limit}-character output limit. Narrow the query, or raise ETORO_MAX_RESPONSE_CHARS.`,
      arrays: trims,
    };
    const wrapped = Array.isArray(shrunk) ? { _truncated: note, items: shrunk } : { ...(shrunk as object), _truncated: note };
    const out = JSON.stringify(wrapped, null, 2);
    if (out.length <= limit) return { text: out, trimmed: trims };
  }
  return { text: `${text.slice(0, limit)}\n... [truncated ${text.length - limit} characters]`, trimmed: [] };
}

/** Successful tool result. */
export function ok(data: unknown, note?: string): CallToolResult {
  const { text } = render(data);
  return { content: [{ type: "text", text: note ? `${note}\n${text}` : text }] };
}

export function fail(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

/** Turns any thrown error into a recoverable MCP tool error (never a transport crash). */
export function explain(err: unknown): string {
  if (err instanceof EtoroApiError) {
    const hints: Record<number, string> = {
      400: "eToro rejected the request. Check the parameters (instrument id, amounts, leverage, stop loss).",
      401: "Authentication failed. Check that the keys are correct, not expired or IP-restricted, match ETORO_ENV, and have the permission this action needs (Read or Write).",
      403: "Forbidden. The key may lack the required permission (Read vs Write) or the action is not allowed for this account.",
      404: "Not found. Check the id and the environment (demo vs real).",
      409: "Duplicate request: eToro already processed this request id.",
    };
    let hint = hints[err.status] ?? "";
    if (err.status === 429) {
      hint = `Rate limited by eToro.${err.retryAfterSec ? ` Retry after ${err.retryAfterSec}s.` : ""}`;
    }
    return hint ? `${err.message}\nHint: ${hint}` : err.message;
  }
  if (err instanceof PolicyError || err instanceof InputError) return err.message;
  return `Unexpected error: ${err instanceof Error ? err.message : String(err)}`;
}

/** Wraps a handler so errors become tool errors. */
export function guarded<A>(fn: (args: A) => Promise<CallToolResult>): (args: A) => Promise<CallToolResult> {
  return async (args: A) => {
    try {
      return await fn(args);
    } catch (err) {
      return fail(explain(err));
    }
  };
}

export const READ = (title: string) => ({
  title,
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
});

export const WRITE = (title: string, opts: { destructive?: boolean; idempotent?: boolean } = {}) => ({
  title,
  readOnlyHint: false,
  destructiveHint: opts.destructive ?? true,
  idempotentHint: opts.idempotent ?? false,
  openWorldHint: true,
});

/** eToro list responses wrap arrays under varying keys; find the array defensively. */
export function extractList(response: unknown, keys: string[] = ["items", "instruments", "data", "results"]): unknown[] {
  if (Array.isArray(response)) return response;
  if (response && typeof response === "object") {
    const obj = response as Record<string, unknown>;
    for (const key of keys) {
      const value = obj[key];
      if (Array.isArray(value)) return value;
    }
  }
  return [];
}
