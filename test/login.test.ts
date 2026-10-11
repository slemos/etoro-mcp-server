import { request } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LoginError, startLogin } from "../src/auth/login.js";
import { OAuthHttp } from "../src/auth/oauth.js";
import { TokenStore } from "../src/auth/store.js";
import { runCli } from "../src/cli.js";
import type { OAuthSettings } from "../src/config.js";
import { CLIENT, ENDPOINTS, fakeSso } from "./fakeSso.js";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "etoro-login-test-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

let nextPort = 54100 + Math.floor(Math.random() * 400);
const settings = (over: Partial<OAuthSettings> = {}): OAuthSettings => ({
  mode: "oauth",
  clientId: CLIENT.clientId,
  clientSecret: CLIENT.clientSecret,
  scopes: ["etoro-public:market-data:read", "etoro-public:trade.demo:read"],
  callbackPort: nextPort++,
  tokenPath: join(tmp(), "oauth.sqlite"),
  ...over,
});

/** What a browser does after the user clicks "Authorize". */
const callback = (auth: OAuthSettings, query: string, host = `localhost:${auth.callbackPort}`) =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: auth.callbackPort, path: `/callback?${query}`, headers: { host } }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });

function setup(over: Partial<OAuthSettings> = {}) {
  const auth = settings(over);
  const clock = { t: 1_000_000 };
  const sso = fakeSso(clock);
  const http = new OAuthHttp(CLIENT, ENDPOINTS, sso.fn, () => clock.t);
  const store = new TokenStore(auth.tokenPath, () => clock.t);
  return { auth, sso, http, store, clock };
}

describe("startLogin", () => {
  it("opens the consent page, accepts the redirect and stores the tokens", async () => {
    const { auth, http, store } = setup();
    let consent = "";
    const handle = await startLogin(auth, { http, store, endpoints: ENDPOINTS, hosts: ["127.0.0.1"], openUrl: async (url) => ((consent = url), true) });
    expect(handle.opened).toBe(true);
    const u = new URL(consent);
    expect(u.searchParams.get("redirect_uri")).toBe(`http://localhost:${auth.callbackPort}/callback`);
    expect(u.searchParams.get("scope")).toBe(auth.scopes.join(" "));
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    const res = await callback(auth, `code=good-code&state=${u.searchParams.get("state")}`);
    expect(res.status).toBe(200);
    const { tokens, missingScopes } = await handle.done;
    expect(tokens.accessToken).toBe("access-1");
    expect(missingScopes).toEqual([]);
    expect(store.load(auth.clientId)?.refreshToken).toBe("refresh-1");
  });

  it("reports scopes eToro did not grant", async () => {
    const { auth, http, store } = setup({ scopes: ["etoro-public:market-data:read", "etoro-public:trade.demo:write"] });
    let consent = "";
    const handle = await startLogin(auth, { http, store, endpoints: ENDPOINTS, hosts: ["127.0.0.1"], openUrl: async (url) => ((consent = url), true) });
    await callback(auth, `code=good-code&state=${new URL(consent).searchParams.get("state")}`);
    expect((await handle.done).missingScopes).toEqual(["etoro-public:trade.demo:write"]);
  });

  it("ignores requests with the wrong state, the wrong Host or the wrong path, and keeps waiting", async () => {
    const { auth, http, store, sso } = setup();
    let consent = "";
    const handle = await startLogin(auth, { http, store, endpoints: ENDPOINTS, hosts: ["127.0.0.1"], openUrl: async (url) => ((consent = url), true) });
    const state = new URL(consent).searchParams.get("state");
    expect((await callback(auth, "code=good-code&state=forged")).status).toBe(400);
    expect((await callback(auth, "code=good-code")).status).toBe(400);
    expect((await callback(auth, "error=access_denied&state=forged")).status).toBe(400);
    expect((await callback(auth, `code=good-code&state=${state}`, "evil.example:80")).status).toBe(404);
    expect(sso.issued()).toBe(0);
    expect(store.load()).toBeUndefined();
    expect((await callback(auth, `code=good-code&state=${state}`)).status).toBe(200);
    await handle.done;
    expect(sso.issued()).toBe(1);
  });

  it("a refusal in the browser ends the flow with a message", async () => {
    const { auth, http, store } = setup();
    let consent = "";
    const handle = await startLogin(auth, { http, store, endpoints: ENDPOINTS, hosts: ["127.0.0.1"], openUrl: async (url) => ((consent = url), true) });
    await callback(auth, `error=access_denied&state=${new URL(consent).searchParams.get("state")}`);
    await expect(handle.done).rejects.toThrow(/did not authorise/);
    expect(store.load()).toBeUndefined();
  });

  it("a rejected code ends the flow without storing anything", async () => {
    const { auth, http, store } = setup();
    let consent = "";
    const handle = await startLogin(auth, { http, store, endpoints: ENDPOINTS, hosts: ["127.0.0.1"], openUrl: async (url) => ((consent = url), true) });
    await callback(auth, `code=wrong&state=${new URL(consent).searchParams.get("state")}`);
    await expect(handle.done).rejects.toThrow(/invalid_grant/);
    expect(store.load()).toBeUndefined();
  });

  it("times out, and can be cancelled, releasing the port", async () => {
    const { auth, http, store } = setup();
    const handle = await startLogin(auth, { http, store, endpoints: ENDPOINTS, hosts: ["127.0.0.1"], timeoutMs: 30, openUrl: async () => false });
    expect(handle.opened).toBe(false);
    await expect(handle.done).rejects.toThrow(/Timed out/);
    const again = await startLogin(auth, { http, store, endpoints: ENDPOINTS, hosts: ["127.0.0.1"], openUrl: async () => true });
    again.cancel();
    await expect(again.done).rejects.toBeInstanceOf(LoginError);
  });

  it("says so when the port is taken", async () => {
    const { auth, http, store } = setup();
    const blocker = createServer();
    await new Promise<void>((r) => blocker.listen(auth.callbackPort, "127.0.0.1", r));
    try {
      await expect(startLogin(auth, { http, store, endpoints: ENDPOINTS, hosts: ["127.0.0.1"], openUrl: async () => true })).rejects.toThrow(/in use/);
    } finally {
      blocker.close();
    }
  });
});

describe("auth command", () => {
  function io(over: Partial<Parameters<typeof runCli>[1]> = {}) {
    const out: string[] = [];
    const err: string[] = [];
    const auth = settings();
    const clock = { t: 1_000_000 };
    const sso = fakeSso(clock);
    const env = { ETORO_OAUTH_CLIENT_ID: CLIENT.clientId, ETORO_OAUTH_CLIENT_SECRET: CLIENT.clientSecret, ETORO_OAUTH_TOKEN_FILE: auth.tokenPath, ETORO_OAUTH_PORT: String(auth.callbackPort) };
    return { out, err, sso, auth, clock, base: { out: (l: string) => out.push(l), err: (l: string) => err.push(l), env, fetchFn: sso.fn, now: () => clock.t, openUrl: async () => true, ...over } };
  }

  it("shows the usage for no or an unknown command", async () => {
    const t = io();
    expect(await runCli([], t.base)).toBe(0);
    expect(await runCli(["fly"], t.base)).toBe(2);
    expect(t.err.join("\n")).toContain("Usage:");
  });

  it("asks for the client id and secret instead of failing obscurely", async () => {
    const t = io();
    expect(await runCli(["login"], { ...t.base, env: {} })).toBe(1);
    expect(t.err.join("\n")).toContain("ETORO_OAUTH_CLIENT_ID");
  });

  it("login, status and logout, end to end against the fake service", async () => {
    // The CLI talks to the real eToro endpoints; here its fetch is the fake, which answers by URL, so give it eToro's.
    const t = io();
    const realEndpoints = (await import("../src/auth/oauth.js")).ETORO_OAUTH;
    const fakeFn = (async (input: URL | string, init?: RequestInit) => {
      const url = input.toString().replace(realEndpoints.revoke, ENDPOINTS.revoke).replace(realEndpoints.token, ENDPOINTS.token);
      return t.sso.fn(url, init);
    }) as typeof fetch;
    let consent = "";
    const cli = { ...t.base, fetchFn: fakeFn, openUrl: async (url: string) => ((consent = url), true) };
    const running = runCli(["login"], cli);
    for (let i = 0; i < 50 && !consent; i++) await new Promise((r) => setTimeout(r, 20));
    expect(consent.startsWith("https://www.etoro.com/sso?")).toBe(true);
    await callback(t.auth, `code=good-code&state=${new URL(consent).searchParams.get("state")}`);
    expect(await running).toBe(0);
    expect(t.out.join("\n")).toContain("Signed in.");

    t.out.length = 0;
    expect(await runCli(["status"], cli)).toBe(0);
    expect(t.out.join("\n")).toMatch(/Signed in[\s\S]*Permissions: etoro-public:market-data:read/);
    expect(t.out.join("\n")).not.toMatch(/access-1|refresh-1/);

    t.out.length = 0;
    expect(await runCli(["logout"], cli)).toBe(0);
    expect(t.sso.valid.has("refresh-1")).toBe(false);
    expect(t.out.join("\n")).toContain("revoked");
    expect(await runCli(["status"], cli)).toBe(1);
    expect(await runCli(["logout"], cli)).toBe(0);
  });
});
