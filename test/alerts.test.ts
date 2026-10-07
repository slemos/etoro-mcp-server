import { describe, expect, it } from "vitest";
import { directionOf, distancePct, projectAlert, projectAlerts, targetWarnings } from "../src/alerts.js";
import { R } from "../src/endpoints.js";
import { type Handler, type RecordedCall, baseCfg, connect, orderHandler, textOf } from "./helpers.js";

const ID_A = "11111111-1111-4111-8111-111111111111";
const ID_B = "22222222-2222-4222-8222-222222222222";
const alert = (alertId: string, targetPrice: number, currentPrice = 846.1) => ({ alertId, instrumentId: 1234, symbol: "EXMPL.L", targetPrice, currentPrice, createdAt: "2026-10-01T10:00:00Z", updatedAt: "2026-10-01T10:00:00Z" });

describe("alert arithmetic", () => {
  it("knows which way the price has to move and how far", () => {
    expect(directionOf(900, 846.1)).toBe("rises_to");
    expect(directionOf(800, 846.1)).toBe("falls_to");
    expect(directionOf(846.1, 846.1)).toBe("at_price");
    expect(distancePct(930, 846.1)).toBe(9.92);
    expect(distancePct(100, 0)).toBeUndefined();
  });

  it("projects an alert and drops rows without an id or a target", () => {
    expect(projectAlert(alert(ID_A, 900))).toEqual({
      alertId: ID_A,
      symbol: "EXMPL.L",
      instrumentId: 1234,
      targetPrice: 900,
      priceWhenSet: 846.1,
      direction: "rises_to",
      distancePct: 6.37,
      createdAt: "2026-10-01T10:00:00Z",
      updatedAt: "2026-10-01T10:00:00Z",
    });
    expect(projectAlerts({ results: [alert(ID_A, 900), { symbol: "X" }, { alertId: "z" }, null] })).toHaveLength(1);
    expect(projectAlerts(undefined)).toEqual([]);
  });

  it("warns about a target at the current price or far from it", () => {
    expect(targetWarnings(846.15, 846.1).join(" ")).toContain("fire right away");
    expect(targetWarnings(8461, 846.1).join(" ")).toContain("more than 5 times above");
    expect(targetWarnings(100, 846.1).join(" ")).toContain("less than a fifth");
    expect(targetWarnings(900, 846.1)).toEqual([]);
    expect(targetWarnings(900, 0)).toEqual([]);
  });
});

describe("price alert tools", () => {
  const handler = (calls: RecordedCall[] = []): Handler => (call) => {
    if (!call.path.startsWith("/api/v1/price-alerts")) return undefined;
    calls.push(call);
    if (call.method === "GET") return { json: { results: [alert(ID_A, 900)] } };
    if (call.method === "POST") return { status: 201, json: { success: true, data: alert(ID_B, 1000) } };
    if (call.method === "PATCH") return { json: { success: true, data: alert(ID_A, 880) } };
    if (call.method === "DELETE") return { json: { success: true, data: { alertId: ID_A } } };
    return undefined;
  };
  const cfg = baseCfg({ enableWrite: true });

  it("lists alerts compactly, also in read-only mode, and exposes no write tool there", async () => {
    const ctx = await connect(baseCfg(), orderHandler(handler()));
    const out = JSON.parse(textOf(await ctx.client.callTool({ name: "etoro_list_price_alerts", arguments: {} })));
    expect(out).toMatchObject({ count: 1, alerts: [{ alertId: ID_A, symbol: "EXMPL.L", direction: "rises_to", distancePct: 6.37 }] });
    const names = (await ctx.client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("etoro_list_price_alerts");
    expect(names.some((n) => n.includes("price_alert") && n.includes("prepare"))).toBe(false);
    await ctx.close();
  });

  it("create: previews with the current bid and sends the POST only when the user executes", async () => {
    const seen: RecordedCall[] = [];
    const ctx = await connect(cfg, orderHandler(handler(seen)));
    const prep = await ctx.prepare("etoro_prepare_create_price_alert", { symbol: "EXMPL.L", targetPrice: 900 });
    expect(prep.summary).toContain("CREATE price alert on EXMPL.L at 900 (now 846.1)");
    expect(seen.filter((c) => c.method === "POST")).toHaveLength(0);
    const page = await (await fetch(prep.approval.url!)).text();
    for (const text of ["Create a price alert", "rises to the target", "places no order and moves no money"]) expect(page, text).toContain(text);
    await ctx.execute(prep);
    const sent = seen.find((c) => c.method === "POST")!;
    expect(sent.path).toBe("/api/v1/price-alerts");
    expect(sent.body).toEqual({ symbol: "EXMPL.L", targetPrice: 900 });
    expect(await ctx.status(prep)).toMatchObject({ status: "executed" });
    await ctx.close();
  });

  it("create: warns about a target that looks like a typo", async () => {
    const ctx = await connect(cfg, orderHandler(handler()));
    const prep = await ctx.prepare("etoro_prepare_create_price_alert", { symbol: "EXMPL.L", targetPrice: 9000 });
    expect((prep.warnings as string[]).join(" ")).toContain("check the decimals");
    await ctx.close();
  });

  it("update: shows old and new target, sends a PATCH to the alert's route, and refuses an unknown alert", async () => {
    const seen: RecordedCall[] = [];
    const ctx = await connect(cfg, orderHandler(handler(seen)));
    const prep = await ctx.prepare("etoro_prepare_update_price_alert", { alertId: ID_A, targetPrice: 880 });
    expect(prep.summary).toContain("from 900 to 880");
    expect(await (await fetch(prep.approval.url!)).text()).toContain("Old target");
    await ctx.execute(prep);
    const sent = seen.find((c) => c.method === "PATCH")!;
    expect(sent.path).toBe(`/api/v1/price-alerts/${ID_A}`);
    expect(sent.body).toEqual({ targetPrice: 880 });
    const missing = await ctx.client.callTool({ name: "etoro_prepare_update_price_alert", arguments: { alertId: ID_B, targetPrice: 880 } });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toContain("No active price alert has the id");
    await ctx.close();
  });

  it("delete: previews what will be removed and sends the DELETE only when the user executes", async () => {
    const seen: RecordedCall[] = [];
    const ctx = await connect(cfg, orderHandler(handler(seen)));
    const prep = await ctx.prepare("etoro_prepare_delete_price_alert", { alertId: ID_A });
    expect(prep.summary).toContain("DELETE price alert");
    expect(seen.some((c) => c.method === "DELETE")).toBe(false);
    await ctx.execute(prep);
    expect(seen.find((c) => c.method === "DELETE")!.path).toBe(`/api/v1/price-alerts/${ID_A}`);
    await ctx.close();
  });

  it("refuses an alert id that is not a UUID, before any request", async () => {
    const seen: RecordedCall[] = [];
    const ctx = await connect(cfg, orderHandler(handler(seen)));
    for (const bad of ["..", "a/b", "not-a-uuid", ""]) {
      expect((await ctx.client.callTool({ name: "etoro_prepare_delete_price_alert", arguments: { alertId: bad } })).isError, bad).toBe(true);
    }
    expect(seen).toHaveLength(0);
    await ctx.close();
  });

  it("has the documented routes", () => {
    expect(R.priceAlerts()).toMatchObject({ kind: "read", method: "GET", path: "/api/v1/price-alerts" });
    expect(R.createPriceAlert()).toMatchObject({ kind: "write", method: "POST", path: "/api/v1/price-alerts" });
    expect(R.updatePriceAlert(ID_A)).toMatchObject({ kind: "write", method: "PATCH", path: `/api/v1/price-alerts/${ID_A}` });
    expect(R.deletePriceAlert(ID_A)).toMatchObject({ kind: "write", method: "DELETE", path: `/api/v1/price-alerts/${ID_A}` });
  });
});
