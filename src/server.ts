import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type AuditFn, createAudit } from "./audit.js";
import { EtoroClient } from "./client.js";
import { type Config, transfersEnabled, writeEnabled } from "./config.js";
import { PendingStore } from "./safety.js";
import { type ToolContext } from "./tools/common.js";
import { registerReadTools } from "./tools/read.js";
import { registerWriteTools } from "./tools/write.js";
import { SERVER_NAME, VERSION } from "./version.js";

export interface ServerDeps {
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  audit?: AuditFn;
}

export function buildInstructions(cfg: Config): string {
  const write = writeEnabled(cfg)
    ? `Write tools are enabled (${cfg.env}). Opening, closing and cancelling orders is two steps: an etoro_prepare_* tool returns a preview and a confirmationId, and etoro_confirm_action executes it.`
    : "Write tools are disabled: this server is read-only.";
  return (
    `Tools for the eToro Public API, environment: ${cfg.env}. Read tools return eToro's JSON as is. ` +
    `${write} Use etoro_get_instruments to turn tickers into instrument ids.`
  );
}

export function createServer(cfg: Config, deps: ServerDeps = {}): { mcp: McpServer; ctx: ToolContext } {
  const audit = deps.audit ?? createAudit(cfg);
  const client = new EtoroClient(cfg, deps.fetchFn, deps.sleep);
  const pending = new PendingStore(cfg, deps.now);
  const mcp = new McpServer({ name: SERVER_NAME, version: VERSION }, { instructions: buildInstructions(cfg) });
  const ctx: ToolContext = { mcp, cfg, client, pending, audit };

  registerReadTools(ctx);
  if (writeEnabled(cfg)) registerWriteTools(ctx);
  return { mcp, ctx };
}

export function describeMode(cfg: Config): string {
  const mode = writeEnabled(cfg)
    ? `read+write${transfersEnabled(cfg) ? "+transfers" : ""}, caps ${cfg.maxOrderUsd}/order ${cfg.maxSessionUsd}/session`
    : "read-only";
  return `${SERVER_NAME} ${VERSION} | environment: ${cfg.env} | mode: ${mode}`;
}
