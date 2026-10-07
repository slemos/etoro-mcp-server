import { describe, expect, it } from "vitest";
import { findMissing, templateToRegExp } from "../scripts/check-routes.mjs";

const spec = {
  "/api/v1/things/{id}": { get: {}, delete: {} },
  "/api/v2/orders:lookup": { get: {} },
  "/api/v1/things": { post: {} },
};

describe("route check", () => {
  it("turns a path template into a one-segment-per-parameter pattern", () => {
    const re = templateToRegExp("/api/v1/things/{id}/items");
    expect(re.test("/api/v1/things/42/items")).toBe(true);
    expect(re.test("/api/v1/things/42/7/items")).toBe(false);
    expect(templateToRegExp("/api/v2/orders:lookup").test("/api/v2/orders:lookup")).toBe(true);
    expect(templateToRegExp("/api/v1/a.b").test("/api/v1/aXb")).toBe(false);
  });

  it("accepts routes that exist with their method and reports the others", () => {
    const routes = [
      { id: "a", method: "GET", path: "/api/v1/things/x1" },
      { id: "b", method: "DELETE", path: "/api/v1/things/x1" },
      { id: "c", method: "GET", path: "/api/v2/orders:lookup" },
      { id: "d", method: "PATCH", path: "/api/v1/things/x1" }, // wrong method
      { id: "e", method: "GET", path: "/api/v1/missing/x1" }, // no such path
    ];
    const missing = findMissing(routes, spec);
    expect(missing.map((m) => m.id)).toEqual(["d", "e"]);
    expect(missing[0].otherMethods.sort()).toEqual(["DELETE", "GET"]);
    expect(missing[1].otherMethods).toEqual([]);
  });
});
