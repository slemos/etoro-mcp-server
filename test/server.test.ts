import { describe, expect, it } from "vitest";
import { API_KEY, USER_KEY, type RecordedCall, baseCfg, connect, orderHandler, textOf } from "./helpers.js";

const WRITE_TOOLS = [
  "etoro_prepare_open_position",
  "etoro_prepare_close_position",
  "etoro_prepare_cancel_order",
  "etoro_confirm_action",
  "etoro_create_watchlist",
  "etoro_add_watchlist_items",
  "etoro_remove_watchlist_items",
  "etoro_delete_watchlist",
];

const openArgs = { symbol: "CSPX.L", side: "buy", amountUsd: 50, settlementType: "cfd" };
const orderCalls = (calls: RecordedCall[]) =>
  calls.filter((c) => c.method === "POST" && c.path.endsWith("/orders"));

describe("tool surface", () => {
  it("read-only by default: only read tools, all annotated", async () => {
    const { client, close } = await connect(baseCfg(), orderHandler());
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("etoro_get_portfolio");
    for (const w of WRITE_TOOLS) expect(names).not.toContain(w);
    for (const tool of tools) {
      expect(tool.name.length).toBeLessThanOrEqual(64);
      expect(tool.annotations?.readOnlyHint).toBe(true);
      expect(tool.annotations?.destructiveHint).toBe(false);
      expect(tool.annotations?.title || tool.title).toBeTruthy();
    }
    await close();
  });

  it("real environment without the second switch exposes no write tools", async () => {
    const { client, close } = await connect(baseCfg({ env: "real", enableWrite: true }), orderHandler());
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const w of WRITE_TOOLS) expect(names).not.toContain(w);
    await close();
  });

  it("demo with writes enabled exposes the write tools, correctly annotated, but no transfer tool", async () => {
    const { client, close } = await connect(baseCfg({ enableWrite: true }), orderHandler());
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const w of WRITE_TOOLS) expect(names).toContain(w);
    expect(names).not.toContain("etoro_prepare_transfer");
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.etoro_confirm_action!.annotations?.destructiveHint).toBe(true);
    expect(byName.etoro_confirm_action!.annotations?.readOnlyHint).toBe(false);
    expect(byName.etoro_get_rates!.annotations?.readOnlyHint).toBe(true);
    // Read and write are separate tools: no read tool is marked as a writer.
    for (const t of tools) {
      if (t.annotations?.readOnlyHint) expect(WRITE_TOOLS).not.toContain(t.name);
    }
    await close();
  });

  it("transfer tool exists only with real + both switches + transfers switch", async () => {
    const cfg = baseCfg({ env: "real", enableWrite: true, allowRealWrite: true, allowTransfers: true });
    const { client, close } = await connect(cfg, orderHandler());
    expect((await client.listTools()).tools.map((t) => t.name)).toContain("etoro_prepare_transfer");
    await close();
  });
});

describe("write flow", () => {
  const cfg = baseCfg({ enableWrite: true });

  it("preview sends nothing; confirm (user accepts) places exactly one order; replay is idempotent", async () => {
    const { client, calls, prompts, auditLines, close } = await connect(cfg, orderHandler(), "accept");
    const prep = await client.callTool({ name: "etoro_prepare_open_position", arguments: openArgs });
    expect(prep.isError).toBeFalsy();
    const preview = JSON.parse(textOf(prep));
    expect(preview.confirmationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(preview.estimatedCosts.costs[0].costType).toBe("markup");
    expect(orderCalls(calls)).toHaveLength(0);

    const done = await client.callTool({ name: "etoro_confirm_action", arguments: { confirmationId: preview.confirmationId } });
    expect(done.isError).toBeFalsy();
    expect(prompts[0]).toContain("CSPX.L");
    const orders = orderCalls(calls);
    expect(orders).toHaveLength(1);
    expect(orders[0]!.path).toBe("/api/v2/trading/execution/demo/orders");
    expect(orders[0]!.body).toMatchObject({
      action: "open",
      transaction: "buy",
      instrumentId: 1234,
      settlementType: "cfd",
      orderType: "mkt",
      leverage: 1,
      amount: 50,
      orderCurrency: "usd",
    });
    expect(textOf(done)).toContain('"orderId": 99');

    const replay = await client.callTool({ name: "etoro_confirm_action", arguments: { confirmationId: preview.confirmationId } });
    expect(textOf(replay)).toContain("already executed");
    expect(orderCalls(calls)).toHaveLength(1);

    const audit = auditLines.join("\n");
    expect(audit).toContain("prepared");
    expect(audit).toContain("executed");
    expect(audit).not.toContain(API_KEY);
    expect(audit).not.toContain(USER_KEY);
    await close();
  });

  it("a declined confirmation sends nothing", async () => {
    const { client, calls, close } = await connect(cfg, orderHandler(), "decline");
    const prep = JSON.parse(textOf(await client.callTool({ name: "etoro_prepare_open_position", arguments: openArgs })));
    const res = await client.callTool({ name: "etoro_confirm_action", arguments: { confirmationId: prep.confirmationId } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("declined");
    expect(orderCalls(calls)).toHaveLength(0);
    await close();
  });

  it("when a human is required and the client cannot ask, nothing is sent", async () => {
    const strict = baseCfg({ enableWrite: true, requireElicitation: true });
    const { client, calls, close } = await connect(strict, orderHandler(), "none");
    const prep = JSON.parse(textOf(await client.callTool({ name: "etoro_prepare_open_position", arguments: openArgs })));
    const res = await client.callTool({ name: "etoro_confirm_action", arguments: { confirmationId: prep.confirmationId } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("ETORO_REQUIRE_ELICITATION");
    expect(orderCalls(calls)).toHaveLength(0);
    await close();
  });

  it("without the human requirement the token flow alone executes", async () => {
    const { client, calls, close } = await connect(cfg, orderHandler(), "none");
    const prep = JSON.parse(textOf(await client.callTool({ name: "etoro_prepare_open_position", arguments: openArgs })));
    const res = await client.callTool({ name: "etoro_confirm_action", arguments: { confirmationId: prep.confirmationId } });
    expect(res.isError).toBeFalsy();
    expect(orderCalls(calls)).toHaveLength(1);
    await close();
  });

  it("rejects orders above the per-order exposure cap (amount x leverage)", async () => {
    const { client, calls, close } = await connect(cfg, orderHandler(), "accept");
    const big = await client.callTool({ name: "etoro_prepare_open_position", arguments: { ...openArgs, amountUsd: 500 } });
    expect(big.isError).toBe(true);
    expect(textOf(big)).toContain("ETORO_MAX_ORDER_USD");
    const levered = await client.callTool({
      name: "etoro_prepare_open_position",
      arguments: { ...openArgs, amountUsd: 60, leverage: 2, stopLossRate: 700 },
    });
    expect(levered.isError).toBe(true);
    expect(orderCalls(calls)).toHaveLength(0);
    await close();
  });

  it("units-based orders are valued with the market ask for the cap", async () => {
    const { client, close } = await connect(cfg, orderHandler(), "accept");
    // 1 unit at ask 846.35 is far above the 100 USD cap.
    const res = await client.callTool({
      name: "etoro_prepare_open_position",
      arguments: { symbol: "CSPX.L", side: "buy", units: 1 },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("ETORO_MAX_ORDER_USD");
    await close();
  });

  it("validates cross-field rules", async () => {
    const { client, calls, close } = await connect(cfg, orderHandler(), "accept");
    const both = await client.callTool({ name: "etoro_prepare_open_position", arguments: { ...openArgs, units: 1 } });
    expect(both.isError).toBe(true);
    const noStop = await client.callTool({ name: "etoro_prepare_open_position", arguments: { ...openArgs, side: "sellShort" } });
    expect(textOf(noStop)).toContain("stopLossRate");
    const noInstrument = await client.callTool({ name: "etoro_prepare_open_position", arguments: { side: "buy", amountUsd: 10 } });
    expect(noInstrument.isError).toBe(true);
    expect(orderCalls(calls)).toHaveLength(0);
    await close();
  });

  it("ambiguous symbols ask for an instrumentId", async () => {
    const { client, close } = await connect(cfg, orderHandler(), "accept");
    const res = await client.callTool({
      name: "etoro_prepare_open_position",
      arguments: { symbol: "AMBIG", side: "buy", amountUsd: 10 },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("instrumentId");
    await close();
  });

  it("closing sends the documented body for the right environment", async () => {
    const handler = orderHandler((call) =>
      call.method === "POST" && call.path.includes("market-close-orders")
        ? { json: { orderForClose: { orderID: 5 }, token: "t" } }
        : call.path.endsWith("/portfolio")
          ? { json: { clientPortfolio: { positions: [{ positionID: 777, instrumentID: 1234, units: 2 }] } } }
          : undefined,
    );
    const { client, calls, close } = await connect(cfg, handler, "accept");
    const prep = JSON.parse(
      textOf(await client.callTool({ name: "etoro_prepare_close_position", arguments: { positionId: 777, instrumentId: 1234 } })),
    );
    expect(prep.matchedPosition.positionID).toBe(777);
    await client.callTool({ name: "etoro_confirm_action", arguments: { confirmationId: prep.confirmationId } });
    const close_ = calls.find((c) => c.path.includes("market-close-orders"))!;
    expect(close_.path).toBe("/api/v1/trading/execution/demo/market-close-orders/positions/777");
    expect(close_.body).toEqual({ InstrumentID: 1234, UnitsToDeduct: null });
    await close();
  });

  it("cancelling goes through the same preview and confirmation", async () => {
    const handler = orderHandler((call) => (call.method === "DELETE" ? { json: { token: "t" } } : undefined));
    const { client, calls, close } = await connect(cfg, handler, "accept");
    const prep = JSON.parse(textOf(await client.callTool({ name: "etoro_prepare_cancel_order", arguments: { orderId: 55 } })));
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    await client.callTool({ name: "etoro_confirm_action", arguments: { confirmationId: prep.confirmationId } });
    const del = calls.find((c) => c.method === "DELETE")!;
    expect(del.path).toBe("/api/v2/trading/execution/demo/orders/55");
    await close();
  });

  it("an unknown confirmationId is rejected", async () => {
    const { client, calls, close } = await connect(cfg, orderHandler(), "accept");
    const res = await client.callTool({
      name: "etoro_confirm_action",
      arguments: { confirmationId: "00000000-0000-4000-8000-000000000000" },
    });
    expect(res.isError).toBe(true);
    expect(orderCalls(calls)).toHaveLength(0);
    await close();
  });

  it("enforces the per-minute write limit across confirmations", async () => {
    const limited = baseCfg({ enableWrite: true, maxWritesPerMinute: 1 });
    const { client, calls, close } = await connect(limited, orderHandler(), "accept");
    for (let i = 0; i < 2; i++) {
      const prep = JSON.parse(textOf(await client.callTool({ name: "etoro_prepare_open_position", arguments: openArgs })));
      const res = await client.callTool({ name: "etoro_confirm_action", arguments: { confirmationId: prep.confirmationId } });
      expect(Boolean(res.isError)).toBe(i === 1);
    }
    expect(orderCalls(calls)).toHaveLength(1);
    await close();
  });
});

describe("read tools", () => {
  it("surface API errors as tool errors with hints and without keys", async () => {
    const handler = () => ({ status: 401, json: { title: "Unauthorized", detail: `bad ${API_KEY}` } });
    const { client, close } = await connect(baseCfg(), handler);
    const res = await client.callTool({ name: "etoro_get_portfolio", arguments: {} });
    expect(res.isError).toBe(true);
    const text = textOf(res);
    expect(text).toContain("401");
    expect(text).toContain("Hint");
    expect(text).not.toContain(API_KEY);
    await close();
  });

  it("route to the demo or real paths by environment", async () => {
    for (const env of ["demo", "real"] as const) {
      const { client, calls, close } = await connect(baseCfg({ env }), () => ({ json: {} }));
      await client.callTool({ name: "etoro_get_pnl", arguments: {} });
      expect(calls[0]!.path).toBe(env === "demo" ? "/api/v1/trading/info/demo/pnl" : "/api/v1/trading/info/real/pnl");
      await close();
    }
  });

  it("validates exactly-one-of rules", async () => {
    const { client, calls, close } = await connect(baseCfg(), () => ({ json: {} }));
    const none = await client.callTool({ name: "etoro_get_order", arguments: {} });
    const both = await client.callTool({ name: "etoro_get_order", arguments: { orderId: 1, referenceId: "x" } });
    expect(none.isError).toBe(true);
    expect(both.isError).toBe(true);
    expect(calls).toHaveLength(0);
    await close();
  });
});
