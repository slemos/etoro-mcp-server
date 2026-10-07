import { describe, expect, it } from "vitest";
import { describeText, maskValue, verdictOf } from "../scripts/smoke.mjs";

const sample = {
  clientPortfolio: {
    credit: 98765.43,
    positions: [
      { positionID: 111222333, units: 2.5, isBuy: true, comment: "my-private-note" },
      { positionID: 2 },
      { positionID: 3 },
      { positionID: 4 },
      { positionID: 5 },
    ],
    mirrors: [],
    note: null,
  },
};

describe("smoke script helpers", () => {
  it("masks every value but keeps names, types and nesting", () => {
    const masked = maskValue(sample);
    const text = JSON.stringify(masked);
    for (const secret of ["98765.43", "111222333", "my-private-note", "2.5"]) expect(text).not.toContain(secret);
    expect(masked.clientPortfolio.credit).toBe("<number>");
    expect(masked.clientPortfolio.positions[0].isBuy).toBe(true);
    expect(masked.clientPortfolio.positions[0].positionID).toBe("<number>");
    expect(masked.clientPortfolio.positions[0].comment).toBe("<string, 15 chars>");
    expect(masked.clientPortfolio.positions).toHaveLength(4); // 3 samples + a count note
    expect(masked.clientPortfolio.positions[3]).toBe("... (2 more items)");
    expect(masked.clientPortfolio.note).toBeNull();
  });

  it("describes structure without values and flags truncation or non-JSON", () => {
    expect(describeText(JSON.stringify({ a: 1, b: [1, 2], c: "x" }))).toContain("object { a: number, b: array(2), c: string }");
    expect(describeText('"just a string"')).toContain("JSON string (length 13)");
    expect(describeText("<html>")).toContain("not valid JSON");
    expect(describeText('{"a":1}\n... [truncated 5 characters]')).toContain("TRUNCATED");
    expect(describeText(JSON.stringify({ secret: "top-secret-123" }))).not.toContain("top-secret-123");
  });
});

describe("verdictOf", () => {
  const base = { connected: true, environment: "demo", dataBelongsTo: "demo", keyIsFor: ["demo"], environmentVerified: true, warnings: [], otherEnvironmentRoute: { environment: "real", answered: false, sameAccountAsConfigured: null } };

  it("confirms a consistent demo setup", () => {
    const v = verdictOf(base);
    expect(v.level).toBe("OK");
    expect(v.text).toContain("DEMO");
  });

  it("states the proof and warns when the key can also trade the other environment", () => {
    const both = { ...base, otherEnvironmentRoute: { environment: "real", answered: true, sameAccountAsConfigured: false, belongsTo: "real" }, advice: ["This key can ALSO place orders in the REAL environment ..."] };
    const v = verdictOf(both);
    expect(v.level).toBe("OK");
    expect(v.text).toContain("serves your DEMO account");
    expect(v.text).toContain("real route serves your REAL account");
    expect(v.text).toContain("WARNING: this key can also place orders with REAL money");
  });

  it("reports a rejected key", () => {
    expect(verdictOf({ ...base, connected: false }).level).toBe("FAIL");
  });

  it("flags demo configuration that is reading the real account", () => {
    const v = verdictOf({ ...base, dataBelongsTo: "real", environmentVerified: false });
    expect(v.level).toBe("MISMATCH");
    expect(v.text).toContain("REAL");
  });

  it("flags a key scoped to the other environment", () => {
    const v = verdictOf({ ...base, keyIsFor: ["real"], dataBelongsTo: "unknown", environmentVerified: false });
    expect(v.level).toBe("MISMATCH");
    expect(v.text).toContain("real");
  });

  it("is inconclusive when both routes return the same account", () => {
    const v = verdictOf({ ...base, environmentVerified: false, otherEnvironmentRoute: { environment: "real", answered: true, sameAccountAsConfigured: true } });
    expect(v.level).toBe("INCONCLUSIVE");
    expect(v.text).toContain("cannot be told apart");
  });
});
