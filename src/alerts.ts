/** Price alerts: compact views and the arithmetic the previews show. */
import { asRecord } from "./instruments.js";

export type AlertDirection = "rises_to" | "falls_to" | "at_price";

export interface AlertView {
  alertId: string;
  symbol: string;
  instrumentId?: number;
  targetPrice: number;
  /** Bid at the time the alert was created or last updated, as eToro reports it. */
  priceWhenSet?: number;
  /** Which way the price has to move from `priceWhenSet` to reach the target. */
  direction?: AlertDirection;
  /** Target relative to `priceWhenSet`, in percent. */
  distancePct?: number;
  createdAt?: string;
  updatedAt?: string;
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

export function directionOf(target: number, price: number): AlertDirection {
  if (target > price) return "rises_to";
  if (target < price) return "falls_to";
  return "at_price";
}

/** Percentage distance of the target from a price, or undefined when the price is unusable. */
export function distancePct(target: number, price: number): number | undefined {
  return price > 0 ? Number((((target - price) / price) * 100).toFixed(2)) : undefined;
}

export function projectAlert(raw: unknown): AlertView | undefined {
  const a = asRecord(raw);
  const alertId = typeof a.alertId === "string" ? a.alertId : undefined;
  const targetPrice = num(a.targetPrice);
  if (!alertId || targetPrice === undefined) return undefined;
  const price = num(a.currentPrice);
  return {
    alertId,
    symbol: typeof a.symbol === "string" ? a.symbol : "",
    ...(num(a.instrumentId) !== undefined ? { instrumentId: num(a.instrumentId) } : {}),
    targetPrice,
    ...(price !== undefined ? { priceWhenSet: price, direction: directionOf(targetPrice, price), ...(distancePct(targetPrice, price) !== undefined ? { distancePct: distancePct(targetPrice, price) } : {}) } : {}),
    ...(typeof a.createdAt === "string" ? { createdAt: a.createdAt } : {}),
    ...(typeof a.updatedAt === "string" ? { updatedAt: a.updatedAt } : {}),
  };
}

/** The alerts in a list answer (`results`), as compact views. */
export function projectAlerts(response: unknown): AlertView[] {
  const results = asRecord(response).results;
  return (Array.isArray(results) ? results : []).map(projectAlert).filter((a): a is AlertView => a !== undefined);
}

/** Sentences for a target price compared with the current one: what the alert will do, and whether it looks like a typo. */
export function targetWarnings(target: number, price: number): string[] {
  const out: string[] = [];
  if (!(price > 0)) return out;
  const pct = Math.abs(((target - price) / price) * 100);
  if (pct < 0.1) out.push("The target is almost the current price, so the alert may fire right away.");
  if (target > price * 5 || target < price / 5) {
    out.push(`The target is ${target > price ? "more than 5 times above" : "less than a fifth of"} the current price: check the decimals and the instrument.`);
  }
  return out;
}
