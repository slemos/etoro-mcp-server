import { describe, expect, it } from "vitest";
import { R } from "../src/endpoints.js";
import { PolicyError } from "../src/errors.js";
import { PendingStore } from "../src/safety.js";
import { baseCfg } from "./helpers.js";

describe("endpoints", () => {
  it("uses the documented demo and real execution paths", () => {
    expect(R.createOrder("demo").path).toBe("/api/v2/trading/execution/demo/orders");
    expect(R.createOrder("real").path).toBe("/api/v2/trading/execution/orders");
    expect(R.cancelOrder("real", 42).path).toBe("/api/v2/trading/execution/orders/42");
    expect(R.cancelOrder("demo", 42).path).toBe("/api/v2/trading/execution/demo/orders/42");
    expect(R.closePosition("real", 7).path).toBe("/api/v1/trading/execution/market-close-orders/positions/7");
    expect(R.closePosition("demo", 7).path).toBe("/api/v1/trading/execution/demo/market-close-orders/positions/7");
    expect(R.costs("demo").path).toBe("/api/v2/trading/info/demo/costs");
  });

  it("classifies routes: POST what-if/eligibility are reads, execution routes are writes", () => {
    expect(R.costs("real").kind).toBe("read");
    expect(R.eligibility("real").kind).toBe("read");
    expect(R.createOrder("real").kind).toBe("write");
    expect(R.deleteWatchlist("abc").kind).toBe("write");
    expect(R.transfer().kind).toBe("write");
  });

  it("encodes path parameters", () => {
    expect(R.deleteWatchlist("a/b?c").path).toBe("/api/v1/watchlists/a%2Fb%3Fc");
  });
});

describe("PendingStore", () => {
  const input = (exposureUsd = 10) => ({ tool: "open_position", summary: "s", exposureUsd, run: async () => ({}) });

  it("expires previews", () => {
    let t = 1_000;
    const store = new PendingStore(baseCfg({ confirmTtlMs: 60_000 }), () => t);
    const action = store.create(input());
    expect(store.get(action.id)).toBeDefined();
    t += 60_001;
    expect(store.get(action.id)).toBeUndefined();
  });

  it("enforces the per-minute write limit and releases it after a minute", () => {
    let t = 1_000;
    const store = new PendingStore(baseCfg({ maxWritesPerMinute: 2 }), () => t);
    const a = store.create(input());
    store.recordExecution(a);
    store.recordExecution(a);
    expect(() => store.assertWithinLimits(a)).toThrow(PolicyError);
    t += 61_000;
    expect(() => store.assertWithinLimits(a)).not.toThrow();
  });

  it("enforces the session exposure cap", () => {
    const store = new PendingStore(baseCfg({ maxSessionUsd: 150 }));
    const a = store.create(input(100));
    store.assertWithinLimits(a);
    store.recordExecution(a);
    const b = store.create(input(100));
    expect(() => store.assertWithinLimits(b)).toThrow(/Session exposure cap/);
  });

  it("limits how many previews can be pending", () => {
    const store = new PendingStore(baseCfg());
    for (let i = 0; i < 20; i++) store.create(input());
    expect(() => store.create(input())).toThrow(PolicyError);
  });
});
