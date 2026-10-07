/** What closing (part of) an open position would roughly yield at the current price. A preview aid, never an execution price. */
export interface CloseEstimateInput {
  isBuy: boolean;
  /** Units of the open position. */
  units: number;
  openRate: number;
  /** Units to close; omit for the whole position. */
  closeUnits?: number;
  bid: number;
  ask: number;
  /** Money put into the whole position (its `amount`), to express the result as a share of it. */
  amount?: number;
}

export interface CloseEstimate {
  /** The price the close would use: a long closes at the bid, a short at the ask. */
  closeRate: number;
  closeUnits: number;
  /** Share of the position being closed, 0 to 1. */
  fraction: number;
  remainingUnits: number;
  /** Price move times units closed, in the instrument's currency. Excludes spread already in the rate, fees, overnight costs and currency conversion. */
  pnl: number;
  /** pnl as a percentage of the money invested in the part being closed, when `amount` is known. */
  pnlPercent?: number;
}

/** Returns undefined when the inputs cannot give a meaningful estimate (missing or non-positive numbers). */
export function estimateClose(i: CloseEstimateInput): CloseEstimate | undefined {
  const { units, openRate, bid, ask } = i;
  if (![units, openRate, bid, ask].every((n) => Number.isFinite(n) && n > 0)) return undefined;
  const closeUnits = i.closeUnits ?? units;
  if (!Number.isFinite(closeUnits) || closeUnits <= 0 || closeUnits > units * (1 + 1e-9)) return undefined;
  const closeRate = i.isBuy ? bid : ask;
  const pnl = (i.isBuy ? closeRate - openRate : openRate - closeRate) * closeUnits;
  const fraction = Math.min(closeUnits / units, 1);
  const invested = i.amount !== undefined && Number.isFinite(i.amount) && i.amount > 0 ? i.amount * fraction : undefined;
  return {
    closeRate,
    closeUnits,
    fraction,
    remainingUnits: Math.max(units - closeUnits, 0),
    pnl,
    ...(invested !== undefined ? { pnlPercent: (pnl / invested) * 100 } : {}),
  };
}
