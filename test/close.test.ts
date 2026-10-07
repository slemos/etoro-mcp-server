import { describe, expect, it } from "vitest";
import { estimateClose } from "../src/closeEstimate.js";
import { R } from "../src/endpoints.js";
import { type RecordedCall, baseCfg, connect, orderHandler, textOf } from "./helpers.js";

describe("estimateClose", () => {
  it("a long closes at the bid, a short at the ask", () => {
    expect(estimateClose({ isBuy: true, units: 2, openRate: 800, bid: 846.1, ask: 846.35, amount: 1600 })).toMatchObject({
      closeRate: 846.1,
      closeUnits: 2,
      fraction: 1,
      remainingUnits: 0,
    });
    const long = estimateClose({ isBuy: true, units: 2, openRate: 800, bid: 846.1, ask: 846.35, amount: 1600 })!;
    expect(long.pnl).toBeCloseTo(92.2, 6);
    expect(long.pnlPercent).toBeCloseTo(5.7625, 4);
    const short = estimateClose({ isBuy: false, units: 2, openRate: 900, bid: 846.1, ask: 846.35 })!;
    expect(short.closeRate).toBe(846.35);
    expect(short.pnl).toBeCloseTo(107.3, 6);
    expect(short.pnlPercent).toBeUndefined();
  });

  it("a partial close scales the result and says what stays open", () => {
    const e = estimateClose({ isBuy: true, units: 4, openRate: 100, closeUnits: 1, bid: 90, ask: 91, amount: 400 })!;
    expect(e).toMatchObject({ closeUnits: 1, fraction: 0.25, remainingUnits: 3 });
    expect(e.pnl).toBe(-10);
    expect(e.pnlPercent).toBeCloseTo(-10, 6);
  });

  it("gives no estimate from missing, non-positive or impossible numbers", () => {
    expect(estimateClose({ isBuy: true, units: 0, openRate: 1, bid: 1, ask: 1 })).toBeUndefined();
    expect(estimateClose({ isBuy: true, units: 1, openRate: Number.NaN, bid: 1, ask: 1 })).toBeUndefined();
    expect(estimateClose({ isBuy: true, units: 1, openRate: 1, bid: 0, ask: 1 })).toBeUndefined();
    expect(estimateClose({ isBuy: true, units: 1, openRate: 1, closeUnits: 2, bid: 1, ask: 1 })).toBeUndefined();
  });
});

const cfg = baseCfg({ enableWrite: true });
const position = { positionID: 777, instrumentID: 1234, isBuy: true, units: 2, openRate: 800, amount: 1600, leverage: 1, settlementTypeID: 0 };
const portfolio =
  (positions: unknown[] = [position]) =>
  (call: RecordedCall) =>
    call.path.endsWith("/portfolio") ? { json: { clientPortfolio: { positions } } } : undefined;

describe("etoro_prepare_close_position", () => {
  it("previews the instrument, direction, price and a rough result, and sends nothing", async () => {
    const ctx = await connect(cfg, orderHandler(portfolio()));
    const prep = await ctx.prepare("etoro_prepare_close_position", { positionId: 777 });
    expect(prep.summary).toContain("EXMPL.L");
    expect(prep.summary).toMatch(/est\. gain \$92\.20/);
    expect(prep.estimate).toMatchObject({ closeRate: 846.1, closeUnits: 2, remainingUnits: 0 });
    const page = await (await fetch(prep.approval.url!)).text();
    for (const text of ["Long (buy)", "CFD (a contract on the price)", "bid 846.1 / ask 846.35", "Estimated result", "before fees, overnight costs and currency conversion"]) {
      expect(page, text).toContain(text);
    }
    expect(ctx.calls.some((c) => c.method === "POST" && c.path.includes("market-close-orders"))).toBe(false);
    await ctx.close();
  });

  it("takes the instrument from the position and sends it, in the environment's spelling", async () => {
    const ctx = await connect(cfg, orderHandler((call) => (call.method === "POST" && call.path.includes("market-close-orders") ? { json: { orderForClose: { orderID: 5 }, token: "t" } } : portfolio()(call))));
    const prep = await ctx.prepare("etoro_prepare_close_position", { positionId: 777, unitsToDeduct: 0.5 });
    expect((prep.warnings as string[]).join(" ")).toContain("1.5 units stay open");
    await ctx.execute(prep);
    const sent = ctx.calls.find((c) => c.method === "POST" && c.path.includes("market-close-orders"))!;
    expect(sent.path).toBe("/api/v1/trading/execution/demo/market-close-orders/positions/777");
    expect(sent.body).toEqual({ InstrumentID: 1234, UnitsToDeduct: 0.5 });
    await ctx.close();
  });

  it("refuses a wrong instrument or more units than are open, before preparing anything", async () => {
    const ctx = await connect(cfg, orderHandler(portfolio()));
    const wrong = await ctx.client.callTool({ name: "etoro_prepare_close_position", arguments: { positionId: 777, instrumentId: 999 } });
    expect(wrong.isError).toBe(true);
    expect(textOf(wrong)).toContain("is on instrument 1234, not 999");
    const tooMany = await ctx.client.callTool({ name: "etoro_prepare_close_position", arguments: { positionId: 777, unitsToDeduct: 3 } });
    expect(tooMany.isError).toBe(true);
    expect(textOf(tooMany)).toContain("has 2 units open");
    expect(ctx.opened).toHaveLength(0);
    await ctx.close();
  });

  it("without the position it still previews when told the instrument, with a warning, and asks for it otherwise", async () => {
    const ctx = await connect(cfg, orderHandler(portfolio([])));
    const known = await ctx.prepare("etoro_prepare_close_position", { positionId: 555, instrumentId: 1234 });
    expect((known.warnings as string[]).join(" ")).toContain("was not found among the open positions");
    expect(known.estimate).toBeNull();
    const unknown = await ctx.client.callTool({ name: "etoro_prepare_close_position", arguments: { positionId: 555 } });
    expect(unknown.isError).toBe(true);
    expect(textOf(unknown)).toContain("Pass instrumentId");
    await ctx.close();
  });

  it("warns about positions that belong to a copy", async () => {
    const ctx = await connect(cfg, orderHandler(portfolio([{ ...position, mirrorID: 42 }])));
    const prep = await ctx.prepare("etoro_prepare_close_position", { positionId: 777 });
    expect((prep.warnings as string[]).join(" ")).toContain("copy trade (mirror 42)");
    await ctx.close();
  });
});

describe("etoro_prepare_cancel_close_order", () => {
  const lookup = (call: RecordedCall) => (call.path.endsWith("/orders:lookup") ? { json: { orderId: 9, status: { name: "WaitingForMarket" } } } : undefined);

  it("previews, then sends the documented DELETE to the close-order route only when the user executes", async () => {
    const ctx = await connect(cfg, orderHandler((call) => (call.method === "DELETE" ? { json: { token: "t-9" } } : lookup(call))));
    const prep = await ctx.prepare("etoro_prepare_cancel_close_order", { orderId: 9 });
    expect(prep.summary).toBe("CANCEL CLOSE order 9 | the position stays open | environment DEMO");
    expect(ctx.calls.some((c) => c.method === "DELETE")).toBe(false);
    expect(await (await fetch(prep.approval.url!)).text()).toContain("WaitingForMarket");
    await ctx.execute(prep);
    const sent = ctx.calls.find((c) => c.method === "DELETE")!;
    expect(sent.path).toBe("/api/v1/trading/execution/demo/market-close-orders/9");
    expect(await ctx.status(prep)).toMatchObject({ status: "executed", result: { token: "t-9" } });
    await ctx.close();
  });

  it("warns when the order is already filled or cancelled", async () => {
    const ctx = await connect(cfg, orderHandler((call) => (call.path.endsWith("/orders:lookup") ? { json: { status: { name: "Filled" } } } : undefined)));
    const prep = await ctx.prepare("etoro_prepare_cancel_close_order", { orderId: 9 });
    expect((prep.warnings as string[]).join(" ")).toContain("nothing left to cancel");
    await ctx.close();
  });

  it("has its own route for each environment, separate from cancelling a normal order", () => {
    expect(R.cancelCloseOrder("demo", 12)).toMatchObject({ kind: "write", method: "DELETE", path: "/api/v1/trading/execution/demo/market-close-orders/12" });
    expect(R.cancelCloseOrder("real", 12).path).toBe("/api/v1/trading/execution/market-close-orders/12");
    expect(R.cancelCloseOrder("real", 12).path).not.toBe(R.cancelOrder("real", 12).path);
  });
});
