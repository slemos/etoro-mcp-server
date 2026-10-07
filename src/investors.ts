/**
 * Compact views of eToro's answers about other investors and about the user's balance history.
 *
 * Other people's records carry more than an assistant needs (full names, internal customer numbers, GDPR flags, long
 * free-text biographies), so only a small, useful subset is passed on. Free text written by an investor is untrusted: the
 * tools say so, and nothing here ever executes or follows it.
 */
import { asRecord } from "./instruments.js";

const SEARCH_FIELDS = [
  "userName",
  "popularInvestor",
  "isPopularInvestor",
  "verified",
  "isFund",
  "country",
  "weeksSinceRegistration",
  "gain",
  "dailyGain",
  "thisWeekGain",
  "riskScore",
  "maxDailyRiskScore",
  "maxMonthlyRiskScore",
  "copiers",
  "aumTierDesc",
  "trades",
  "winRatio",
  "profitableWeeksPct",
  "profitableMonthsPct",
  "peakToValley",
  "avgPosSize",
  "highLeveragePct",
  "mediumLeveragePct",
  "lowLeveragePct",
  "longPosPct",
  "topTradedInstrumentId",
  "topTradedInstrumentPct",
  "instrumentPct",
] as const;

function pick(source: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) if (source[field] !== undefined && source[field] !== null) out[field] = source[field];
  return out;
}

/** One row of an investor search, without ids, names or flags that identify a person beyond their public username. */
export function projectSearchRow(raw: unknown): Record<string, unknown> {
  return pick(asRecord(raw), SEARCH_FIELDS);
}

const TRADEINFO_FIELDS = [
  "userName",
  "weeksSinceRegistration",
  "countryId",
  "isPopularInvestor",
  "isFund",
  "gain",
  "dailyGain",
  "thisWeekGain",
  "riskScore",
  "maxDailyRiskScore",
  "maxMonthlyRiskScore",
  "copiers",
  "copiedTrades",
  "copyTradesPct",
  "copyInvestmentPct",
  "copiersGain",
  "aumTierDesc",
  "trades",
  "topTradedInstrumentId",
  "topTradedAssetId",
  "winRatio",
  "dailyDd",
  "weeklyDd",
  "peakToValley",
  "profitableWeeksPct",
  "profitableMonthsPct",
  "avgPosSize",
  "highLeveragePct",
  "mediumLeveragePct",
  "lowLeveragePct",
  "firstActivity",
  "lastActivity",
  "activeWeeksPct",
  "instrumentPct",
] as const;

/** An investor's statistics over a period, without the full name, affiliate or avatar fields eToro includes. */
export function projectTradeInfo(raw: unknown): Record<string, unknown> {
  return pick(asRecord(raw), TRADEINFO_FIELDS);
}

export interface HoldingGroup {
  instrumentId: number;
  symbol?: string;
  displayName?: string;
  positions: number;
  long: number;
  short: number;
  /** Share of the investor's portfolio in this instrument (sum of the positions' investmentPct), in percent. */
  investmentPct: number;
  averageLeverage: number | null;
  /** Sum of the positions' reported net profit, in percent of what was invested in each, as eToro reports it. */
  netProfitSum: number;
}

const MAX_GROUPS = 25;

/**
 * An investor's live public portfolio, grouped by instrument and sorted by weight. The raw answer lists every position
 * (tens of thousands of characters for an active investor); this keeps the shape of the portfolio.
 */
export function projectLivePortfolio(raw: unknown): { totals: Record<string, unknown>; holdings: HoldingGroup[]; groupsOmitted: number } {
  const r = asRecord(raw);
  const positions = (Array.isArray(r.positions) ? r.positions : []).map(asRecord);
  const groups = new Map<number, { g: HoldingGroup; leverages: number[] }>();
  for (const p of positions) {
    const id = n(p.instrumentId);
    if (id === undefined) continue;
    const entry = groups.get(id) ?? { g: { instrumentId: id, positions: 0, long: 0, short: 0, investmentPct: 0, averageLeverage: null, netProfitSum: 0 }, leverages: [] };
    entry.g.positions++;
    if (p.isBuy === true) entry.g.long++;
    else if (p.isBuy === false) entry.g.short++;
    entry.g.investmentPct += n(p.investmentPct) ?? 0;
    entry.g.netProfitSum += n(p.netProfit) ?? 0;
    const lev = n(p.leverage);
    if (lev !== undefined) entry.leverages.push(lev);
    groups.set(id, entry);
  }
  const all = [...groups.values()].map(({ g, leverages }) => ({
    ...g,
    investmentPct: Number(g.investmentPct.toFixed(2)),
    netProfitSum: Number(g.netProfitSum.toFixed(2)),
    averageLeverage: leverages.length ? Number((leverages.reduce((a, b) => a + b, 0) / leverages.length).toFixed(2)) : null,
  }));
  all.sort((a, b) => b.investmentPct - a.investmentPct);
  return {
    totals: { positions: positions.length, instruments: all.length, realizedCreditPct: r.realizedCreditPct ?? null, unrealizedCreditPct: r.unrealizedCreditPct ?? null },
    holdings: all.slice(0, MAX_GROUPS),
    groupsOmitted: Math.max(all.length - MAX_GROUPS, 0),
  };
}

const MAX_MONTHS = 36;

/** Gain history: all years, and the most recent months (newest first), with the real count. */
export function projectGain(raw: unknown): Record<string, unknown> {
  const r = asRecord(raw);
  const rows = (value: unknown): Array<{ timestamp: string; gain: number }> =>
    (Array.isArray(value) ? value : [])
      .map(asRecord)
      .filter((p) => typeof p.timestamp === "string" && typeof p.gain === "number")
      .map((p) => ({ timestamp: String(p.timestamp), gain: p.gain as number }))
      .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
  const monthly = rows(r.monthly);
  return { yearly: rows(r.yearly), monthly: monthly.slice(0, MAX_MONTHS), monthsAvailable: monthly.length, order: "newest first" };
}

/** A public profile: the username and what eToro shows about them, never internal ids, GDPR data or restrictions. */
export function projectProfile(raw: unknown): Record<string, unknown> {
  const u = asRecord(raw);
  const name = u.allowDisplayFullName === true ? [u.firstName, u.lastName].filter((n) => typeof n === "string" && n !== "").join(" ") : "";
  return {
    ...pick(u, ["username", "isPi", "piLevel", "isVerified", "verificationLevel", "country", "languageIsoCode", "fundType"]),
    ...(name ? { displayName: name } : {}),
    // Written by the investor: untrusted text.
    ...(typeof u.aboutMeShort === "string" && u.aboutMeShort !== "" ? { aboutMeShort: u.aboutMeShort.slice(0, 300) } : {}),
  };
}

export interface BalancePoint {
  date: string;
  totalCash?: number;
  totalInvestedAmount?: number;
  totalPnl?: number;
  totalBalance?: number;
}

const n = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Day-by-day totals in the display currency, oldest first. */
export function projectBalanceHistory(snapshots: unknown): BalancePoint[] {
  if (!Array.isArray(snapshots)) return [];
  return snapshots
    .map(asRecord)
    .filter((s) => typeof s.date === "string")
    .map((s) => ({
      date: String(s.date),
      totalCash: n(s.displayTotalCash) ?? n(s.totalCash),
      totalInvestedAmount: n(s.displayTotalInvestedAmount) ?? n(s.totalInvestedAmount),
      totalPnl: n(s.displayTotalPnl) ?? n(s.totalPnl),
      totalBalance: n(s.displayTotalBalance) ?? n(s.totalBalance),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export interface BalanceSummary {
  days: number;
  from: string;
  to: string;
  firstBalance: number;
  lastBalance: number;
  change: number;
  changePct: number | null;
  lowestBalance: number;
  highestBalance: number;
  note: string;
}

/** Start, end and extremes of the total balance. A change in balance also reflects deposits and withdrawals, not only performance. */
export function summarizeBalanceHistory(points: BalancePoint[]): BalanceSummary | undefined {
  const withBalance = points.filter((p) => p.totalBalance !== undefined);
  if (withBalance.length === 0) return undefined;
  const first = withBalance[0]!;
  const last = withBalance[withBalance.length - 1]!;
  const values = withBalance.map((p) => p.totalBalance!);
  const change = last.totalBalance! - first.totalBalance!;
  return {
    days: withBalance.length,
    from: first.date,
    to: last.date,
    firstBalance: first.totalBalance!,
    lastBalance: last.totalBalance!,
    change: Number(change.toFixed(2)),
    changePct: first.totalBalance! !== 0 ? Number(((change / first.totalBalance!) * 100).toFixed(2)) : null,
    lowestBalance: Math.min(...values),
    highestBalance: Math.max(...values),
    note: "The change in total balance includes deposits and withdrawals, not only gains and losses.",
  };
}
