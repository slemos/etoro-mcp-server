import { describe, expect, it } from "vitest";
import { summarizeCandles } from "../src/candles.js";
import { type Handler, baseCfg, connect, textOf } from "./helpers.js";

const candle = (time: string, open: string, high: string, low: string, close: string, volume = "100") => ({ time, open, high, low, close, volume });

describe("summarizeCandles", () => {
  it("summarises in time order whatever order eToro sends", () => {
    const summary = summarizeCandles([
      candle("2026-09-03T00:00:00Z", "110", "120", "105", "118", "50"),
      candle("2026-09-01T00:00:00Z", "100", "112", "98", "108", "30"),
      candle("2026-09-02T00:00:00Z", "108", "111", "101", "110", "20"),
    ]);
    expect(summary).toEqual({
      count: 3,
      from: "2026-09-01T00:00:00Z",
      to: "2026-09-03T00:00:00Z",
      open: 100,
      close: 118,
      high: 120,
      low: 98,
      changePct: 18,
      volume: 100,
    });
  });

  it("ignores rows without usable prices, and reports nothing for no data", () => {
    expect(summarizeCandles([{ time: "2026-09-01T00:00:00Z", open: "x" }])).toBeUndefined();
    expect(summarizeCandles([])).toBeUndefined();
    expect(summarizeCandles(undefined)).toBeUndefined();
    expect(summarizeCandles([candle("2026-09-01T00:00:00Z", "0", "1", "0", "1")])?.changePct).toBeNull();
  });

  it("accepts eToro's alternative field name for the time and leaves volume out when absent", () => {
    const s = summarizeCandles([{ fromDate: "2026-09-01T00:00:00Z", open: 1, high: 2, low: 1, close: 2 }]);
    expect(s).toMatchObject({ count: 1, from: "2026-09-01T00:00:00Z", changePct: 100, volume: null });
  });
});

describe("market data tools", () => {
  const handler: Handler = (call) => {
    if (call.path === "/api/v2/market-data/instruments/search") {
      return {
        json: {
          results: [
            { instrumentId: 1001, displayName: "Apple", type: "Stocks", symbol: "AAPL", exchangeId: 4, image: { uri: "https://x/y.svg", backgroundColor: "#000" } },
            { instrumentId: 9001, displayName: "Apple", type: "Stocks", symbol: "AAPL.RTH", exchangeId: 4, multiplier: null },
          ],
        },
      };
    }
    if (call.path === "/api/v1/data/instruments/1001/candles") {
      return {
        json: {
          instrumentId: 1001,
          symbol: "AAPL",
          interval: "1d",
          side: "bid",
          window: { from: "2026-09-01T00:00:00Z", to: "2026-09-04T00:00:00Z" },
          pagination: { limit: 100, hasNext: false, nextCursor: null },
          results: [candle("2026-09-01T21:00:00Z", "100", "112", "98", "108"), candle("2026-09-02T21:00:00Z", "108", "115", "107", "114")],
        },
      };
    }
    return undefined;
  };

  it("searches by text and returns compact rows without images", async () => {
    const { client, calls, close } = await connect(baseCfg(), handler);
    const res = await client.callTool({ name: "etoro_search_instruments", arguments: { query: "apple", limit: 5 } });
    expect(calls[0]!.path).toBe("/api/v2/market-data/instruments/search");
    expect(calls[0]!.query).toEqual({ query: "apple", limit: "5" });
    const out = JSON.parse(textOf(res));
    expect(out.count).toBe(2);
    expect(out.results[0]).toEqual({ instrumentId: 1001, symbol: "AAPL", displayName: "Apple", type: "Stocks", exchangeId: 4 });
    expect(textOf(res)).not.toContain("image");
    expect(out.results.map((r: { symbol: string }) => r.symbol)).toContain("AAPL.RTH");
    await close();
  });

  it("gets candles with the documented query and adds a summary", async () => {
    const { client, calls, close } = await connect(baseCfg(), handler);
    const res = await client.callTool({
      name: "etoro_get_candles",
      arguments: { instrumentId: 1001, interval: "1d", from: "2026-09-01T00:00:00Z", to: "2026-09-04T00:00:00Z", limit: 10 },
    });
    expect(calls[0]!.query).toEqual({ interval: "1d", from: "2026-09-01T00:00:00Z", to: "2026-09-04T00:00:00Z", limit: "10", side: "bid" });
    const out = JSON.parse(textOf(res));
    expect(out.summary).toMatchObject({ count: 2, open: 100, close: 114, high: 115, low: 98, changePct: 14 });
    expect(out.results).toHaveLength(2);
    expect(out.pagination.hasNext).toBe(false);
    await close();
  });

  it("summaryOnly leaves the candles out", async () => {
    const { client, close } = await connect(baseCfg(), handler);
    const out = JSON.parse(textOf(await client.callTool({ name: "etoro_get_candles", arguments: { instrumentId: 1001, summaryOnly: true } })));
    expect(out.summary.count).toBe(2);
    expect(out).not.toHaveProperty("results");
    await close();
  });

  it("validates the window and the arguments before any request", async () => {
    const { client, calls, close } = await connect(baseCfg(), handler);
    const call = (args: Record<string, unknown>) => client.callTool({ name: "etoro_get_candles", arguments: args });
    expect(textOf(await call({ instrumentId: 1001, from: "2026-09-04T00:00:00Z", to: "2026-09-01T00:00:00Z" }))).toContain("from must be earlier than to");
    expect((await call({ instrumentId: 1001, from: "yesterday" })).isError).toBe(true);
    expect((await call({ instrumentId: 1001, from: "2026-09-01" })).isError).toBe(true); // a timezone is required
    expect((await call({ instrumentId: 1001, interval: "2d" })).isError).toBe(true);
    expect((await call({ instrumentId: 1001, limit: 5000 })).isError).toBe(true);
    expect((await call({ instrumentId: -1 })).isError).toBe(true);
    expect((await client.callTool({ name: "etoro_search_instruments", arguments: { query: "" } })).isError).toBe(true);
    expect((await client.callTool({ name: "etoro_search_instruments", arguments: { query: "x".repeat(101) } })).isError).toBe(true);
    expect(calls).toHaveLength(0);
    await close();
  });

  it("an instrument without data answers with an empty summary, not an error", async () => {
    const { client, close } = await connect(baseCfg(), () => ({ json: { instrumentId: 5, interval: "1d", results: [] } }));
    const out = JSON.parse(textOf(await client.callTool({ name: "etoro_get_candles", arguments: { instrumentId: 5 } })));
    expect(out.summary).toBeNull();
    expect(out.results).toEqual([]);
    await close();
  });
});
