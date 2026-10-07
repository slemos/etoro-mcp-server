import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { defaultOpenUrl } from "./approval/opener.js";
import { ProposalStore } from "./approval/proposals.js";
import { TicketServer } from "./approval/server.js";
import { type AuditFn, createAudit } from "./audit.js";
import { EtoroClient } from "./client.js";
import { type Config, transfersEnabled, writeEnabled } from "./config.js";
import { KeyGuard } from "./environment.js";
import { type ToolContext, configureOutput, explain } from "./tools/common.js";
import { registerReadTools } from "./tools/read.js";
import { registerWriteTools } from "./tools/write.js";
import { SERVER_NAME, VERSION } from "./version.js";

export interface ServerDeps {
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  audit?: AuditFn;
  log?: (line: string) => void;
  /** Opens the approval page in a browser (tests replace it). */
  openUrl?: (url: string) => Promise<boolean>;
}

export function buildInstructions(cfg: Config): string {
  const write = writeEnabled(cfg)
    ? `Write tools are enabled (${cfg.env}), but they only PREPARE actions: each etoro_prepare_* tool returns a preview and opens an approval page in the user's browser. ` +
      "Only the user can execute the action, by pressing Execute on that page; you cannot execute anything. Use etoro_get_action_status to see the outcome."
    : "Write tools are disabled: this server is read-only.";
  return (
    `Tools for the eToro Public API, environment: ${cfg.env}. Read tools return eToro's JSON as is. ` +
    `${write} Use etoro_get_instruments to turn tickers into instrument ids.`
  );
}

export function createServer(cfg: Config, deps: ServerDeps = {}): { mcp: McpServer; ctx: ToolContext } {
  configureOutput({ maxChars: cfg.maxResponseChars });
  const audit = deps.audit ?? createAudit(cfg);
  const client = new EtoroClient(cfg, deps.fetchFn, deps.sleep, deps.log);
  const log = deps.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const store = new ProposalStore(cfg, deps.now, audit, explain);
  const tickets = new TicketServer(store, { now: deps.now, openUrl: deps.openUrl ?? defaultOpenUrl, log });
  const mcp = new McpServer({ name: SERVER_NAME, version: VERSION }, { instructions: buildInstructions(cfg) });
  const ctx: ToolContext = { mcp, cfg, client, store, tickets, audit, guard: new KeyGuard(client, cfg, deps.now) };

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
