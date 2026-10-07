import { describe, expect, it } from "vitest";
import { offeredSettlements, settlementOf } from "../src/settlement.js";
import { eligibilityFor } from "./helpers.js";

describe("settlementOf", () => {
  it("maps the verified ids and refuses to guess the others", () => {
    expect(settlementOf(0)).toBe("cfd");
    expect(settlementOf(1)).toBe("real");
    expect(settlementOf(2)).toBeUndefined();
    expect(settlementOf("0")).toBeUndefined();
    expect(settlementOf(undefined)).toBeUndefined();
  });
});

describe("offeredSettlements", () => {
  it("reads the configurations of the matching instrument and direction", () => {
    const answer = eligibilityFor(1001, ["real", "cfd"]);
    expect(offeredSettlements(answer, 1001, "long")).toEqual({ known: true, settlements: ["real", "cfd"] });
    expect(offeredSettlements(answer, 1001, "short")).toEqual({ known: true, settlements: ["cfd"] });
  });

  it("is case-insensitive and de-duplicates", () => {
    const answer = { eligibilities: [{ instrumentId: 1, leverageConfigs: [{ settlementType: "CFD", direction: "Long" }, { settlementType: "cfd", direction: "long" }] }] };
    expect(offeredSettlements(answer, 1, "long").settlements).toEqual(["cfd"]);
  });

  it("does not use another instrument's configurations", () => {
    expect(offeredSettlements(eligibilityFor(1001, ["cfd"]), 2, "long")).toEqual({ known: false, settlements: [] });
  });

  it("accepts a bare answer without the eligibilities wrapper", () => {
    expect(offeredSettlements({ leverageConfigs: [{ settlementType: "cfd" }] }, 5, "long")).toEqual({ known: true, settlements: ["cfd"] });
  });

  it("reports unknown for anything unreadable", () => {
    for (const bad of [undefined, null, "x", {}, { eligibilities: [] }, { eligibilities: [{ instrumentId: 1 }] }]) {
      expect(offeredSettlements(bad, 1, "long").known).toBe(false);
    }
  });
});
