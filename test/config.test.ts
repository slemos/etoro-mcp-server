import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, transfersEnabled, writeEnabled } from "../src/config.js";

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
