/**
 * Compact views of eToro's `clientPortfolio` payload (returned by the portfolio breakdown
 * and PnL endpoints). The raw payload repeats ~36 fields per position and nests every
 * copied trader's positions, so it grows into hundreds of thousands of characters.
 * Field names below come from real (value-masked) responses.
 */
import { InputError } from "./errors.js";
import { asRecord } from "./instruments.js";
import { settlementOf } from "./settlement.js";

export type View = "summary" | "mirror" | "raw";

export interface ViewOptions {
  view: View;
  mirrorId?: number;
  limit: number;
  offset: number;
  withPnl: boolean;
}

const POSITION_FIELDS = [
  "positionID",
  "instrumentID",
  "isBuy",
  "openDateTime",
  "openRate",
  "units",
  "amount",
  "initialAmountInDollars",
  "leverage",
  "stopLossRate",
  "takeProfitRate",
  "isTslEnabled",
  "totalFees",
  "settlementTypeID",
  "isSettled",
  "mirrorID",
  "parentPositionID",
] as const;

const PNL_FIELDS = ["pnL", "exposureInAccountCurrency", "marginInAccountCurrency", "closeRate", "timestamp"] as const;

const MIRROR_FIELDS = [
  "mirrorID",
  "parentUsername",
  "parentCID",
  "initialInvestment",
  "availableAmount",
  "depositSummary",
  "withdrawalSummary",
  "closedPositionsNetProfit",
  "startedCopyDate",
  "isPaused",
  "pendingForClosure",
  "mirrorStatusID",
  "stopLossPercentage",
  "stopLossAmount",
  "copyExistingPositions",
] as const;

const ORDER_LISTS = [
  "orders",
  "entryOrders",
  "exitOrders",
  "ordersForOpen",
  "ordersForClose",
  "ordersForCloseMultiple",
  "delayedOrderForOpen",
  "delayedOrderForClose",
] as const;

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

function pick(source: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) if (field in source) out[field] = source[field];
  return out;
}

export function projectPosition(raw: unknown, withPnl: boolean): Record<string, unknown> {
  const p = asRecord(raw);
  const out = pick(p, POSITION_FIELDS);
  const settlement = settlementOf(p.settlementTypeID);
  if (settlement) out.settlement = settlement;
  // eToro fills a placeholder rate when no stop/limit is set; say so explicitly instead.
  if (p.isNoStopLoss === true) out.stopLossRate = null;
  if (p.isNoTakeProfit === true) out.takeProfitRate = null;
  if (withPnl) out.unrealizedPnL = pick(asRecord(p.unrealizedPnL), PNL_FIELDS);
  return out;
}

function pnlOf(position: unknown): number {
  const value = Number(asRecord(asRecord(position).unrealizedPnL).pnL);
  return Number.isFinite(value) ? value : 0;
}

function nonEmptyLists(source: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const name of ORDER_LISTS) {
    const items = list(source[name]);
    if (items.length > 0) out[name] = items;
  }
  return out;
}

export function summarizeMirror(raw: unknown, withPnl: boolean): Record<string, unknown> {
  const m = asRecord(raw);
  const positions = list(m.positions);
  const out: Record<string, unknown> = { ...pick(m, MIRROR_FIELDS), positionsCount: positions.length };
  if (withPnl) out.positionsUnrealizedPnL = Number(positions.reduce<number>((sum, p) => sum + pnlOf(p), 0).toFixed(2));
  const pending = nonEmptyLists(m);
  if (Object.keys(pending).length > 0) out.pendingOrders = pending;
  return out;
}

function page(items: unknown[], opts: ViewOptions): { total: number; offset: number; returned: number; hasMore: boolean; items: Array<Record<string, unknown>> } {
  const slice = items.slice(opts.offset, opts.offset + opts.limit);
  return {
    total: items.length,
    offset: opts.offset,
    returned: slice.length,
    hasMore: opts.offset + slice.length < items.length,
    items: slice.map((p) => projectPosition(p, opts.withPnl)),
  };
}

/** Builds the summary or single-mirror view. (The "raw" view is handled by the caller.) */
export function compactPortfolio(response: unknown, opts: ViewOptions): Record<string, unknown> {
  const cp = asRecord(asRecord(response).clientPortfolio);
  const mirrors = list(cp.mirrors);
  const base: Record<string, unknown> = {
    credit: cp.credit,
    bonusCredit: cp.bonusCredit,
    ...(opts.withPnl && "unrealizedPnL" in cp ? { unrealizedPnL: cp.unrealizedPnL } : {}),
  };
  const pending = nonEmptyLists(cp);

  if (opts.view === "mirror") {
    const target = mirrors.find((m) => Number(asRecord(m).mirrorID) === opts.mirrorId);
    if (!target) {
      const ids = mirrors.map((m) => asRecord(m).mirrorID).join(", ") || "none";
      throw new InputError(`Mirror ${opts.mirrorId} was not found. Available mirrorIds: ${ids}.`);
    }
    return { ...base, mirror: summarizeMirror(target, opts.withPnl), positions: page(list(asRecord(target).positions), opts) };
  }

  return {
    ...base,
    positions: page(list(cp.positions), opts),
    mirrors: mirrors.map((m) => summarizeMirror(m, opts.withPnl)),
    ...(Object.keys(pending).length > 0 ? { pendingOrders: pending } : {}),
    hint:
      mirrors.length > 0
        ? "Copied traders' positions are not listed here: call again with view 'mirror' and a mirrorId (use limit/offset to page)."
        : undefined,
  };
}
