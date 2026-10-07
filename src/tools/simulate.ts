import { z } from "zod";
import type { EtoroClient } from "../client.js";
import { R } from "../endpoints.js";
import { InputError } from "../errors.js";
import { asRecord, resolveInstrument } from "../instruments.js";
import { type Candle, backtestBuyAndHold, backtestDca, parseCandles, simulatePosition } from "../simulate.js";
import { type ToolContext, READ, guarded, ok } from "./common.js";

const PAGE = 2000;
const MAX_CANDLES = 20_000;

const DISCLAIMER =
  "A simulation of the rule you gave on past prices, not a prediction, a recommendation or financial advice. Nothing was sent to eToro and nothing was prepared.";

/** Fetches every candle of a window (following eToro's cursor), oldest first. Refuses windows that are too large. */
async function fetchWindow(client: EtoroClient, instrumentId: number, q: { interval: string; from: string; to?: string }): Promise<Candle[]> {
  const raw: unknown[] = [];
  let cursor: string | undefined;
  for (;;) {
    const response = asRecord(await client.call(R.candles(instrumentId), { query: { interval: q.interval, from: q.from, to: q.to, limit: PAGE, side: "bid", cursor } }));
    if (Array.isArray(response.results)) raw.push(...response.results);
    if (raw.length > MAX_CANDLES) {
      throw new InputError(`That window has more than ${MAX_CANDLES} candles. Use a coarser interval or a shorter window.`);
    }
    const next = asRecord(response.pagination);
    if (next.hasNext !== true || typeof next.nextCursor !== "string" || next.nextCursor === "") break;
    cursor = next.nextCursor;
  }
  return parseCandles(raw);
}

/** The data may stop before the window does (a halted instrument, a gap in eToro's history); say so instead of letting it pass unnoticed. */
function coverageWarnings(candles: Candle[], to: string | undefined): string[] {
  if (candles.length === 0) return [];
  const last = candles[candles.length - 1]!.time;
  const end = to === undefined ? Date.now() : Date.parse(to);
  const days = Math.floor((end - last) / 86_400_000);
  return days > 5 ? [`eToro's candles end on ${new Date(last).toISOString().slice(0, 10)}, ${days} days before the end of the window: the simulation stops there.`] : [];
}

const window = {
  symbol: z.string().min(1).max(30).optional().describe("Exact ticker, e.g. 'AAPL'. Provide symbol or instrumentId."),
  instrumentId: z.number().int().positive().optional(),
  from: z.string().datetime({ offset: true }).describe("Start of the window, ISO 8601 with timezone, e.g. 2025-01-01T00:00:00Z."),
  to: z.string().datetime({ offset: true }).optional().describe("End of the window (exclusive). Default: now."),
  interval: z.enum(["1h", "4h", "1d", "1w"]).default("1d").describe("Candle size. Daily is enough for most questions; smaller candles find stops and targets more precisely."),
};

function checkWindow(a: { symbol?: string; instrumentId?: number; from: string; to?: string }): void {
  if ((a.symbol === undefined) === (a.instrumentId === undefined)) throw new InputError("Provide exactly one of symbol or instrumentId.");
  if (a.to !== undefined && Date.parse(a.from) >= Date.parse(a.to)) throw new InputError("from must be earlier than to.");
}

/** Read-only what-if tools over historical candles. They place nothing and prepare nothing. */
export function registerSimulationTools(ctx: ToolContext): void {
  const { mcp, client } = ctx;

  mcp.registerTool(
    "etoro_simulate_position",
    {
      title: "Simulate a position on past prices",
      description:
        "What would have happened if a position had been opened at the start of a window and followed the candles: a long (buy) or short (sellShort) of amountUsd with a leverage, an optional stop loss and take profit, " +
        "held until one of them (or the margin) is hit, or until the end of the window. Returns the entry and exit prices and times, why it ended, the result in USD and as a percentage of the amount, and the worst and best moments in between. " +
        "Uses eToro's historical candles (bid prices; no spread, fees, overnight costs or slippage). It places nothing and prepares nothing. " +
        DISCLAIMER,
      inputSchema: {
        ...window,
        side: z.enum(["buy", "sellShort"]),
        amountUsd: z.number().positive().max(10_000_000).describe("Money put into the position."),
        leverage: z.number().int().min(1).max(30).default(1),
        stopLossRate: z.number().positive().optional().describe("Stop loss as a price (not a percentage): below the entry for a buy, above it for a sellShort."),
        takeProfitRate: z.number().positive().optional().describe("Take profit as a price: above the entry for a buy, below it for a sellShort."),
      },
      annotations: { ...READ("Simulate a position on past prices"), openWorldHint: true },
    },
    guarded(async (a) => {
      checkWindow(a);
      const instrument = await resolveInstrument(client, a.symbol, a.instrumentId);
      const candles = await fetchWindow(client, instrument.instrumentId, a);
      const result = simulatePosition({ candles, side: a.side, amountUsd: a.amountUsd, leverage: a.leverage, stopLossRate: a.stopLossRate, takeProfitRate: a.takeProfitRate });
      return ok({
        hypothetical: true,
        instrument,
        window: { from: a.from, to: a.to ?? "now", interval: a.interval, candles: candles.length },
        warnings: coverageWarnings(candles, a.to),
        input: { side: a.side, amountUsd: a.amountUsd, leverage: a.leverage, stopLossRate: a.stopLossRate ?? null, takeProfitRate: a.takeProfitRate ?? null },
        result,
        disclaimer: DISCLAIMER,
      });
    }),
  );

  mcp.registerTool(
    "etoro_backtest",
    {
      title: "Backtest a simple buying rule on past prices",
      description:
        "How a simple rule would have done over a window of past prices: 'buy_and_hold' (one purchase of amountUsd at the start) or 'dca' (amountUsd every everyDays days). " +
        "Returns what was invested, the units and average cost, the value at the end, the result, the worst fall on the way and, for dca, the same total invested in one go at the start for comparison. " +
        "Unleveraged, with eToro's historical candles (bid prices; no spread, fees, overnight costs or dividends). It places nothing and prepares nothing. " +
        DISCLAIMER,
      inputSchema: {
        ...window,
        strategy: z.enum(["buy_and_hold", "dca"]),
        amountUsd: z.number().positive().max(10_000_000).describe("For buy_and_hold: the one purchase. For dca: each purchase."),
        everyDays: z.number().int().min(1).max(365).optional().describe("dca only: days between purchases."),
      },
      annotations: { ...READ("Backtest a simple buying rule on past prices"), openWorldHint: true },
    },
    guarded(async (a) => {
      checkWindow(a);
      if (a.strategy === "dca" && a.everyDays === undefined) throw new InputError("The dca strategy needs everyDays.");
      if (a.strategy === "buy_and_hold" && a.everyDays !== undefined) throw new InputError("everyDays only applies to the dca strategy.");
      const instrument = await resolveInstrument(client, a.symbol, a.instrumentId);
      const candles = await fetchWindow(client, instrument.instrumentId, a);
      const result = a.strategy === "dca" ? backtestDca(candles, a.amountUsd, a.everyDays!) : backtestBuyAndHold(candles, a.amountUsd);
      return ok({
        hypothetical: true,
        instrument,
        window: { from: a.from, to: a.to ?? "now", interval: a.interval, candles: candles.length },
        warnings: coverageWarnings(candles, a.to),
        result,
        disclaimer: DISCLAIMER,
      });
    }),
  );
}
