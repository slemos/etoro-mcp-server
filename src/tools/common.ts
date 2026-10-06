import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AuditFn } from "../audit.js";
import type { EtoroClient } from "../client.js";
import type { Config } from "../config.js";
import { EtoroApiError, InputError, PolicyError } from "../errors.js";
import type { PendingStore } from "../safety.js";

export interface ToolContext {
  mcp: McpServer;
  cfg: Config;
  client: EtoroClient;
  pending: PendingStore;
  audit: AuditFn;
}

const MAX_TEXT = 120_000;

/** Successful tool result: JSON text, truncated (with a note) if it is very large. */
export function ok(data: unknown, note?: string): CallToolResult {
  let text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  if (text.length > MAX_TEXT) {
    text = `${text.slice(0, MAX_TEXT)}\n... [truncated ${text.length - MAX_TEXT} characters; narrow the query]`;
  }
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
