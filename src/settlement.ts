/**
 * Settlement: does a position hold the real asset or a CFD (a contract on its price)?
 *
 * Which one an account may use depends on the jurisdiction (for example, accounts of the
 * Cyprus-based entity only get CFDs). The eligibility check lists what is offered per
 * instrument; asking for something else is rejected by eToro only after it accepted the
 * request, so the preview checks it first.
 */
import { asRecord } from "./instruments.js";

export type Settlement = "cfd" | "real";

/**
 * `settlementTypeID` on a position: 0 is a CFD, 1 is the real asset. Verified against eToro:
 * a CFD position came back with 0 / isSettled false, and a request for settlement type 1
 * ("real") on a CFD-only account was rejected as "Requested settlement type: 1 is disallowed".
 * Other ids are left unlabelled rather than guessed.
 */
export function settlementOf(settlementTypeID: unknown): Settlement | undefined {
  if (settlementTypeID === 0) return "cfd";
  if (settlementTypeID === 1) return "real";
  return undefined;
}

export interface Offered {
  /** True when the eligibility answer had at least one configuration for this instrument and direction. */
  known: boolean;
  /** Settlement types offered for the direction, lower case, in eToro's order. */
  settlements: string[];
}

/** Which settlement types does an eligibility answer offer for a long or short position? */
export function offeredSettlements(eligibility: unknown, instrumentId: number, direction: "long" | "short"): Offered {
  const root = asRecord(eligibility);
  const entries = Array.isArray(root.eligibilities) ? root.eligibilities.map(asRecord) : [];
  const entry = entries.find((e) => Number(e.instrumentId) === instrumentId) ?? (entries.length === 0 ? root : {});
  const configs = Array.isArray(entry.leverageConfigs) ? entry.leverageConfigs.map(asRecord) : [];
  const matching = configs.filter((c) => c.direction === undefined || String(c.direction).toLowerCase() === direction);
  const settlements = [...new Set(matching.map((c) => String(c.settlementType ?? "").toLowerCase()).filter(Boolean))];
  return { known: settlements.length > 0, settlements };
}
