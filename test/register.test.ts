import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RegisterError, registerApplication } from "../src/auth/register.js";
import { runCli } from "../src/cli.js";
import { type Handler, mockFetch } from "./helpers.js";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "etoro-register-test-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const SECRET = "11111111-2222-3333-4444-555555555555";
const CLIENT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const catalog = { scopes: [{ scopeId: 230, scopeName: "etoro-public:market-data:read" }, { scopeId: 229, scopeName: "etoro-public:user-info:read" }, { scopeId: 213, scopeName: "etoro-public:trade.demo:read" }] };

const handler = (over: { scopes?: string[] } = {}): Handler => (call) => {
  if (call.path === "/api/v1/me") return { json: { gcid: 9000111, scopes: over.scopes ?? ["etoro-public:sso-applications:write"] } };
  if (call.path === "/api/v1/sso/scopes") return { json: catalog };
  if (call.method === "POST" && call.path === "/api/v1/sso/applications") return { status: 201, json: { application: { clientId: CLIENT_ID }, clientSecret: SECRET } };
  return undefined;
};

const input = (fetchFn: typeof fetch, secretFile: string) => ({
  apiKey: "TEMP_API_KEY_value1",
  userKey: "TEMP_USER_KEY_value2",
  name: "Test app",
  scopes: ["etoro-public:market-data:read", "etoro-public:trade.demo:read"],
  callbackPort: 53682,
  secretFile,
  fetchFn,
});

describe("registerApplication", () => {
  it("creates an application limited to the user's own account and keeps the secret in a private file", async () => {
    const { fn, calls } = mockFetch(handler());
    const file = join(tmp(), "sub", "secret");
    const r = await registerApplication(input(fn, file));
    expect(r).toMatchObject({ clientId: CLIENT_ID, redirectUri: "http://localhost:53682/callback" });
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.body).toMatchObject({
      applicationName: "Test app",
      scopes: [{ scopeId: 230, isMandatory: true }, { scopeId: 213, isMandatory: true }],
      redirectUris: ["http://localhost:53682/callback"],
      allowedGcids: [9000111],
    });
    expect(readFileSync(file, "utf8").trim()).toBe(SECRET);
    expect(statSync(file).mode & 0o077).toBe(0);
  });

  it("explains a key without the permission, an unknown scope and an existing secret file, before creating anything", async () => {
    const dir = tmp();
    const noPerm = mockFetch(handler({ scopes: ["etoro-public:market-data:read"] }));
    await expect(registerApplication(input(noPerm.fn, join(dir, "s1")))).rejects.toThrow(/sso-applications:write/);
    const ok = mockFetch(handler());
    await expect(registerApplication({ ...input(ok.fn, join(dir, "s2")), scopes: ["etoro-public:nope:read"] })).rejects.toThrow(/no scope called/);
    writeFileSync(join(dir, "s3"), "old");
    await expect(registerApplication(input(ok.fn, join(dir, "s3")))).rejects.toThrow(/already exists/);
    expect(readFileSync(join(dir, "s3"), "utf8")).toBe("old");
    for (const c of [...noPerm.calls, ...ok.calls]) expect(c.method).not.toBe("POST");
    await registerApplication({ ...input(ok.fn, join(dir, "s3")), overwrite: true });
    expect(readFileSync(join(dir, "s3"), "utf8").trim()).toBe(SECRET);
  });

  it("reports eToro's refusal without leaking the keys", async () => {
    const { fn } = mockFetch(() => ({ status: 403, json: { title: "Forbidden" } }));
    const err = await registerApplication(input(fn, join(tmp(), "s"))).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RegisterError);
    expect((err as Error).message).toContain("403");
    expect((err as Error).message).not.toContain("TEMP_API_KEY_value1");
  });
});

describe("auth register", () => {
  it("never prints the secret, and tells how to configure the server", async () => {
    const { fn } = mockFetch(handler());
    const file = join(tmp(), "secret");
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(["register", "--secret-file", file, "--name", "Mine"], {
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      env: { ETORO_API_KEY: "TEMP_API_KEY_value1", ETORO_USER_KEY: "TEMP_USER_KEY_value2", ETORO_ENV: "demo" },
      fetchFn: fn,
      openUrl: async () => true,
    });
    expect(err).toEqual([]);
    expect(code).toBe(0);
    const text = out.join("\n");
    expect(text).toContain(`ETORO_OAUTH_CLIENT_ID=${CLIENT_ID}`);
    expect(text).toContain(`ETORO_OAUTH_CLIENT_SECRET_FILE=${file}`);
    expect(text).not.toContain(SECRET);
    expect(text).toContain("etoro-public:trade.demo:read");
    expect(text).not.toContain("trade.demo:write");
  });

  it("asks for the temporary keys when there are none", async () => {
    const err: string[] = [];
    const code = await runCli(["register"], { out: () => {}, err: (l) => err.push(l), env: {}, openUrl: async () => true });
    expect(code).toBe(1);
    expect(err.join(" ")).toContain("ETORO_API_KEY");
  });
});
