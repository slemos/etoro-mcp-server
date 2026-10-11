import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OAuthHttp, ETORO_OAUTH } from "../src/auth/oauth.js";
import { TokenStore } from "../src/auth/store.js";
import type { Config } from "../src/config.js";
import { createServer } from "../src/server.js";
import { CLIENT, ENDPOINTS, asEtoroSso, fakeSso } from "./fakeSso.js";
import { type Handler, ME, baseCfg, mockFetch, textOf } from "./helpers.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

let nextPort = 54600 + Math.floor(Math.random() * 300);

async function start(over: Partial<Config> = {}, handler: Handler = (c) => (c.path === "/api/v1/me" ? { json: { ...ME, scopes: ["etoro-public:market-data:read", "etoro-public:trade.demo:read"] } } : undefined)) {
  const dir = mkdtempSync(join(tmpdir(), "etoro-oauth-server-"));
  dirs.push(dir);
  const tokenPath = join(dir, "oauth.sqlite");
  const callbackPort = nextPort++;
  const cfg = baseCfg({
    auth: { mode: "oauth", clientId: CLIENT.clientId, clientSecret: CLIENT.clientSecret, scopes: ["etoro-public:market-data:read", "etoro-public:trade.demo:read"], callbackPort, tokenPath },
    ...over,
  });
  const clock = { t: Date.now() };
  const sso = fakeSso(clock);
  const api = mockFetch(handler);
  const ssoHost = new URL(ENDPOINTS.token).host;
  const fetchFn = asEtoroSso(((input: URL | string, init?: RequestInit) => (new URL(input.toString()).host === ssoHost ? sso.fn(input, init) : api.fn(input, init))) as typeof fetch);
  const opened: string[] = [];
  const { mcp, ctx } = createServer(cfg, { fetchFn, sleep: async () => {}, log: () => {}, audit: () => {}, openUrl: async (u) => (opened.push(u), true) });
  const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), mcp.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
  const seed = async () => {
    const store = new TokenStore(tokenPath);
    store.save(CLIENT.clientId, await new OAuthHttp(CLIENT, ETORO_OAUTH, fetchFn).exchangeCode("good-code", "http://localhost:1/callback", "v"));
    store.close();
  };
  return { cfg, client, call, api, sso, opened, seed, callbackPort, tokenPath, close: async () => { await client.close(); await ctx.tickets.close(); } };
}

const browserCallback = (port: number, query: string) =>
  new Promise<number>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: `/callback?${query}`, headers: { host: `localhost:${port}` } }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
    req.end();
  });

describe("server with OAuth sign-in", () => {
  it("has the sign-in tools only in OAuth mode", async () => {
    const t = await start();
    const names = (await t.client.listTools()).tools.map((x) => x.name);
    expect(names).toContain("etoro_sign_in");
    expect(names).toContain("etoro_sign_out");
    await t.close();

    const { mcp, ctx } = createServer(baseCfg(), { fetchFn: mockFetch(() => undefined).fn, log: () => {}, audit: () => {} });
    const keys = new Client({ name: "t", version: "0" }, { capabilities: {} });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([keys.connect(a), mcp.connect(b)]);
    expect((await keys.listTools()).tools.map((x) => x.name)).not.toContain("etoro_sign_in");
    await keys.close();
    await ctx.tickets.close();
  });

  it("tells the model to sign in when there is no sign-in yet", async () => {
    const t = await start();
    const res = await t.call("etoro_get_portfolio");
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("Not signed in");
    const check = JSON.parse(textOf(await t.call("etoro_check_connection")));
    expect(check.authentication).toMatchObject({ method: "oauth", signedIn: false });
    expect(check.authentication.next).toContain("etoro_sign_in");
    expect(t.api.calls).toHaveLength(0);
    await t.close();
  });

  it("sends the bearer token, never API keys, and reports the sign-in", async () => {
    const t = await start();
    await t.seed();
    const check = JSON.parse(textOf(await t.call("etoro_check_connection")));
    expect(check.connected).toBe(true);
    expect(check.authentication).toMatchObject({ method: "oauth", signedIn: true, missingScopes: [] });
    expect(check.advice.join(" ")).not.toContain("Restrict the key by IP");
    expect(t.api.calls.length).toBeGreaterThan(0);
    for (const c of t.api.calls) {
      expect(c.headers.authorization).toBe("Bearer access-1");
      expect(c.headers["x-api-key"]).toBeUndefined();
      expect(c.headers["x-user-key"]).toBeUndefined();
    }
    await t.close();
  });

  it("renews the token when eToro answers 401, and carries on", async () => {
    let rejected = false;
    const t = await start({}, (c) => {
      if (c.path !== "/api/v1/me") return undefined;
      if (c.headers.authorization === "Bearer access-1") return (rejected = true), { status: 401, json: { title: "Unauthorized" } };
      return { json: { ...ME, scopes: ["etoro-public:trade.demo:read"] } };
    });
    await t.seed();
    const check = JSON.parse(textOf(await t.call("etoro_check_connection")));
    expect(rejected).toBe(true);
    expect(check.connected).toBe(true);
    expect(t.sso.issued()).toBe(2);
    await t.close();
  });

  it("etoro_sign_in opens eToro's page, the browser redirect completes it, and a second call does nothing", async () => {
    const t = await start();
    const started = JSON.parse(textOf(await t.call("etoro_sign_in")));
    expect(started).toMatchObject({ started: true, browserOpened: true });
    expect(started.requestedScopes).toEqual(["etoro-public:market-data:read", "etoro-public:trade.demo:read"]);
    expect(started.openThisAddress).toBeTruthy(); // baseCfg shows approval URLs
    expect(t.opened).toHaveLength(1);
    expect(t.opened[0]!.startsWith("https://www.etoro.com/sso?")).toBe(true);
    const state = new URL(t.opened[0]!).searchParams.get("state");
    expect(await browserCallback(t.callbackPort, `code=good-code&state=${state}`)).toBe(200);
    for (let i = 0; i < 50; i++) {
      const check = JSON.parse(textOf(await t.call("etoro_check_connection")));
      if (check.authentication.signedIn) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const again = JSON.parse(textOf(await t.call("etoro_sign_in")));
    expect(again).toMatchObject({ signedIn: true, started: false });
    expect(t.opened).toHaveLength(1);
    await t.close();
  });

  it("etoro_sign_in does not print the address when a browser opened and URLs are hidden", async () => {
    const t = await start({ showApprovalUrl: false });
    const started = JSON.parse(textOf(await t.call("etoro_sign_in")));
    expect(started).not.toHaveProperty("openThisAddress");
    await t.call("etoro_sign_out"); // cancels the pending flow and frees the port
    await t.close();
  });

  it("etoro_sign_out revokes at eToro and later calls ask to sign in again", async () => {
    const t = await start();
    await t.seed();
    const out = JSON.parse(textOf(await t.call("etoro_sign_out")));
    expect(out).toEqual({ signedIn: false, revokedAtEtoro: true });
    expect(t.sso.valid.has("refresh-1")).toBe(false);
    expect(textOf(await t.call("etoro_get_portfolio"))).toContain("Not signed in");
    expect(JSON.parse(textOf(await t.call("etoro_sign_out")))).toMatchObject({ signedIn: false });
    await t.close();
  });
});
