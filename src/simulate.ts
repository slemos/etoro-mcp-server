/**
 * What-if and backtest arithmetic over historical candles. Pure functions: nothing here touches eToro or the network.
 *
 * These are simulations of rules the user states, on past prices: they are not predictions, and they leave out what the
 * candles cannot know (the spread between bid and ask, fees, overnight costs, slippage, currency conversion, dividends,
 * and the order of the high and the low inside one candle). Results are in USD for a USD amount, on the candle prices.
 */
import { InputError } from "./errors.js";
import { asRecord } from "./instruments.js";

export interface Candle {
  /** Start of the candle, ms since the epoch. */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

const num = (v: unknown): number | undefined => {
  if (v === null || v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

const round = (n: number, digits = 4): number => Number(n.toFixed(digits));
const iso = (ms: number): string => new Date(ms).toISOString();

/** eToro's candles as numbers, oldest first, without duplicates or rows lacking a usable price. */
export function parseCandles(results: unknown): Candle[] {
  if (!Array.isArray(results)) return [];
  const seen = new Set<number>();
  const out: Candle[] = [];
  for (const raw of results) {
    const c = asRecord(raw);
    const time = Date.parse(String(c.time ?? c.fromDate ?? ""));
    const open = num(c.open);
    const high = num(c.high);
    const low = num(c.low);
    const close = num(c.close);
    if (!Number.isFinite(time) || seen.has(time)) continue;
    if (open === undefined || high === undefined || low === undefined || close === undefined) continue;
    if (open <= 0 || high <= 0 || low <= 0 || close <= 0) continue;
    seen.add(time);
    out.push({ time, open, high, low, close });
  }
  return out.sort((a, b) => a.time - b.time);
}

// --------------------------------------------------------------- one position
export interface PositionSimInput {
  candles: Candle[];
  side: "buy" | "sellShort";
  amountUsd: number;
  leverage: number;
  stopLossRate?: number;
  takeProfitRate?: number;
}

export type ExitReason = "stop_loss" | "take_profit" | "margin_call" | "end_of_data";

export interface PositionSim {
  entryTime: string;
  entryRate: number;
  units: number;
  exposureUsd: number;
  exitTime: string;
  exitRate: number;
  exitReason: ExitReason;
  pnlUsd: number;
  /** Result as a percentage of the amount put in (the margin). */
  pnlPercentOfAmount: number;
  candlesHeld: number;
  /** Worst and best unrealized result seen while it was open, as a percentage of the amount. */
  worstUnrealizedPercent: number;
  bestUnrealizedPercent: number;
  notes: string[];
}

/**
 * Opens at the first candle's open and follows the candles. A stop loss or take profit triggers when a candle's low or
 * high reaches it (at the open if the candle gaps past it); if one candle reaches both, the stop is assumed to come
 * first. With leverage the position is closed when the loss would use up the whole amount (a margin call).
 */
export function simulatePosition(input: PositionSimInput): PositionSim {
  const { candles, side, amountUsd, leverage, stopLossRate, takeProfitRate } = input;
  if (candles.length === 0) throw new InputError("There are no candles in that window, so there is nothing to simulate.");
  if (!(amountUsd > 0) || !(leverage >= 1)) throw new InputError("amountUsd must be positive and leverage at least 1.");
  const long = side === "buy";
  const d = long ? 1 : -1;
  const first = candles[0]!;
  const entry = first.open;
  const units = (amountUsd * leverage) / entry;
  const notes: string[] = [];

  if (stopLossRate !== undefined && (long ? stopLossRate >= entry : stopLossRate <= entry)) {
    throw new InputError(`The stop loss ${stopLossRate} must be ${long ? "below" : "above"} the entry price ${round(entry)} for a ${long ? "long" : "short"} position.`);
  }
  if (takeProfitRate !== undefined && (long ? takeProfitRate <= entry : takeProfitRate >= entry)) {
    throw new InputError(`The take profit ${takeProfitRate} must be ${long ? "above" : "below"} the entry price ${round(entry)} for a ${long ? "long" : "short"} position.`);
  }

  // The price at which the loss equals the whole amount.
  const marginPrice = long ? entry * (1 - 1 / leverage) : entry * (1 + 1 / leverage);
  const marginIsReachable = long ? marginPrice > 0 : true;
  let stopLevel: number | undefined;
  let stopKind: "stop_loss" | "margin_call" | undefined;
  if (stopLossRate !== undefined) {
    stopLevel = stopLossRate;
    stopKind = "stop_loss";
  }
  if (marginIsReachable && (stopLevel === undefined || (long ? marginPrice > stopLevel : marginPrice < stopLevel))) {
    stopLevel = marginPrice;
    stopKind = "margin_call";
  }

  let exitRate = candles[candles.length - 1]!.close;
  let exitTime = candles[candles.length - 1]!.time;
  let exitReason: ExitReason = "end_of_data";
  let held = candles.length;
  let worst = 0;
  let best = 0;
  const pctOf = (rate: number) => ((d * (rate - entry) * units) / amountUsd) * 100;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]!;
    const adverse = long ? c.low : c.high;
    const favorable = long ? c.high : c.low;
    const stopHit = stopLevel !== undefined && (long ? adverse <= stopLevel : adverse >= stopLevel);
    const targetHit = takeProfitRate !== undefined && (long ? favorable >= takeProfitRate : favorable <= takeProfitRate);
    if (stopHit) {
      const gapped = i > 0 && (long ? c.open <= stopLevel! : c.open >= stopLevel!);
      exitRate = gapped ? c.open : stopLevel!;
      exitTime = c.time;
      exitReason = stopKind!;
      held = i + 1;
      worst = Math.min(worst, pctOf(exitRate));
      if (targetHit) notes.push("One candle reached both the stop and the target; the stop is assumed to have come first.");
      if (gapped) notes.push("The price gapped past the stop, so the position closes at that candle's open.");
      break;
    }
    if (targetHit) {
      const gapped = i > 0 && (long ? c.open >= takeProfitRate! : c.open <= takeProfitRate!);
      exitRate = gapped ? c.open : takeProfitRate!;
      exitTime = c.time;
      exitReason = "take_profit";
      held = i + 1;
      worst = Math.min(worst, pctOf(adverse));
      best = Math.max(best, pctOf(exitRate));
      break;
    }
    worst = Math.min(worst, pctOf(adverse));
    best = Math.max(best, pctOf(favorable));
  }
  if (exitReason === "end_of_data") best = Math.max(best, pctOf(exitRate));

  let pnl = d * (exitRate - entry) * units;
  if (pnl < -amountUsd) {
    pnl = -amountUsd;
    notes.push("The loss is limited to the amount put in.");
  }
  if (exitReason === "margin_call") notes.push("With this leverage the loss reached the whole amount, so the position is closed there.");
  notes.push("Candle prices are bid quotes: no spread, fees, overnight costs, slippage or currency conversion are included, and the order of the high and the low inside a candle is unknown.");

  return {
    entryTime: iso(first.time),
    entryRate: round(entry, 6),
    units: round(units, 6),
    exposureUsd: round(amountUsd * leverage, 2),
    exitTime: iso(exitTime),
    exitRate: round(exitRate, 6),
    exitReason,
    pnlUsd: round(pnl, 2),
    pnlPercentOfAmount: round((pnl / amountUsd) * 100, 2),
    candlesHeld: held,
    worstUnrealizedPercent: round(Math.max(worst, -100), 2),
    bestUnrealizedPercent: round(best, 2),
    notes,
  };
}

// ------------------------------------------------------------------ backtests
export interface BacktestResult {
  strategy: "buy_and_hold" | "dca";
  from: string;
  to: string;
  purchases: number;
  investedUsd: number;
  units: number;
  averageCost: number;
  lastPrice: number;
  finalValueUsd: number;
  returnUsd: number;
  returnPercent: number;
  /** Worst fall of the position's value from its previous peak (buy and hold) or from the money put in so far (dca), in percent. */
  maxDrawdownPercent: number;
  /** The same total invested at the start in one go, for comparison (dca only). */
  lumpSumAtStart?: { units: number; finalValueUsd: number; returnPercent: number };
  notes: string[];
}

const NOTE_COSTS = "Candle prices are bid quotes: no spread, fees, overnight costs, dividends or currency conversion are included. Past results say nothing certain about the future.";

/** One purchase of `amountUsd` at the first candle's open, held to the last close. */
export function backtestBuyAndHold(candles: Candle[], amountUsd: number): BacktestResult {
  if (candles.length === 0) throw new InputError("There are no candles in that window, so there is nothing to test.");
  if (!(amountUsd > 0)) throw new InputError("amountUsd must be positive.");
  const first = candles[0]!;
  const last = candles[candles.length - 1]!;
  const units = amountUsd / first.open;
  let peak = amountUsd;
  let maxDd = 0;
  for (const c of candles) {
    const value = units * c.close;
    peak = Math.max(peak, value, units * c.high);
    maxDd = Math.min(maxDd, (units * c.low) / peak - 1, value / peak - 1);
  }
  const finalValue = units * last.close;
  return {
    strategy: "buy_and_hold",
    from: iso(first.time),
    to: iso(last.time),
    purchases: 1,
    investedUsd: round(amountUsd, 2),
    units: round(units, 6),
    averageCost: round(first.open, 6),
    lastPrice: round(last.close, 6),
    finalValueUsd: round(finalValue, 2),
    returnUsd: round(finalValue - amountUsd, 2),
    returnPercent: round((finalValue / amountUsd - 1) * 100, 2),
    maxDrawdownPercent: round(maxDd * 100, 2),
    notes: [NOTE_COSTS],
  };
}

/** `amountUsd` bought every `everyDays` days, each at the open of the first candle on or after the date. */
export function backtestDca(candles: Candle[], amountUsd: number, everyDays: number): BacktestResult {
  if (candles.length === 0) throw new InputError("There are no candles in that window, so there is nothing to test.");
  if (!(amountUsd > 0) || !Number.isInteger(everyDays) || everyDays < 1) throw new InputError("amountUsd must be positive and everyDays a whole number of days (1 or more).");
  const first = candles[0]!;
  const last = candles[candles.length - 1]!;
  const step = everyDays * 86_400_000;
  let nextBuy = first.time;
  let invested = 0;
  let units = 0;
  let purchases = 0;
  let worst = 0;
  for (const c of candles) {
    while (nextBuy <= c.time) {
      invested += amountUsd;
      units += amountUsd / c.open;
      purchases++;
      nextBuy += step;
    }
    worst = Math.min(worst, (units * c.low) / invested - 1, (units * c.close) / invested - 1);
  }
  const finalValue = units * last.close;
  const lumpUnits = invested / first.open;
  const lumpValue = lumpUnits * last.close;
  return {
    strategy: "dca",
    from: iso(first.time),
    to: iso(last.time),
    purchases,
    investedUsd: round(invested, 2),
    units: round(units, 6),
    averageCost: round(invested / units, 6),
    lastPrice: round(last.close, 6),
    finalValueUsd: round(finalValue, 2),
    returnUsd: round(finalValue - invested, 2),
    returnPercent: round((finalValue / invested - 1) * 100, 2),
    maxDrawdownPercent: round(worst * 100, 2),
    lumpSumAtStart: { units: round(lumpUnits, 6), finalValueUsd: round(lumpValue, 2), returnPercent: round((lumpValue / invested - 1) * 100, 2) },
    notes: [NOTE_COSTS, "The first purchase is at the start of the window and the last one on or before its end."],
  };
}
