import { describe, expect, it } from "vitest";
import { EtoroClient } from "../src/client.js";
import { R } from "../src/endpoints.js";
import { EtoroApiError, PolicyError } from "../src/errors.js";
import { API_KEY, USER_KEY, baseCfg, mockFetch } from "./helpers.js";

const noSleep = async () => {};

describe("EtoroClient", () => {
  it("sends the auth headers, a UUID request id and comma-joined arrays", async () => {
    const { fn, calls } = mockFetch(() => ({ json: { rates: [] } }));
    const client = new EtoroClient(baseCfg(), fn, noSleep);
    await client.call(R.rates(), { query: { instrumentIds: [1, 2, 3], skipped: undefined } });
    const call = calls[0]!;
    expect(call.method).toBe("GET");
    expect(call.path).toBe("/api/v1/market-data/instruments/rates");
    expect(call.query).toEqual({ instrumentIds: "1,2,3" });
    expect(call.headers["x-api-key"]).toBe(API_KEY);
    expect(call.headers["x-user-key"]).toBe(USER_KEY);
    expect(call.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("blocks write routes (before any network call) when writes are disabled", async () => {
    const { fn, calls } = mockFetch(() => ({ json: {} }));
    const client = new EtoroClient(baseCfg(), fn, noSleep);
    await expect(client.call(R.createOrder("demo"), { body: {} })).rejects.toBeInstanceOf(PolicyError);
    await expect(client.call(R.cancelOrder("demo", 1))).rejects.toBeInstanceOf(PolicyError);
    expect(calls).toHaveLength(0);
  });

  it("blocks real writes without the second switch, allows demo writes", async () => {
    const { fn, calls } = mockFetch(() => ({ json: {} }));
    const real = new EtoroClient(baseCfg({ env: "real", enableWrite: true }), fn, noSleep);
    await expect(real.call(R.createOrder("real"), { body: {} })).rejects.toBeInstanceOf(PolicyError);
    const demo = new EtoroClient(baseCfg({ env: "demo", enableWrite: true }), fn, noSleep);
    await demo.call(R.createOrder("demo"), { body: {} });
    expect(calls).toHaveLength(1);
  });

  it("blocks transfers unless explicitly allowed on real", async () => {
    const { fn, calls } = mockFetch(() => ({ json: { transferId: 1 } }));
    const client = new EtoroClient(baseCfg({ env: "real", enableWrite: true, allowRealWrite: true }), fn, noSleep);
    await expect(client.call(R.transfer(), { body: {} })).rejects.toBeInstanceOf(PolicyError);
    const allowed = new EtoroClient(
      baseCfg({ env: "real", enableWrite: true, allowRealWrite: true, allowTransfers: true }),
      fn,
      noSleep,
    );
    await allowed.call(R.transfer(), { body: {} });
    expect(calls).toHaveLength(1);
  });

  it("refuses identifiers that URL normalisation would turn into another route", async () => {
    const { fn, calls } = mockFetch(() => ({ json: {} }));
    const client = new EtoroClient(baseCfg({ enableWrite: true }), fn, noSleep);
    for (const watchlistId of ["..", ".", "%2e%2e"]) {
      const safe = watchlistId === "%2e%2e";
      const attempt = client.call(R.deleteWatchlist(watchlistId));
      if (safe) await attempt;
      else await expect(attempt).rejects.toBeInstanceOf(PolicyError);
    }
    // "%2e%2e" is encoded again ("%252e%252e"), so it stays one literal segment; "a/b" and "../x" are encoded too.
    await client.call(R.addWatchlistItems("a/b"), { body: [] });
    await client.call(R.addWatchlistItems("../x"), { body: [] });
    expect(calls.map((c) => c.path)).toEqual([
      "/api/v1/watchlists/%252e%252e",
      "/api/v1/watchlists/a%2Fb/items",
      "/api/v1/watchlists/..%2Fx/items",
    ]);
  });

  it("refuses paths outside /api/ and inconsistent method/kind routes", async () => {
    const { fn } = mockFetch(() => ({ json: {} }));
    const client = new EtoroClient(baseCfg({ enableWrite: true }), fn, noSleep);
    await expect(client.call({ id: "x", kind: "read", method: "GET", path: "/admin/secrets" })).rejects.toBeInstanceOf(PolicyError);
    await expect(client.call({ id: "x", kind: "write", method: "GET", path: "/api/v1/x" })).rejects.toBeInstanceOf(PolicyError);
    await expect(client.call({ id: "x", kind: "read", method: "DELETE", path: "/api/v1/x" })).rejects.toBeInstanceOf(PolicyError);
  });

  it("retries on 429 reusing the same request id", async () => {
    let n = 0;
    const { fn, calls } = mockFetch(() => (++n === 1 ? { status: 429, headers: { "retry-after": "1" } } : { json: { ok: true } }));
    const client = new EtoroClient(baseCfg({ enableWrite: true }), fn, noSleep);
    const result = await client.call(R.createOrder("demo"), { body: {}, requestId: "11111111-1111-4111-8111-111111111111" });
    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.headers["x-request-id"]).toBe("11111111-1111-4111-8111-111111111111");
  });

  it("gives up after repeated 429s and surfaces retry-after", async () => {
    const { fn } = mockFetch(() => ({ status: 429, headers: { "retry-after": "7" }, json: { title: "Too many" } }));
    const client = new EtoroClient(baseCfg(), fn, noSleep);
    await expect(client.call(R.balances())).rejects.toMatchObject({ status: 429, retryAfterSec: 7 });
  });

  it("never leaks keys in error messages, even if the server echoes them", async () => {
    const { fn } = mockFetch(() => ({ status: 401, json: { title: "Unauthorized", detail: `bad key ${API_KEY} / ${USER_KEY}` } }));
    const client = new EtoroClient(baseCfg(), fn, noSleep);
    const err = await client.call(R.balances()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EtoroApiError);
    const message = (err as Error).message;
    expect(message).not.toContain(API_KEY);
    expect(message).not.toContain(USER_KEY);
    expect(message).toContain("[REDACTED]");
  });

  it("redacts keys from network errors too", async () => {
    const fn = (async () => {
      throw new Error(`connect failed for ${API_KEY}`);
    }) as unknown as typeof fetch;
    const client = new EtoroClient(baseCfg(), fn, noSleep);
    const err = (await client.call(R.balances()).catch((e: unknown) => e)) as Error;
    expect(err.message).not.toContain(API_KEY);
  });

  it("debug logging records method, path, status and query keys but never keys, headers or bodies", async () => {
    const lines: string[] = [];
    const { fn } = mockFetch(() => ({ json: { secretBalance: 12345 } }));
    const client = new EtoroClient(baseCfg({ debug: true }), fn, noSleep, (l) => lines.push(l));
    await client.call(R.rates(), { query: { instrumentIds: [1, 2] } });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/\[http\] GET \/api\/v1\/market-data\/instruments\/rates \(query: instrumentIds\) -> 200 in \d+ms/);
    for (const secret of [API_KEY, USER_KEY, "12345", "1,2"]) expect(lines[0]).not.toContain(secret);
  });

  it("is silent by default", async () => {
    const lines: string[] = [];
    const { fn } = mockFetch(() => ({ json: {} }));
    await new EtoroClient(baseCfg(), fn, noSleep, (l) => lines.push(l)).call(R.balances());
    expect(lines).toHaveLength(0);
  });
});
