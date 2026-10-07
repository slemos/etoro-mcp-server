import type { EtoroClient } from "./client.js";
import { R } from "./endpoints.js";
import { extractList } from "./tools/common.js";

export interface Instrument {
  instrumentId: number;
  symbol: string;
  displayName?: string;
  type?: string;
}

export const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

export function toInstrument(raw: unknown): Instrument | undefined {
  const r = asRecord(raw);
  const instrumentId = Number(r.instrumentId ?? r.instrumentID);
  if (!Number.isInteger(instrumentId) || instrumentId <= 0) return undefined;
  return {
    instrumentId,
    symbol: String(r.symbol ?? r.internalSymbolFull ?? ""),
    displayName: typeof r.displayName === "string" ? r.displayName : undefined,
    type: typeof r.type === "string" ? r.type : undefined,
  };
}

/** Best-effort id -> instrument lookup (chunks of 100). Failures yield fewer entries, never an error. */
export async function lookupInstruments(client: EtoroClient, ids: number[]): Promise<Map<number, Instrument>> {
  const unique = [...new Set(ids)].filter((n) => Number.isInteger(n) && n > 0);
  const found = new Map<number, Instrument>();
  for (let i = 0; i < unique.length; i += 100) {
    const chunk = unique.slice(i, i + 100);
    try {
      const response = await client.call(R.instruments(), { query: { instrumentsIds: chunk, pageSize: chunk.length } });
      for (const raw of extractList(response)) {
        const instrument = toInstrument(raw);
        if (instrument) found.set(instrument.instrumentId, instrument);
      }
    } catch {
      // Names are a convenience; the numbers are still returned.
    }
  }
  return found;
}
