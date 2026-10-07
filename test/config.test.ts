import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, type SecretIo, loadConfig, splitCommand, transfersEnabled, writeEnabled } from "../src/config.js";

const keys = { ETORO_API_KEY: "api-key-value-1", ETORO_USER_KEY: "user-key-value-2" };

describe("loadConfig", () => {
  it("defaults to demo, read-only", () => {
    const cfg = loadConfig(keys);
    expect(cfg.env).toBe("demo");
    expect(cfg.enableWrite).toBe(false);
    expect(writeEnabled(cfg)).toBe(false);
    expect(cfg.requireElicitation).toBe(false);
    expect(cfg.maxOrderUsd).toBe(100);
  });

  it("requires both keys and never echoes key values in errors", () => {
    expect(() => loadConfig({ ETORO_API_KEY: "only-one-key-123" })).toThrow(ConfigError);
    try {
      loadConfig({ ...keys, ETORO_ENV: "prod" });
    } catch (err) {
      expect((err as Error).message).not.toContain("api-key-value-1");
      expect((err as Error).message).not.toContain("user-key-value-2");
    }
  });

  it("reads the environment from ETORO_USE_REAL (the bundle's switch) and refuses contradictions", () => {
    expect(loadConfig({ ...keys, ETORO_USE_REAL: "true" }).env).toBe("real");
    expect(loadConfig({ ...keys, ETORO_USE_REAL: "false" }).env).toBe("demo");
    expect(loadConfig({ ...keys, ETORO_USE_REAL: "${user_config.use_real}" }).env).toBe("demo");
    expect(loadConfig({ ...keys, ETORO_ENV: "real", ETORO_USE_REAL: "true" }).env).toBe("real");
    expect(loadConfig({ ...keys, ETORO_ENV: "Demo ", ETORO_USE_REAL: "false" }).env).toBe("demo");
    expect(() => loadConfig({ ...keys, ETORO_ENV: "demo", ETORO_USE_REAL: "true" })).toThrow(/set only one/);
    expect(() => loadConfig({ ...keys, ETORO_ENV: "real", ETORO_USE_REAL: "false" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...keys, ETORO_USE_REAL: "maybe" })).toThrow(/ETORO_USE_REAL must be/);
    expect(() => loadConfig({ ...keys, ETORO_ENV: "prod", ETORO_USE_REAL: "true" })).toThrow(/ETORO_ENV must be/);
  });

  it("treats empty values and unresolved templates as unset", () => {
    const cfg = loadConfig({ ...keys, ETORO_ENV: "${user_config.env}", ETORO_ENABLE_WRITE: "", ETORO_MAX_ORDER_USD: "${user_config.max}" });
    expect(cfg.env).toBe("demo");
    expect(cfg.enableWrite).toBe(false);
    expect(cfg.maxOrderUsd).toBe(100);
  });

  it("real environment requires a second switch before writes exist", () => {
    const writeOnly = loadConfig({ ...keys, ETORO_ENV: "real", ETORO_ENABLE_WRITE: "true" });
    expect(writeEnabled(writeOnly)).toBe(false);
    const both = loadConfig({ ...keys, ETORO_ENV: "real", ETORO_ENABLE_WRITE: "true", ETORO_ALLOW_REAL_WRITE: "true" });
    expect(writeEnabled(both)).toBe(true);
    expect(both.requireElicitation).toBe(true);
    expect(transfersEnabled(both)).toBe(false);
    const withTransfers = loadConfig({
      ...keys,
      ETORO_ENV: "real",
      ETORO_ENABLE_WRITE: "true",
      ETORO_ALLOW_REAL_WRITE: "true",
      ETORO_ALLOW_TRANSFERS: "true",
    });
    expect(transfersEnabled(withTransfers)).toBe(true);
  });

  it("strict key scope defaults to on for real and off for demo, and can be overridden either way", () => {
    expect(loadConfig(keys).strictKeyScope).toBe(false);
    expect(loadConfig({ ...keys, ETORO_ENV: "real" }).strictKeyScope).toBe(true);
    expect(loadConfig({ ...keys, ETORO_STRICT_KEY_SCOPE: "true" }).strictKeyScope).toBe(true);
    expect(loadConfig({ ...keys, ETORO_ENV: "real", ETORO_STRICT_KEY_SCOPE: "false" }).strictKeyScope).toBe(false);
  });

  it("transfers are never available in demo", () => {
    const cfg = loadConfig({ ...keys, ETORO_ENABLE_WRITE: "true", ETORO_ALLOW_TRANSFERS: "true" });
    expect(transfersEnabled(cfg)).toBe(false);
  });

  it("only accepts https eToro hosts as base URL", () => {
    expect(() => loadConfig({ ...keys, ETORO_BASE_URL: "http://public-api.etoro.com" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...keys, ETORO_BASE_URL: "https://evil.example.com" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...keys, ETORO_BASE_URL: "https://etoro.com.evil.example" })).toThrow(ConfigError);
    expect(loadConfig({ ...keys, ETORO_BASE_URL: "https://public-api.etoro.com/" }).baseUrl).toBe("https://public-api.etoro.com");
  });

  it("expands ~ in the audit log path", () => {
    expect(loadConfig({ ...keys, ETORO_AUDIT_LOG: "~/.etoro-mcp/audit.log" }).auditLogPath).toBe(join(homedir(), ".etoro-mcp", "audit.log"));
    expect(loadConfig({ ...keys, ETORO_AUDIT_LOG: "/var/log/etoro.log" }).auditLogPath).toBe("/var/log/etoro.log");
    expect(loadConfig(keys).auditLogPath).toBeUndefined();
  });

  it("validates numeric limits", () => {
    expect(() => loadConfig({ ...keys, ETORO_MAX_ORDER_USD: "0" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...keys, ETORO_MAX_ORDER_USD: "abc" })).toThrow(ConfigError);
    expect(loadConfig({ ...keys, ETORO_MAX_ORDER_USD: "250" }).maxOrderUsd).toBe(250);
  });
});

describe("secret sources", () => {
  const io = (over: Partial<SecretIo> = {}): SecretIo & { runs: Array<[string, string[]]> } => {
    const runs: Array<[string, string[]]> = [];
    return {
      platform: "darwin",
      readFile: () => "file-secret-value\n",
      fileMode: () => 0o100600,
      run: (command, args) => {
        runs.push([command, args]);
        return { status: 0, stdout: "cmd-secret-value\n", stderr: "" };
      },
      ...over,
      runs,
    };
  };
  const other = { ETORO_USER_KEY: "user-key-value-2" };

  it("reads a key from a file with owner-only permissions and trims it", () => {
    const cfg = loadConfig({ ETORO_API_KEY_FILE: "/secure/api", ...other }, io());
    expect(cfg.apiKey).toBe("file-secret-value");
  });

  it("refuses a key file that other users can read", () => {
    const loose = io({ fileMode: () => 0o100644 });
    expect(() => loadConfig({ ETORO_API_KEY_FILE: "/loose/api", ...other }, loose)).toThrow(/chmod 600/);
    const group = io({ fileMode: () => 0o100640 });
    expect(() => loadConfig({ ETORO_API_KEY_FILE: "/loose/api", ...other }, group)).toThrow(ConfigError);
  });

  it("skips the permission check on Windows and reports unreadable files without details", () => {
    const win = io({ platform: "win32", fileMode: () => 0o100666 });
    expect(loadConfig({ ETORO_API_KEY_FILE: "C:/k/api", ...other }, win).apiKey).toBe("file-secret-value");
    const missing = io({ readFile: () => { throw new Error("ENOENT secret-path-detail"); } });
    expect(() => loadConfig({ ETORO_API_KEY_FILE: "/nope", ...other }, missing)).toThrow(/cannot read \/nope/);
  });

  it("runs a command without a shell and uses its output", () => {
    const fake = io();
    const cfg = loadConfig(
      { ETORO_API_KEY_CMD: 'security find-generic-password -s "etoro mcp" -a api-key -w', ...other },
      fake,
    );
    expect(cfg.apiKey).toBe("cmd-secret-value");
    expect(fake.runs[0]).toEqual(["security", ["find-generic-password", "-s", "etoro mcp", "-a", "api-key", "-w"]]);
  });

  it("does not interpret shell syntax in a command", () => {
    const fake = io();
    loadConfig({ ETORO_API_KEY_CMD: "pass show etoro; rm -rf ~ $(whoami)", ...other }, fake);
    expect(fake.runs[0]![0]).toBe("pass");
    expect(fake.runs[0]![1]).toEqual(["show", "etoro;", "rm", "-rf", "~", "$(whoami)"]);
  });

  it("reports a failing command without leaking anything but its first error line", () => {
    const failing = io({ run: () => ({ status: 44, stdout: "partial-secret-123", stderr: "item could not be found\nsecond line" }) });
    try {
      loadConfig({ ETORO_API_KEY_CMD: "security find-generic-password -w", ...other }, failing);
      expect.unreachable();
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain("exit 44");
      expect(message).toContain("item could not be found");
      expect(message).not.toContain("partial-secret-123");
      expect(message).not.toContain("second line");
    }
  });

  it("rejects multi-line or empty secrets from files and commands", () => {
    const multi = io({ run: () => ({ status: 0, stdout: "line1\nline2", stderr: "" }) });
    expect(() => loadConfig({ ETORO_API_KEY_CMD: "x", ...other }, multi)).toThrow(/single-line/);
    const empty = io({ run: () => ({ status: 0, stdout: "  \n", stderr: "" }) });
    expect(() => loadConfig({ ETORO_API_KEY_CMD: "x", ...other }, empty)).toThrow(/empty/);
  });

  it("refuses ambiguous configuration (more than one source for the same key)", () => {
    expect(() => loadConfig({ ETORO_API_KEY: "direct-value-1", ETORO_API_KEY_FILE: "/f", ...other }, io())).toThrow(/Set only one of ETORO_API_KEY, ETORO_API_KEY_FILE/);
  });

  it("can mix sources between the two keys, and plain variables still work", () => {
    const cfg = loadConfig({ ETORO_API_KEY_FILE: "/f", ETORO_USER_KEY_CMD: "op read op://v/e/user" }, io());
    expect(cfg.apiKey).toBe("file-secret-value");
    expect(cfg.userKey).toBe("cmd-secret-value");
    expect(loadConfig({ ETORO_API_KEY: "plain-api-1", ETORO_USER_KEY: "plain-user-2" }).apiKey).toBe("plain-api-1");
  });
});

describe("splitCommand", () => {
  it("splits on whitespace and honours quotes", () => {
    expect(splitCommand("a b  c")).toEqual(["a", "b", "c"]);
    expect(splitCommand(`op read "op://My Vault/eToro/api key"`)).toEqual(["op", "read", "op://My Vault/eToro/api key"]);
    expect(splitCommand("x ''")).toEqual(["x", ""]);
    expect(splitCommand("")).toEqual([]);
    expect(() => splitCommand('a "b')).toThrow(ConfigError);
  });
});
