import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EtoroClient } from "../src/client.js";
import { R } from "../src/endpoints.js";
import { PolicyError } from "../src/errors.js";
import { type OAuthEndpoints, OAuthError, OAuthHttp, buildAuthorizeUrl, createPkce } from "../src/auth/oauth.js";
import { OAuthAuth } from "../src/auth/oauthProvider.js";
import { TokenStore } from "../src/auth/store.js";
import { baseCfg, mockFetch } from "./helpers.js";

const ENDPOINTS: OAuthEndpoints = { authorize: "https://sso.example.test/sso", token: "https://sso.example.test/token", revoke: "https://sso.example.test/revoke" };
const CLIENT = { clientId: "client-id-1", clientSecret: "client-secret-value-1" };
const DAY = 86_400_000;

/** A fake sign-in service: hands out numbered tokens and rotates the refresh token like eToro does. */
function fakeSso(clock: { t: number }) {
  let n = 0;
  const valid = new Set<string>();
  const calls: { grant: string; auth: string; form: URLSearchParams }[] = [];
  const issue = () => {
    n++;
    valid.add(`refresh-${n}`);
    return { access_token: `access-${n}`, refresh_token: `refresh-${n}`, token_type: "Bearer", expires_in: 30 * 86400, refresh_token_expires_in: 30 * 86400, scope: "etoro-public:market-data:read etoro-public:trade.demo:read" };
  };
  const fn = (async (input: URL | string, init?: RequestInit) => {
    const url = input.toString();
    const form = new URLSearchParams(init?.body as URLSearchParams);
    const auth = (init?.headers as Record<string, string>).authorization ?? "";
    calls.push({ grant: form.get("grant_type") ?? url, auth, form });
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
    if (url === ENDPOINTS.token && form.get("grant_type") === "authorization_code") return form.get("code") === "good-code" ? json(200, issue()) : json(400, { error: "invalid_grant", error_description: "bad code" });
    if (url === ENDPOINTS.token && form.get("grant_type") === "refresh_token") {
      const rt = form.get("refresh_token") ?? "";
      if (!valid.has(rt)) return json(400, { error: "invalid_grant" });
      valid.delete(rt); // rotation: the old refresh token dies
      return json(200, issue());
    }
    if (url === ENDPOINTS.revoke) {
      valid.delete(form.get("token") ?? "");
      return json(200, {});
    }
    return json(404, {});
  }) as typeof fetch;
  return { fn, calls, valid, issued: () => n, clock };
}

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "etoro-oauth-test-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("PKCE and the authorization URL", () => {
  it("the challenge is the S256 hash of the verifier and every call is fresh", () => {
    const a = createPkce();
    expect(a.challenge).toBe(createHash("sha256").update(a.verifier).digest("base64url"));
    expect(a.verifier.length).toBeGreaterThanOrEqual(43);
    expect(createPkce().verifier).not.toBe(a.verifier);
  });

  it("builds the authorization URL with the code flow, S256 and the requested scopes", () => {
    const url = new URL(buildAuthorizeUrl(ENDPOINTS, CLIENT, { redirectUri: "http://localhost:53682/callback", scopes: ["a:b", "c:d"], state: "st", nonce: "no", challenge: "ch" }));
    expect(url.origin + url.pathname).toBe(ENDPOINTS.authorize);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: "client-id-1",
      redirect_uri: "http://localhost:53682/callback",
      scope: "a:b c:d",
      state: "st",
      nonce: "no",
      code_challenge: "ch",
      code_challenge_method: "S256",
    });
  });
});

describe("OAuthHttp", () => {
  it("exchanges a code, authenticating the client with HTTP Basic and sending the verifier", async () => {
    const clock = { t: 1_000_000 };
    const sso = fakeSso(clock);
    const http = new OAuthHttp(CLIENT, ENDPOINTS, sso.fn, () => clock.t);
    const t = await http.exchangeCode("good-code", "http://localhost:1/callback", "verifier-1");
    expect(t).toMatchObject({ accessToken: "access-1", refreshToken: "refresh-1", accessExpiresAt: clock.t + 30 * DAY, scopes: ["etoro-public:market-data:read", "etoro-public:trade.demo:read"] });
    const call = sso.calls[0]!;
    expect(call.auth).toBe(`Basic ${Buffer.from("client-id-1:client-secret-value-1").toString("base64")}`);
    expect(call.form.get("code_verifier")).toBe("verifier-1");
    expect(call.form.get("redirect_uri")).toBe("http://localhost:1/callback");
  });

  it("reports a refusal without echoing anything but the standard error fields", async () => {
    const sso = fakeSso({ t: 0 });
    const http = new OAuthHttp(CLIENT, ENDPOINTS, sso.fn);
    const err = await http.exchangeCode("wrong", "http://localhost:1/callback", "v").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OAuthError);
    expect((err as OAuthError).code).toBe("invalid_grant");
    expect((err as OAuthError).message).not.toContain("client-secret-value-1");
  });

  it("keeps the old refresh token when a renewal does not send a new one, and turns a network failure into an OAuthError", async () => {
    const http = new OAuthHttp(CLIENT, ENDPOINTS, (async () => new Response(JSON.stringify({ access_token: "a2", expires_in: 100 }), { status: 200 })) as typeof fetch, () => 0);
    const next = await http.refresh({ accessToken: "a1", refreshToken: "keep-me", accessExpiresAt: 0, scopes: ["s"] });
    expect(next).toMatchObject({ accessToken: "a2", refreshToken: "keep-me", scopes: ["s"] });
    const down = new OAuthHttp(CLIENT, ENDPOINTS, (async () => { throw new Error("connect ECONNREFUSED client-secret-value-1"); }) as typeof fetch);
    const err = await down.revoke("r").catch((e: unknown) => e);
    expect((err as OAuthError).code).toBe("network");
    expect((err as OAuthError).message).not.toContain("client-secret-value-1");
  });
});

describe("TokenStore", () => {
  it("keeps the tokens in a file only the user can read, per client id", () => {
    const path = join(tmp(), "nested", "oauth.sqlite");
    const store = new TokenStore(path);
    store.save("c1", { accessToken: "a", refreshToken: "r", accessExpiresAt: 5, scopes: ["x"] });
    expect(statSync(path).mode & 0o077).toBe(0);
    expect(store.load("c1")).toMatchObject({ accessToken: "a", refreshToken: "r", scopes: ["x"] });
    expect(store.load("another-client")).toBeUndefined();
    store.clear();
    expect(store.load()).toBeUndefined();
    store.close();
  });

  it("a lease excludes other owners until it expires, and its owner can renew it", () => {
    let t = 1000;
    const store = new TokenStore(":memory:", () => t);
    expect(store.tryAcquire("a", 100)).toBe(true);
    expect(store.tryAcquire("b", 100)).toBe(false);
    expect(store.tryAcquire("a", 100)).toBe(true);
    t += 101;
    expect(store.tryAcquire("b", 100)).toBe(true);
    store.release("b");
    expect(store.tryAcquire("a", 100)).toBe(true);
  });
});

describe("OAuthAuth", () => {
  async function setup() {
    const clock = { t: 10_000_000 };
    const sso = fakeSso(clock);
    const path = join(tmp(), "oauth.sqlite");
    const http = new OAuthHttp(CLIENT, ENDPOINTS, sso.fn, () => clock.t);
    const store = new TokenStore(path, () => clock.t);
    store.save(CLIENT.clientId, await http.exchangeCode("good-code", "http://localhost:1/callback", "v"));
    const make = () => new OAuthAuth(CLIENT.clientId, new TokenStore(path, () => clock.t), http, () => clock.t, async () => { clock.t += 250; });
    return { clock, sso, store, make, http };
  }

  it("sends the bearer token and nothing else, without renewing a fresh token", async () => {
    const { sso, make } = await setup();
    expect(await make().headers()).toEqual({ authorization: "Bearer access-1" });
    expect(sso.issued()).toBe(1);
  });

  it("is not signed in without tokens or for another client id", async () => {
    const { make, store } = await setup();
    store.clear();
    await expect(make().headers()).rejects.toBeInstanceOf(PolicyError);
    await expect(make().headers()).rejects.toThrow(/auth login/);
  });

  it("renews shortly before the token expires and stores the rotated refresh token", async () => {
    const { clock, sso, make, store } = await setup();
    clock.t += 30 * DAY - 30_000;
    expect(await make().headers()).toEqual({ authorization: "Bearer access-2" });
    expect(store.load()!.refreshToken).toBe("refresh-2");
    expect(sso.valid.has("refresh-1")).toBe(false);
  });

  it("two processes with an expiring token renew only once between them", async () => {
    const { clock, sso, make } = await setup();
    clock.t += 30 * DAY - 30_000;
    const [a, b] = [make(), make()];
    const heads = await Promise.all([a.headers(), b.headers(), a.headers()]);
    expect(heads.every((h) => h.authorization === "Bearer access-2")).toBe(true);
    expect(sso.issued()).toBe(2);
  });

  it("a process whose peer holds the lease waits and then uses the peer's tokens", async () => {
    const { clock, sso, make, store, http } = await setup();
    clock.t += 30 * DAY - 30_000;
    expect(store.tryAcquire("peer")).toBe(true);
    // While this process sleeps, the peer finishes its renewal.
    let slept = 0;
    const patched = new OAuthAuth(CLIENT.clientId, new TokenStore(store.path, () => clock.t), http, () => clock.t, async () => {
      clock.t += 250;
      if (++slept === 2) {
        store.save(CLIENT.clientId, await http.refresh(store.load()!));
        store.release("peer");
      }
    });
    expect(await patched.headers()).toEqual({ authorization: "Bearer access-2" });
    expect(sso.issued()).toBe(2);
  });

  it("after a 401 it replaces the token once", async () => {
    const { sso, make, store } = await setup();
    const auth = make();
    await auth.headers();
    expect(await auth.renew()).toBe(true);
    expect(store.load()!.accessToken).toBe("access-2");
    expect(sso.issued()).toBe(2);
  });

  it("after a 401 it does not renew again when another process already replaced the token", async () => {
    const { sso, make, store, http } = await setup();
    const auth = make();
    await auth.headers(); // hands out access-1
    store.save(CLIENT.clientId, await http.refresh(store.load()!)); // a peer renews: access-2
    const before = sso.issued();
    expect(await auth.renew()).toBe(true);
    expect(sso.issued()).toBe(before);
  });

  it("a revoked sign-in produces a clear instruction instead of a loop", async () => {
    const { clock, sso, make } = await setup();
    sso.valid.clear();
    clock.t += 30 * DAY;
    const auth = make();
    await expect(auth.headers()).rejects.toThrow(/auth login/);
    expect(await make().renew()).toBe(false);
  });

  it("works through the client: a 401 triggers one renewal and the request is repeated", async () => {
    const { clock, sso, make, store } = await setup();
    void clock;
    const { fn, calls } = mockFetch((call) => (call.headers.authorization === "Bearer access-2" ? { json: { gcid: 1 } } : { status: 401, json: { title: "Unauthorized" } }));
    const client = new EtoroClient(baseCfg(), fn, async () => {}, () => {}, make());
    expect(await client.call(R.me())).toEqual({ gcid: 1 });
    expect(calls.map((c) => c.headers.authorization)).toEqual(["Bearer access-1", "Bearer access-2"]);
    expect(calls.every((c) => c.headers["x-api-key"] === undefined)).toBe(true);
    expect(store.load()!.refreshToken).toBe("refresh-2");
    expect(sso.issued()).toBe(2);
  });

  it("scrubs the stored tokens from error messages", async () => {
    const { make } = await setup();
    const { fn } = mockFetch(() => ({ status: 500, json: { detail: "boom access-1 and refresh-1" } }));
    const auth = make();
    const client = new EtoroClient(baseCfg(), fn, async () => {}, () => {}, auth);
    const err = await client.call(R.me()).catch((e: unknown) => e);
    expect(String((err as Error).message)).not.toMatch(/access-1|refresh-1/);
  });
});
