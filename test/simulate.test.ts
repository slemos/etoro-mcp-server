import { describe, expect, it } from "vitest";
import { InputError } from "../src/errors.js";
import { type Candle, backtestBuyAndHold, backtestDca, parseCandles, simulatePosition } from "../src/simulate.js";
import { type RecordedCall, baseCfg, connect, orderHandler, textOf } from "./helpers.js";

const DAY = 86_400_000;
const T = Date.UTC(2026, 0, 1);
const c = (day: number, open: number, high: number, low: number, close: number): Candle => ({ time: T + day * DAY, open, high, low, close });

describe("parseCandles", () => {
  it("sorts, drops duplicates and unusable rows, and accepts either time field", () => {
    const out = parseCandles([
      { time: "2026-01-02T00:00:00Z", open: "2", high: "3", low: "1", close: "2.5" },
      { fromDate: "2026-01-01T00:00:00Z", open: 1, high: 2, low: 1, close: 2 },
      { time: "2026-01-02T00:00:00Z", open: "9", high: "9", low: "9", close: "9" },
      { time: "2026-01-03T00:00:00Z", open: "x", high: 1, low: 1, close: 1 },
      { time: "2026-01-04T00:00:00Z", open: 0, high: 1, low: 0, close: 1 },
      { time: "not a date", open: 1, high: 1, low: 1, close: 1 },
    ]);
    expect(out.map((k) => [new Date(k.time).toISOString().slice(0, 10), k.open])).toEqual([
      ["2026-01-01", 1],
      ["2026-01-02", 2],
    ]);
    expect(parseCandles(undefined)).toEqual([]);
  });
});

describe("simulatePosition", () => {
  const rising = [c(0, 100, 105, 99, 104), c(1, 104, 110, 103, 108), c(2, 108, 109, 100, 102)];

  it("holds to the end of the data when nothing triggers, and reports the path", () => {
    const r = simulatePosition({ candles: rising, side: "buy", amountUsd: 1000, leverage: 1 });
    expect(r).toMatchObject({ entryRate: 100, units: 10, exposureUsd: 1000, exitRate: 102, exitReason: "end_of_data", pnlUsd: 20, pnlPercentOfAmount: 2, candlesHeld: 3 });
    expect(r.worstUnrealizedPercent).toBe(-1);
    expect(r.bestUnrealizedPercent).toBe(10);
    expect(r.notes.join(" ")).toContain("no spread, fees, overnight costs");
  });

  it("a stop loss closes at its price, or at the open when the price gaps past it", () => {
    const stop = simulatePosition({ candles: [c(0, 100, 101, 99, 100), c(1, 100, 100, 94, 96)], side: "buy", amountUsd: 1000, leverage: 1, stopLossRate: 95 });
    expect(stop).toMatchObject({ exitReason: "stop_loss", exitRate: 95, pnlUsd: -50, pnlPercentOfAmount: -5, candlesHeld: 2 });
    const gap = simulatePosition({ candles: [c(0, 100, 101, 99, 100), c(1, 90, 92, 88, 91)], side: "buy", amountUsd: 1000, leverage: 1, stopLossRate: 95 });
    expect(gap).toMatchObject({ exitRate: 90, pnlUsd: -100 });
    expect(gap.notes.join(" ")).toContain("gapped past the stop");
  });

  it("a take profit closes at its price; if one candle reaches both, the stop comes first", () => {
    const target = simulatePosition({ candles: rising, side: "buy", amountUsd: 1000, leverage: 1, takeProfitRate: 108 });
    expect(target).toMatchObject({ exitReason: "take_profit", exitRate: 108, pnlUsd: 80, candlesHeld: 2 });
    const both = simulatePosition({ candles: [c(0, 100, 120, 80, 100)], side: "buy", amountUsd: 1000, leverage: 1, stopLossRate: 90, takeProfitRate: 110 });
    expect(both).toMatchObject({ exitReason: "stop_loss", exitRate: 90 });
    expect(both.notes.join(" ")).toContain("stop is assumed to have come first");
  });

  it("with leverage the position is closed when the loss uses up the whole amount", () => {
    const r = simulatePosition({ candles: [c(0, 100, 101, 99, 100), c(1, 100, 100, 49, 60)], side: "buy", amountUsd: 1000, leverage: 2 });
    expect(r).toMatchObject({ units: 20, exposureUsd: 2000, exitReason: "margin_call", exitRate: 50, pnlUsd: -1000, pnlPercentOfAmount: -100 });
    // A stop tighter than the margin level wins over it.
    const tighter = simulatePosition({ candles: [c(0, 100, 101, 99, 100), c(1, 100, 100, 49, 60)], side: "buy", amountUsd: 1000, leverage: 2, stopLossRate: 80 });
    expect(tighter).toMatchObject({ exitReason: "stop_loss", exitRate: 80, pnlUsd: -400 });
  });

  it("a gap beyond the margin never loses more than the amount", () => {
    const r = simulatePosition({ candles: [c(0, 100, 101, 99, 100), c(1, 20, 25, 18, 22)], side: "buy", amountUsd: 1000, leverage: 2 });
    expect(r).toMatchObject({ exitReason: "margin_call", pnlUsd: -1000 });
    expect(r.notes.join(" ")).toContain("limited to the amount put in");
  });

  it("shorts gain when the price falls and stop above the entry", () => {
    const fall = simulatePosition({ candles: [c(0, 100, 101, 95, 96), c(1, 96, 97, 90, 92)], side: "sellShort", amountUsd: 1000, leverage: 1 });
    expect(fall).toMatchObject({ exitReason: "end_of_data", exitRate: 92, pnlUsd: 80 });
    const stop = simulatePosition({ candles: [c(0, 100, 101, 99, 100), c(1, 100, 106, 99, 104)], side: "sellShort", amountUsd: 1000, leverage: 1, stopLossRate: 105 });
    expect(stop).toMatchObject({ exitReason: "stop_loss", exitRate: 105, pnlUsd: -50 });
  });

  it("refuses stops and targets on the wrong side, and empty or invalid input", () => {
    const base = { candles: rising, amountUsd: 1000, leverage: 1 };
    expect(() => simulatePosition({ ...base, side: "buy", stopLossRate: 105 })).toThrow(InputError);
    expect(() => simulatePosition({ ...base, side: "buy", takeProfitRate: 95 })).toThrow(InputError);
    expect(() => simulatePosition({ ...base, side: "sellShort", stopLossRate: 95 })).toThrow(InputError);
    expect(() => simulatePosition({ ...base, candles: [], side: "buy" })).toThrow(/no candles/);
    expect(() => simulatePosition({ ...base, amountUsd: 0, side: "buy" })).toThrow(InputError);
  });
});

describe("backtests", () => {
  it("buy and hold: result and the worst fall from a previous peak", () => {
    const r = backtestBuyAndHold([c(0, 100, 110, 95, 105), c(1, 105, 112, 90, 110), c(2, 110, 125, 108, 120)], 1000);
    expect(r).toMatchObject({ strategy: "buy_and_hold", purchases: 1, investedUsd: 1000, units: 10, finalValueUsd: 1200, returnUsd: 200, returnPercent: 20, maxDrawdownPercent: -19.64 });
  });

  it("dca: buys on schedule at the open, and compares with investing the same total at the start", () => {
    const candles = [c(0, 10, 11, 9, 10), c(1, 10, 12, 10, 11), c(2, 20, 21, 19, 20), c(3, 20, 25, 20, 24)];
    const r = backtestDca(candles, 100, 2);
    expect(r).toMatchObject({ strategy: "dca", purchases: 2, investedUsd: 200, units: 15, finalValueUsd: 360, returnPercent: 80, maxDrawdownPercent: -10 });
    expect(r.averageCost).toBeCloseTo(13.333333, 5);
    expect(r.lumpSumAtStart).toEqual({ units: 20, finalValueUsd: 480, returnPercent: 140 });
  });

  it("dca on a gap in the data buys at the next candle, and rejects bad input", () => {
    const r = backtestDca([c(0, 10, 10, 10, 10), c(5, 20, 20, 20, 20)], 100, 2);
    expect(r.purchases).toBe(3); // day 0, then the schedule's day 2 and day 4 both land on the day-5 candle
    expect(() => backtestDca([], 100, 2)).toThrow(/no candles/);
    expect(() => backtestDca([c(0, 1, 1, 1, 1)], 100, 0)).toThrow(InputError);
    expect(() => backtestBuyAndHold([c(0, 1, 1, 1, 1)], -5)).toThrow(InputError);
  });
});

describe("the simulation tools", () => {
  const cfg = baseCfg();
  const page = (start: number, count: number, price: (i: number) => number): Candle[] => Array.from({ length: count }, (_, i) => c(start + i, price(start + i), price(start + i) + 2, price(start + i) - 2, price(start + i)));
  const asJson = (list: Candle[]) => list.map((k) => ({ time: new Date(k.time).toISOString(), open: String(k.open), high: String(k.high), low: String(k.low), close: String(k.close), volume: "1" }));

  const candleHandler = (calls: RecordedCall[]) => (call: RecordedCall) => {
    if (call.path !== "/api/v1/data/instruments/1234/candles") return undefined;
    calls.push(call);
    const second = call.query.cursor === "page2";
    const list = second ? page(2, 2, (d) => 100 + d * 10) : page(0, 2, (d) => 100 + d * 10);
    return { json: { instrumentId: 1234, results: asJson(list), pagination: second ? { hasNext: false, nextCursor: null } : { hasNext: true, nextCursor: "page2" } } };
  };

  it("simulates a position across two pages of candles, by symbol, and says it is hypothetical", async () => {
    const seen: RecordedCall[] = [];
    const ctx = await connect(cfg, orderHandler(candleHandler(seen)));
    const res = await ctx.client.callTool({ name: "etoro_simulate_position", arguments: { symbol: "EXMPL.L", from: "2026-01-01T00:00:00Z", side: "buy", amountUsd: 1000, leverage: 1 } });
    const out = JSON.parse(textOf(res));
    expect(out).toMatchObject({ hypothetical: true, instrument: { instrumentId: 1234 }, window: { candles: 4, interval: "1d" } });
    expect(out.result).toMatchObject({ entryRate: 100, exitReason: "end_of_data", pnlUsd: 300 });
    expect(out.disclaimer).toContain("not a prediction");
    expect(out.warnings[0]).toContain("candles end on 2026-01-04");
    expect(seen).toHaveLength(2);
    expect(seen[0]!.query).toMatchObject({ interval: "1d", side: "bid", limit: "2000" });
    expect(seen[1]!.query.cursor).toBe("page2");
    expect(ctx.calls.some((k) => k.method !== "GET" && !k.path.includes("instruments"))).toBe(false);
    await ctx.close();
  });

  it("backtests dca and validates the arguments", async () => {
    const ctx = await connect(cfg, orderHandler(candleHandler([])));
    const ok = JSON.parse(textOf(await ctx.client.callTool({ name: "etoro_backtest", arguments: { instrumentId: 1234, from: "2026-01-01T00:00:00Z", strategy: "dca", amountUsd: 100, everyDays: 2 } })));
    expect(ok.result).toMatchObject({ strategy: "dca", purchases: 2, investedUsd: 200 });
    for (const args of [
      { strategy: "dca", amountUsd: 100 }, // everyDays missing
      { strategy: "buy_and_hold", amountUsd: 100, everyDays: 3 },
      { strategy: "buy_and_hold", amountUsd: 100, symbol: "EXMPL.L" }, // both symbol and instrumentId
      { strategy: "buy_and_hold", amountUsd: 100, to: "2025-01-01T00:00:00Z" }, // from after to
    ]) {
      const res = await ctx.client.callTool({ name: "etoro_backtest", arguments: { instrumentId: 1234, from: "2026-01-01T00:00:00Z", ...args } });
      expect(res.isError, JSON.stringify(args)).toBe(true);
    }
    await ctx.close();
  });

  it("refuses a window with too many candles instead of fetching forever", async () => {
    const endless = (call: RecordedCall) =>
      call.path === "/api/v1/data/instruments/1234/candles"
        ? { json: { results: asJson(page(Number(call.query.cursor ?? 0) * 2000, 2000, () => 100)), pagination: { hasNext: true, nextCursor: String(Number(call.query.cursor ?? 0) + 1) } } }
        : undefined;
    const ctx = await connect(cfg, orderHandler(endless));
    const res = await ctx.client.callTool({ name: "etoro_backtest", arguments: { instrumentId: 1234, from: "2000-01-01T00:00:00Z", strategy: "buy_and_hold", amountUsd: 100 } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("coarser interval");
    await ctx.close();
  });

  it("is available in the read-only mode and annotated read-only", async () => {
    const ctx = await connect(cfg, orderHandler());
    const { tools } = await ctx.client.listTools();
    for (const name of ["etoro_simulate_position", "etoro_backtest"]) {
      const tool = tools.find((t) => t.name === name);
      expect(tool?.annotations?.readOnlyHint, name).toBe(true);
    }
    await ctx.close();
  });
});
