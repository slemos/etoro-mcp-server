import { describe, expect, it } from "vitest";
import { render } from "../src/tools/common.js";

const portfolio = (n: number) => ({
  clientPortfolio: {
    credit: 1000,
    positions: Array.from({ length: n }, (_, i) => ({ positionID: i, note: "x".repeat(50) })),
    mirrors: [{ id: 1, positions: Array.from({ length: n }, (_, i) => ({ positionID: 10_000 + i })) }],
  },
});

describe("render", () => {
  it("returns small results untouched", () => {
    const r = render({ a: 1 }, 1000);
    expect(JSON.parse(r.text)).toEqual({ a: 1 });
    expect(r.trimmed).toEqual([]);
  });

  it("keeps oversized results as valid JSON by shortening arrays, and reports real lengths", () => {
    const r = render(portfolio(2000), 5000);
    expect(r.text.length).toBeLessThanOrEqual(5000);
    const parsed = JSON.parse(r.text);
    expect(parsed.clientPortfolio.credit).toBe(1000);
    expect(parsed._truncated.note).toContain("ETORO_MAX_RESPONSE_CHARS");
    const positions = parsed._truncated.arrays.find((a: { path: string }) => a.path === "clientPortfolio.positions");
    expect(positions.total).toBe(2000);
    expect(parsed.clientPortfolio.positions.length).toBe(positions.kept);
    const nested = parsed._truncated.arrays.find((a: { path: string }) => a.path.includes("mirrors[0].positions"));
    expect(nested.total).toBe(2000);
  });

  it("keeps as many items as fit", () => {
    const small = JSON.parse(render(portfolio(300), 60_000).text);
    expect(small.clientPortfolio.positions.length).toBeGreaterThan(50);
  });

  it("wraps a root array and falls back to a labelled cut only when nothing else fits", () => {
    const arr = Array.from({ length: 5000 }, (_, i) => ({ i }));
    const r = render(arr, 3000);
    const parsed = JSON.parse(r.text);
    expect(Array.isArray(parsed.items)).toBe(true);
    expect(parsed._truncated.arrays[0].total).toBe(5000);
    const hopeless = render({ s: "y".repeat(10_000) }, 500);
    expect(hopeless.text).toContain("[truncated");
  });
});
