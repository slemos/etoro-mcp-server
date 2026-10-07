import { describe, expect, it } from "vitest";
import { R } from "../src/endpoints.js";
import { PolicyError } from "../src/errors.js";
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
    expect(R.modifyPosition("demo", 7)).toMatchObject({ method: "PATCH", kind: "write", path: "/api/v2/trading/demo/positions/7" });
    expect(R.modifyPosition("real", 7)).toMatchObject({ method: "PATCH", kind: "write", path: "/api/v2/trading/positions/7" });
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
