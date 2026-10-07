import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
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
  /** Refuse trading previews when the key can also write in the other environment. Default: true on real, false on demo. */
  strictKeyScope: boolean;
  /** Max characters of a tool result before arrays are shortened. */
  maxResponseChars: number;
  /** Log each HTTP call (method, path, status, duration) to stderr. Never logs headers, bodies or keys. */
  debug: boolean;
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

/** Everything that touches the outside world when resolving secrets (injectable for tests). */
export interface SecretIo {
  platform: NodeJS.Platform;
  readFile(path: string): string;
  fileMode(path: string): number;
  run(command: string, args: string[]): { status: number; stdout: string; stderr: string };
}

export const defaultSecretIo: SecretIo = {
  platform: process.platform,
  readFile: (path) => readFileSync(path, "utf8"),
  fileMode: (path) => statSync(path).mode,
  run: (command, args) => {
    // No shell: the command and its arguments are passed as an array.
    const r = spawnSync(command, args, { encoding: "utf8", timeout: 10_000, maxBuffer: 16_384, shell: false, windowsHide: true });
    if (r.error) return { status: -1, stdout: "", stderr: r.error.message };
    return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  },
};

/** Splits a command line into argv. Supports single and double quotes; performs no expansion and no shell parsing. */
export function splitCommand(input: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let started = false;
  for (const ch of input) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started || current) out.push(current);
      current = "";
      started = false;
    } else {
      current += ch;
      started = true;
    }
  }
  if (quote) throw new ConfigError("Unbalanced quote in a *_CMD value.");
  if (started || current) out.push(current);
  return out;
}

function checkSecret(name: string, value: string): string {
  const secret = value.trim();
  if (secret === "") throw new ConfigError(`${name} resolved to an empty value.`);
  if (/\s/.test(secret) || secret.length > 512) {
    throw new ConfigError(`${name} must be a single-line value of at most 512 characters.`);
  }
  return secret;
}

/**
 * A key can come from exactly one of: the variable itself, `<NAME>_FILE` (path to a file containing it,
 * which must not be readable by other users) or `<NAME>_CMD` (a command that prints it: OS keychain,
 * password manager CLI, ...). The last two keep the key out of config files and shell history.
 */
function resolveSecret(name: string, env: NodeJS.ProcessEnv, io: SecretIo): string | undefined {
  const direct = clean(env[name]);
  const file = clean(env[`${name}_FILE`]);
  const cmd = clean(env[`${name}_CMD`]);
  const used = [direct && name, file && `${name}_FILE`, cmd && `${name}_CMD`].filter(Boolean);
  if (used.length > 1) throw new ConfigError(`Set only one of ${used.join(", ")}.`);

  if (direct) return direct;

  if (file) {
    const path = expandHome(file) as string;
    let mode: number;
    let content: string;
    try {
      mode = io.fileMode(path);
      content = io.readFile(path);
    } catch {
      throw new ConfigError(`${name}_FILE: cannot read ${path}.`);
    }
    if (io.platform !== "win32" && (mode & 0o077) !== 0) {
      throw new ConfigError(`${name}_FILE (${path}) is accessible by other users. Restrict it first: chmod 600 "${path}"`);
    }
    return checkSecret(`${name}_FILE`, content);
  }

  if (cmd) {
    const argv = splitCommand(cmd);
    if (argv.length === 0) throw new ConfigError(`${name}_CMD is empty.`);
    const result = io.run(argv[0] as string, argv.slice(1));
    if (result.status !== 0) {
      const reason = result.stderr.trim().split("\n")[0]?.slice(0, 200);
      throw new ConfigError(`${name}_CMD failed (${argv[0]}, exit ${result.status})${reason ? `: ${reason}` : "."}`);
    }
    return checkSecret(`${name}_CMD`, result.stdout);
  }
  return undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, io: SecretIo = defaultSecretIo): Config {
  const apiKey = resolveSecret("ETORO_API_KEY", env, io);
  const userKey = resolveSecret("ETORO_USER_KEY", env, io);
  if (!apiKey || !userKey) {
    throw new ConfigError(
      "ETORO_API_KEY and ETORO_USER_KEY are required (or ETORO_API_KEY_FILE / ETORO_API_KEY_CMD and the USER_KEY equivalents). " +
        "Create a key pair in eToro: Settings > Trading > API Key Management.",
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
    // Real money defaults to strict (a real-money setup must use a single-environment key); demo does not.
    strictKeyScope: parseBool("ETORO_STRICT_KEY_SCOPE", env.ETORO_STRICT_KEY_SCOPE, etoroEnv === "real"),
    maxResponseChars: parseNumber("ETORO_MAX_RESPONSE_CHARS", env.ETORO_MAX_RESPONSE_CHARS, 120_000, 10_000, 5_000_000),
    debug: parseBool("ETORO_DEBUG", env.ETORO_DEBUG, false),
  };
}

/** Write tools exist only when explicitly enabled; real-money writes need a second switch. */
export function writeEnabled(cfg: Config): boolean {
  return cfg.enableWrite && (cfg.env === "demo" || cfg.allowRealWrite);
}

export function transfersEnabled(cfg: Config): boolean {
  return writeEnabled(cfg) && cfg.env === "real" && cfg.allowTransfers;
}
