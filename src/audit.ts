import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Config } from "./config.js";
import { redact } from "./redact.js";

export type AuditFn = (event: Record<string, unknown>) => void;

/**
 * JSON-lines audit trail of write activity: written to stderr (stdout is
 * reserved for the MCP protocol) and, optionally, appended to ETORO_AUDIT_LOG.
 * Keys are redacted from every line; callers never pass them anyway.
 */
export function createAudit(
  cfg: Config,
  sink: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): AuditFn {
  let dirReady = false;
  return (event) => {
    const line = redact(
      JSON.stringify({ ts: new Date().toISOString(), env: cfg.env, ...event }),
      [cfg.apiKey, cfg.userKey],
    );
    sink(`[audit] ${line}`);
    if (!cfg.auditLogPath) return;
    try {
      if (!dirReady) {
        mkdirSync(dirname(cfg.auditLogPath), { recursive: true });
        dirReady = true;
      }
      appendFileSync(cfg.auditLogPath, `${line}\n`, { mode: 0o600 });
    } catch {
      // A logging failure must never break (or silently skip) a tool call.
    }
  };
}
