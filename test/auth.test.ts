import { describe, expect, it } from "vitest";
import { type AuthProvider, KeysAuth, createAuthProvider } from "../src/auth/provider.js";
import { EtoroClient } from "../src/client.js";
import { R } from "../src/endpoints.js";
import { EtoroApiError } from "../src/errors.js";
import { API_KEY, USER_KEY, baseCfg, mockFetch } from "./helpers.js";

const noSleep = async () => {};

/** A provider whose token changes, like OAuth: the first token is rejected, a renewal yields the second. */
class ScriptedAuth implements AuthProvider {
  readonly mode = "keys" as const;
  token = "TOKEN_ONE_aaaaaaaa";
  renewals = 0;
  constructor(private readonly canRenew: boolean) {}
  async headers() {
    return { authorization: `Bearer ${this.token}` };
  }
  async renew() {
    if (!this.canRenew) return false;
    this.renewals++;
    this.token = "TOKEN_TWO_bbbbbbbb";
    return true;
  }
  secrets() {
    return [this.token];
  }
}

describe("auth providers", () => {
  it("fixed keys: send both headers and cannot be renewed", async () => {
    const auth = new KeysAuth("API_KEY_VALUE_1", "USER_KEY_VALUE_2");
    expect(await auth.headers()).toEqual({ "x-api-key": "API_KEY_VALUE_1", "x-user-key": "USER_KEY_VALUE_2" });
    expect(await auth.renew()).toBe(false);
    expect(auth.secrets()).toEqual(["API_KEY_VALUE_1", "USER_KEY_VALUE_2"]);
  });

  it("is built from the configured settings", async () => {
    const auth = createAuthProvider(baseCfg().auth);
    expect(await auth.headers()).toEqual({ "x-api-key": API_KEY, "x-user-key": USER_KEY });
  });
});

describe("EtoroClient with a renewable provider", () => {
  it("renews once after a 401 and sends the same request again with the same request id", async () => {
    const { fn, calls } = mockFetch((call) => (call.headers.authorization === "Bearer TOKEN_TWO_bbbbbbbb" ? { json: { ok: true } } : { status: 401, json: { title: "Unauthorized" } }));
    const auth = new ScriptedAuth(true);
    const client = new EtoroClient(baseCfg(), fn, noSleep, () => {}, auth);
    expect(await client.call(R.me())).toEqual({ ok: true });
    expect(calls.map((c) => c.headers.authorization)).toEqual(["Bearer TOKEN_ONE_aaaaaaaa", "Bearer TOKEN_TWO_bbbbbbbb"]);
    expect(calls[1]!.headers["x-request-id"]).toBe(calls[0]!.headers["x-request-id"]);
    expect(calls[1]!.headers["x-api-key"]).toBeUndefined();
    expect(auth.renewals).toBe(1);
  });

  it("does not loop: a second 401 after renewing is reported", async () => {
    const { fn, calls } = mockFetch(() => ({ status: 401, json: { title: "Unauthorized", detail: "token TOKEN_TWO_bbbbbbbb is no good" } }));
    const auth = new ScriptedAuth(true);
    const client = new EtoroClient(baseCfg(), fn, noSleep, () => {}, auth);
    const err = await client.call(R.me()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EtoroApiError);
    expect((err as EtoroApiError).message).not.toContain("TOKEN_TWO_bbbbbbbb");
    expect(calls).toHaveLength(2);
    expect(auth.renewals).toBe(1);
  });

  it("keys that cannot be renewed fail on the first 401", async () => {
    const { fn, calls } = mockFetch(() => ({ status: 401, json: { title: "Unauthorized" } }));
    const client = new EtoroClient(baseCfg(), fn, noSleep, () => {}, new ScriptedAuth(false));
    await expect(client.call(R.me())).rejects.toBeInstanceOf(EtoroApiError);
    expect(calls).toHaveLength(1);
  });
});
