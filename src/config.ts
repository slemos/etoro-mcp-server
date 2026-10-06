import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Configuration is read from environment variables only. API keys are never
 * accepted as tool arguments and never written to logs or tool results.
 */

export type EtoroEnv = "demo" | "real";

export interface Config {
  apiKey: string;
  userKey: string;
  /** Which eToro environment the key pair belongs to. Defaults to "demo". */
  env: EtoroEnv;
  baseUrl: string;
  /** Registers the write tools at all. Default: false. */
  enableWrite: boolean;
  /** Extra switch required to place write operations against the REAL environment. */
  allowRealWrite: boolean;
  /** Extra switch required to register the internal-transfer tool (real environment only). */
  allowTransfers: boolean;
  /** If true, writes are refused unless the MCP client can ask the human via elicitation. */
  requireElicitation: boolean;
  /** Max exposure (amount x leverage) of a single order, in USD. */
  maxOrderUsd: number;
  /** Max total exposure + transfers executed per server process, in USD. */
  maxSessionUsd: number;
  maxWritesPerMinute: number;
  confirmTtlMs: number;
  requestTimeoutMs: number;
  auditLogPath?: string;
}

export class ConfigError extends Error {
  override name = "ConfigError";
}

const DEFAULT_BASE_URL = "https://public-api.etoro.com";

/** Treat empty strings and unresolved `${...}` templates (unset MCPB options) as "not set". */
function clean(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === "" || /^\$\{[^}]*\}$/.test(trimmed)) return undefined;
  return trimmed;
}

function parseBool(name: string, raw: string | undefined, fallback: boolean): boolean {
  const value = clean(raw);
  if (value === undefined) return fallback;
  const lower = value.toLowerCase();
  if (["true", "1", "yes"].includes(lower)) return true;
  if (["false", "0", "no"].includes(lower)) return false;
  throw new ConfigError(`${name} must be "true" or "false".`);
}

function parseNumber(
  name: string,
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = clean(raw);
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new ConfigError(`${name} must be a number between ${min} and ${max}.`);
  }
  return n;
}

function parseBaseUrl(raw: string | undefined): string {
  const value = clean(raw);
  if (value === undefined) return DEFAULT_BASE_URL;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError("ETORO_BASE_URL is not a valid URL.");
  }
  // Defense in depth: keys are sent to this host, so it must stay an eToro host.
  if (url.protocol !== "https:" || !(url.hostname === "etoro.com" || url.hostname.endsWith(".etoro.com"))) {
    throw new ConfigError("ETORO_BASE_URL must be an https URL on an etoro.com host.");
  }
  return url.origin;
}

/** Node does not expand "~"; do it for the audit log path. */
function expandHome(path: string | undefined): string | undefined {
  if (path === undefined) return undefined;
  if (path === "~") return homedir();
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const apiKey = clean(env.ETORO_API_KEY);
  const userKey = clean(env.ETORO_USER_KEY);
  if (!apiKey || !userKey) {
    throw new ConfigError(
      "ETORO_API_KEY and ETORO_USER_KEY are required. Create a key pair in eToro: Settings > Trading > API Key Management.",
    );
  }

  const envName = (clean(env.ETORO_ENV) ?? "demo").toLowerCase();
  if (envName !== "demo" && envName !== "real") {
    throw new ConfigError('ETORO_ENV must be "demo" or "real".');
  }

  const etoroEnv: EtoroEnv = envName;
  return {
    apiKey,
    userKey,
    env: etoroEnv,
    baseUrl: parseBaseUrl(env.ETORO_BASE_URL),
    enableWrite: parseBool("ETORO_ENABLE_WRITE", env.ETORO_ENABLE_WRITE, false),
    allowRealWrite: parseBool("ETORO_ALLOW_REAL_WRITE", env.ETORO_ALLOW_REAL_WRITE, false),
    allowTransfers: parseBool("ETORO_ALLOW_TRANSFERS", env.ETORO_ALLOW_TRANSFERS, false),
    // Real money defaults to requiring a human in the loop; demo does not.
    requireElicitation: parseBool(
      "ETORO_REQUIRE_ELICITATION",
      env.ETORO_REQUIRE_ELICITATION,
      etoroEnv === "real",
    ),
    maxOrderUsd: parseNumber("ETORO_MAX_ORDER_USD", env.ETORO_MAX_ORDER_USD, 100, 1, 1_000_000),
    maxSessionUsd: parseNumber("ETORO_MAX_SESSION_USD", env.ETORO_MAX_SESSION_USD, 500, 1, 10_000_000),
    maxWritesPerMinute: parseNumber("ETORO_MAX_WRITES_PER_MINUTE", env.ETORO_MAX_WRITES_PER_MINUTE, 5, 1, 20),
    confirmTtlMs: parseNumber("ETORO_CONFIRM_TTL_SECONDS", env.ETORO_CONFIRM_TTL_SECONDS, 300, 30, 3600) * 1000,
    requestTimeoutMs: 30_000,
    auditLogPath: expandHome(clean(env.ETORO_AUDIT_LOG)),
  };
}

/** Write tools exist only when explicitly enabled; real-money writes need a second switch. */
export function writeEnabled(cfg: Config): boolean {
  return cfg.enableWrite && (cfg.env === "demo" || cfg.allowRealWrite);
}

export function transfersEnabled(cfg: Config): boolean {
  return writeEnabled(cfg) && cfg.env === "real" && cfg.allowTransfers;
}
