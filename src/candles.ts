/**
 * Helpers for price candles: a small numeric summary so a long series does not have to be read row by row.
 * eToro returns candle prices as exact decimal strings; they are converted only for the summary.
 */
import { asRecord } from "./instruments.js";

export interface CandleSummary {
  count: number;
  from: string;
  to: string;
  open: number;
  close: number;
  high: number;
  low: number;
  /** Percentage change from the first candle's open to the last candle's close. */
  changePct: number | null;
  /** Total traded volume over the window, when eToro reports it. */
  volume: number | null;
}

const num = (value: unknown): number | undefined => {
  if (value === null || value === undefined || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
};

const round = (n: number, digits = 6): number => Number(n.toFixed(digits));

/** Summarises a list of candles in any order; undefined when none has usable prices. */
export function summarizeCandles(results: unknown): CandleSummary | undefined {
  if (!Array.isArray(results)) return undefined;
  const candles = results
    .map(asRecord)
    .map((c) => ({ time: String(c.time ?? c.fromDate ?? ""), open: num(c.open), high: num(c.high), low: num(c.low), close: num(c.close), volume: num(c.volume) }))
    .filter((c) => c.time !== "" && c.open !== undefined && c.high !== undefined && c.low !== undefined && c.close !== undefined)
    .sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
  if (candles.length === 0) return undefined;
  const first = candles[0]!;
  const last = candles[candles.length - 1]!;
  const volumes = candles.map((c) => c.volume).filter((v): v is number => v !== undefined);
  return {
    count: candles.length,
    from: first.time,
    to: last.time,
    open: first.open!,
    close: last.close!,
    high: Math.max(...candles.map((c) => c.high!)),
    low: Math.min(...candles.map((c) => c.low!)),
    changePct: first.open! !== 0 ? round(((last.close! - first.open!) / first.open!) * 100, 2) : null,
    volume: volumes.length > 0 ? round(volumes.reduce((a, b) => a + b, 0), 2) : null,
  };
}
