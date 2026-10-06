import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "./config.js";
import { PolicyError } from "./errors.js";

/** A write operation that has been previewed but not yet sent to eToro. */
export interface PreparedAction {
  id: string;
  tool: string;
  summary: string;
  /** Reused on every attempt so a retried confirmation is idempotent at eToro. */
  requestId: string;
  /** Money at risk or moved by this action, counted against the session cap. */
  exposureUsd: number;
  expiresAt: number;
  executed: boolean;
  result?: unknown;
  run: (requestId: string) => Promise<unknown>;
}

const MAX_PENDING = 20;

export class PendingStore {
  private readonly items = new Map<string, PreparedAction>();
  private executions: number[] = [];
  private spentUsd = 0;

  constructor(
    private readonly cfg: Config,
    private readonly now: () => number = Date.now,
  ) {}

  create(input: Pick<PreparedAction, "tool" | "summary" | "exposureUsd" | "run">): PreparedAction {
    this.purge();
    if (this.items.size >= MAX_PENDING) {
      throw new PolicyError("Too many unconfirmed previews. Confirm them or wait for them to expire.");
    }
    const action: PreparedAction = {
      ...input,
      id: randomUUID(),
      requestId: randomUUID(),
      expiresAt: this.now() + this.cfg.confirmTtlMs,
      executed: false,
    };
    this.items.set(action.id, action);
    return action;
  }

  get(id: string): PreparedAction | undefined {
    this.purge();
    return this.items.get(id);
  }

  /** Throws PolicyError if executing `action` now would break a rate or exposure limit. */
  assertWithinLimits(action: PreparedAction): void {
    const cutoff = this.now() - 60_000;
    this.executions = this.executions.filter((t) => t > cutoff);
    if (this.executions.length >= this.cfg.maxWritesPerMinute) {
      throw new PolicyError(
        `Write rate limit reached (${this.cfg.maxWritesPerMinute} per minute, ETORO_MAX_WRITES_PER_MINUTE). Wait a minute and confirm again.`,
      );
    }
    if (this.spentUsd + action.exposureUsd > this.cfg.maxSessionUsd) {
      throw new PolicyError(
        `Session exposure cap reached: $${this.spentUsd.toFixed(2)} already executed + $${action.exposureUsd.toFixed(2)} ` +
          `would exceed ETORO_MAX_SESSION_USD ($${this.cfg.maxSessionUsd}). Restart the server to reset the counter.`,
      );
    }
  }

  recordExecution(action: PreparedAction): void {
    this.executions.push(this.now());
    this.spentUsd += action.exposureUsd;
  }

  private purge(): void {
    const t = this.now();
    for (const [id, action] of this.items) {
      if (action.expiresAt <= t) this.items.delete(id);
    }
  }
}

export type Decision = "accepted" | "declined" | "unavailable";

/**
 * Ask the human directly through MCP elicitation. "declined" is final;
 * "unavailable" means the client cannot ask (callers decide via cfg.requireElicitation).
 */
export async function askHuman(mcp: McpServer, message: string): Promise<Decision> {
  const caps = mcp.server.getClientCapabilities();
  if (!caps?.elicitation) return "unavailable";
  try {
    const result = await mcp.server.elicitInput({
      mode: "form",
      message,
      requestedSchema: {
        type: "object",
        properties: {
          confirm: {
            type: "boolean",
            title: "Execute this action?",
            description: "Tick the box and submit to execute. Decline or cancel to abort.",
          },
        },
        required: ["confirm"],
      },
    });
    return result.action === "accept" && result.content?.confirm === true ? "accepted" : "declined";
  } catch {
    return "unavailable";
  }
}
