import { describe, expect, it } from "vitest";
import { InputError } from "../src/errors.js";
import { compactPortfolio, projectPosition } from "../src/portfolio.js";
import { type RecordedCall, baseCfg, connect, orderHandler, textOf } from "./helpers.js";

/** Mirrors the shape of a real clientPortfolio (field names from value-masked responses). */
const rawPosition = (id: number, extra: Record<string, unknown> = {}) => ({
  positionID: id,
  CID: 111,
  openDateTime: "2026-01-02T03:04:05",
  openRate: 100 + id,
  instrumentID: 1234,
  isBuy: true,
  takeProfitRate: 999999,
  stopLossRate: 0.0001,
  mirrorID: 0,
  parentPositionID: 0,
  amount: 50,
  leverage: 1,
  orderID: 5,
  orderType: 17,
  units: 0.5,
  totalFees: 0.1,
  initialAmountInDollars: 50,
  isTslEnabled: false,
  stopLossVersion: 1,
  isSettled: false,
  redeemStatusID: 0,
  initialUnits: 0.5,
  settlementTypeID: 1,
  openConversionRate: 1,
  pnlVersion: 1,
  isNoTakeProfit: true,
  isNoStopLoss: true,
  lotCount: 1,
  unrealizedPnL: { pnL: 2.5, exposureInAccountCurrency: 52.5, marginInAccountCurrency: 50, closeRate: 105, closeConversionRate: 1, timestamp: "2026-10-06T00:00:00Z" },
  ...extra,
});

const portfolio = (mirrorPositions: number) => ({
  clientPortfolio: {
    positions: [rawPosition(1)],
    unrealizedPnL: 2.5,
    mirrors: [
      {
        mirrorID: 77,
        parentUsername: "trader",
        initialInvestment: 1000,
        availableAmount: 200,
        closedPositionsNetProfit: 12,
        mirrorStatusID: 0,
        positions: Array.from({ length: mirrorPositions }, (_, i) => rawPosition(1000 + i, { mirrorID: 77 })),
        entryOrders: [],
        ordersForOpen: [{ orderID: 9 }],
      },
    ],
    credit: 3000,
    bonusCredit: 0,
    orders: [],
    ordersForOpen: [],
  },
});

const opts = { view: "summary" as const, limit: 50, offset: 0, withPnl: false };

describe("compactPortfolio", () => {
  it("keeps the useful position fields and drops the rest", () => {
    const p = projectPosition(rawPosition(1), false);
    expect(Object.keys(p)).toContain("settlementTypeID");
    expect(p.settlement).toBe("real");
    expect(p).not.toHaveProperty("CID");
    expect(p).not.toHaveProperty("pnlVersion");
    expect(p).not.toHaveProperty("unrealizedPnL");
  });

  it("labels the settlement type, and leaves unknown ids unlabelled", () => {
    expect(projectPosition(rawPosition(1, { settlementTypeID: 0 }), false).settlement).toBe("cfd");
    expect(projectPosition(rawPosition(1, { settlementTypeID: 1 }), false).settlement).toBe("real");
    const unknown = projectPosition(rawPosition(1, { settlementTypeID: 7 }), false);
    expect(unknown).not.toHaveProperty("settlement");
    expect(unknown.settlementTypeID).toBe(7);
  });

  it("reports absent stop loss / take profit as null instead of eToro's placeholder rates", () => {
    const p = projectPosition(rawPosition(1), false);
    expect(p.stopLossRate).toBeNull();
    expect(p.takeProfitRate).toBeNull();
    const withSl = projectPosition(rawPosition(2, { isNoStopLoss: false, stopLossRate: 90 }), false);
    expect(withSl.stopLossRate).toBe(90);
  });

  it("summary view: own positions paged, mirrors summarized without their positions", () => {
    const out = compactPortfolio(portfolio(5000), opts) as any;
    expect(out.positions.total).toBe(1);
    expect(out.mirrors).toHaveLength(1);
    expect(out.mirrors[0].positionsCount).toBe(5000);
    expect(out.mirrors[0]).not.toHaveProperty("positions");
    expect(out.mirrors[0].pendingOrders.ordersForOpen).toHaveLength(1);
    expect(out.hint).toContain("mirror");
    expect(JSON.stringify(out).length).toBeLessThan(3000);
  });

  it("pnl view adds per-position pnl and a computed mirror total", () => {
    const out = compactPortfolio(portfolio(4), { ...opts, withPnl: true }) as any;
    expect(out.unrealizedPnL).toBe(2.5);
    expect(out.positions.items[0].unrealizedPnL.pnL).toBe(2.5);
    expect(out.positions.items[0].unrealizedPnL).not.toHaveProperty("closeConversionRate");
    expect(out.mirrors[0].positionsUnrealizedPnL).toBe(10);
  });

  it("mirror view pages the copied trader's positions", () => {
    const first = compactPortfolio(portfolio(120), { ...opts, view: "mirror", mirrorId: 77, limit: 50 }) as any;
    expect(first.positions.total).toBe(120);
    expect(first.positions.items).toHaveLength(50);
    expect(first.positions.hasMore).toBe(true);
    const last = compactPortfolio(portfolio(120), { ...opts, view: "mirror", mirrorId: 77, limit: 50, offset: 100 }) as any;
    expect(last.positions.items).toHaveLength(20);
    expect(last.positions.hasMore).toBe(false);
    expect(last.positions.items[0].positionID).toBe(1100);
  });

  it("an unknown mirror lists the available ids", () => {
    expect(() => compactPortfolio(portfolio(3), { ...opts, view: "mirror", mirrorId: 5 })).toThrow(InputError);
    expect(() => compactPortfolio(portfolio(3), { ...opts, view: "mirror", mirrorId: 5 })).toThrow(/77/);
  });
});

describe("portfolio tools", () => {
  const handler = (call: RecordedCall) => {
    if (call.path === "/api/v1/trading/info/demo/portfolio" || call.path === "/api/v1/trading/info/demo/pnl") return { json: portfolio(3000) };
    if (call.path === "/api/v2/market-data/instruments") {
      const ids = (call.query.instrumentsIds ?? "").split(",").map(Number);
      return { json: { items: ids.filter((i) => i === 1234).map((instrumentId) => ({ instrumentId, symbol: "CSPX.L", displayName: "iShares Core S&P 500" })) } };
    }
    return undefined;
  };

  it("breakdown defaults to the compact view and names the instruments", async () => {
    const { client, calls, close } = await connect(baseCfg(), orderHandler(handler));
    const res = await client.callTool({ name: "etoro_get_portfolio_breakdown", arguments: {} });
    const out = JSON.parse(textOf(res));
    expect(out.positions.items[0].symbol).toBe("CSPX.L");
    expect(out.mirrors[0].positionsCount).toBe(3000);
    expect(textOf(res).length).toBeLessThan(4000);
    expect(calls.filter((c) => c.path === "/api/v2/market-data/instruments")).toHaveLength(1);
    await close();
  });

  it("pnl view includes unrealized profit per position", async () => {
    const { client, close } = await connect(baseCfg(), orderHandler(handler));
    const out = JSON.parse(textOf(await client.callTool({ name: "etoro_get_pnl", arguments: {} })));
    expect(out.unrealizedPnL).toBe(2.5);
    expect(out.positions.items[0].unrealizedPnL.closeRate).toBe(105);
    await close();
  });

  it("mirror view requires a mirrorId and pages", async () => {
    const { client, close } = await connect(baseCfg(), orderHandler(handler));
    const missing = await client.callTool({ name: "etoro_get_portfolio_breakdown", arguments: { view: "mirror" } });
    expect(missing.isError).toBe(true);
    const out = JSON.parse(textOf(await client.callTool({ name: "etoro_get_portfolio_breakdown", arguments: { view: "mirror", mirrorId: 77, limit: 10, offset: 5 } })));
    expect(out.positions.items).toHaveLength(10);
    expect(out.positions.items[0].positionID).toBe(1005);
    expect(out.positions.items[0].symbol).toBe("CSPX.L");
    await close();
  });

  it("raw view returns eToro's JSON (shortened only past the size cap)", async () => {
    const { client, close } = await connect(baseCfg({ maxResponseChars: 20_000 }), orderHandler(handler));
    const raw = await client.callTool({ name: "etoro_get_portfolio_breakdown", arguments: { view: "raw" } });
    const out = JSON.parse(textOf(raw));
    expect(out.clientPortfolio.credit).toBe(3000);
    expect(out._truncated.arrays.length).toBeGreaterThan(0);
    await close();
  });

  it("still works when the instrument lookup fails", async () => {
    const failing = (call: RecordedCall) => (call.path === "/api/v2/market-data/instruments" ? { status: 500, json: { title: "boom" } } : handler(call));
    const { client, close } = await connect(baseCfg(), failing);
    const res = await client.callTool({ name: "etoro_get_portfolio_breakdown", arguments: {} });
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(textOf(res)).positions.items[0]).not.toHaveProperty("symbol");
    await close();
  });
});
