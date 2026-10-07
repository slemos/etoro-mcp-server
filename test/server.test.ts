import { describe, expect, it } from "vitest";
import { API_KEY, ME, USER_KEY, type Handler, type RecordedCall, baseCfg, connect, eligibilityFor, orderHandler, pressButton, textOf } from "./helpers.js";

const WRITE_TOOLS = [
  "etoro_prepare_open_position",
  "etoro_prepare_close_position",
  "etoro_prepare_modify_position",
  "etoro_prepare_cancel_order",
  "etoro_prepare_create_watchlist",
  "etoro_prepare_add_watchlist_items",
  "etoro_prepare_remove_watchlist_items",
  "etoro_prepare_delete_watchlist",
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
    expect(names).not.toContain("etoro_confirm_action"); // nothing Claude can call executes an action
    expect(byName.etoro_get_action_status!.annotations?.readOnlyHint).toBe(true);
    for (const w of WRITE_TOOLS) expect(byName[w]!.annotations?.readOnlyHint).toBe(false);
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
  const offering = (...settlements: Array<"cfd" | "real">): Handler => (call) =>
    call.path.endsWith("/eligibility") ? { json: eligibilityFor(1234, settlements) } : undefined;
  const raw = (ctx: { client: { callTool: (a: { name: string; arguments: Record<string, unknown> }) => Promise<unknown> } }, args: Record<string, unknown>) =>
    ctx.client.callTool({ name: "etoro_prepare_open_position", arguments: args }) as Promise<{ isError?: boolean; content: Array<{ text?: string }> }>;

  it("a preview sends nothing and opens the approval page; only the user pressing Execute places exactly one order", async () => {
    const { prepare, execute, status, calls, opened, auditLines, close } = await connect(cfg, orderHandler());
    const preview = await prepare("etoro_prepare_open_position", openArgs);
    expect(preview.actionId).toMatch(/^[0-9a-f-]{36}$/);
    expect((preview.estimatedCosts as { costs: Array<{ costType: string }> }).costs[0]!.costType).toBe("markup");
    expect(preview.approval).toMatchObject({ status: "awaiting_user", pageOpened: true });
    expect(opened).toEqual([preview.approval.url]);
    expect(orderCalls(calls)).toHaveLength(0);
    expect(await status(preview)).toMatchObject({ status: "pending" });

    const page = await (await fetch(preview.approval.url!)).text();
    expect(page).toContain("CSPX.L");
    expect(page).toContain("DEMO");
    expect(orderCalls(calls)).toHaveLength(0); // looking at the page changes nothing

    expect((await execute(preview)).status).toBe(303);
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
    expect(await status(preview)).toMatchObject({ status: "executed", result: { orderId: 99 } });

    // Pressing again never sends a second order.
    await pressButton(preview.approval.url!, "execute");
    expect(orderCalls(calls)).toHaveLength(1);

    const audit = auditLines.join("\n");
    expect(audit).toContain("prepared");
    expect(audit).toContain("approved_by_user");
    expect(audit).toContain("executed");
    expect(audit).not.toContain(API_KEY);
    expect(audit).not.toContain(USER_KEY);
    await close();
  });

  it("rejecting on the page sends nothing, and a rejected action cannot be executed later", async () => {
    const { prepare, reject, status, calls, close } = await connect(cfg, orderHandler());
    const preview = await prepare("etoro_prepare_open_position", openArgs);
    expect((await reject(preview)).status).toBe(303);
    expect(await status(preview)).toMatchObject({ status: "rejected" });
    await pressButton(preview.approval.url!, "execute");
    expect(orderCalls(calls)).toHaveLength(0);
    expect(await status(preview)).toMatchObject({ status: "rejected" });
    await close();
  });

  it("the status tool reports an unknown action as an error", async () => {
    const { client, close } = await connect(cfg, orderHandler());
    const res = await client.callTool({ name: "etoro_get_action_status", arguments: { actionId: "00000000-0000-4000-8000-000000000000" } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("Unknown actionId");
    await close();
  });

  it("the model never sees the approval address unless ETORO_SHOW_APPROVAL_URL is on", async () => {
    const hidden = await connect(baseCfg({ enableWrite: true, showApprovalUrl: false }), orderHandler());
    const text = textOf(await hidden.client.callTool({ name: "etoro_prepare_open_position", arguments: openArgs }));
    expect(text).not.toContain("127.0.0.1");
    expect(text).not.toContain("/t/");
    const out = JSON.parse(text);
    expect(out.approval).toEqual({ status: "awaiting_user", pageOpened: true });
    // The address went only to the browser opener, and the status tool never exposes it.
    expect(hidden.opened).toHaveLength(1);
    const token = new URL(hidden.opened[0]!).pathname.split("/")[2]!;
    const status = textOf(await hidden.client.callTool({ name: "etoro_get_action_status", arguments: { actionId: out.actionId } }));
    expect(status).not.toContain(token);
    expect(status).not.toContain("127.0.0.1");
    expect(text).not.toContain(token);
    await hidden.close();
  });

  it("says so when the page could not be opened", async () => {
    const { client, close } = await connect(baseCfg({ enableWrite: true, showApprovalUrl: false }), orderHandler(), { openUrl: async () => false });
    const out = JSON.parse(textOf(await client.callTool({ name: "etoro_prepare_open_position", arguments: openArgs })));
    expect(out.approval.pageOpened).toBe(false);
    expect(out.note).toContain("could not be opened automatically");
    await close();
  });

  it("warns when no settlement type is given and eToro could pick either, and stays quiet when it is explicit", async () => {
    const ctx = await connect(cfg, orderHandler(offering("real", "cfd")));
    const implicit = await ctx.prepare("etoro_prepare_open_position", { symbol: "CSPX.L", side: "buy", amountUsd: 10 });
    expect((implicit.warnings as string[]).join(" ")).toContain("No settlementType was given, so eToro chooses it");
    expect((implicit.warnings as string[]).join(" ")).toContain("CFD");
    const explicit = await ctx.prepare("etoro_prepare_open_position", { ...openArgs, amountUsd: 10, settlementType: "real" });
    expect((explicit.warnings as string[]).join(" ")).not.toContain("No settlementType");
    expect(explicit.settlement).toEqual({ requested: "real", offered: ["real", "cfd"] });
    await ctx.close();
  });

  it("says so when the account is only offered one settlement type", async () => {
    const ctx = await connect(cfg, orderHandler());
    const preview = await ctx.prepare("etoro_prepare_open_position", { symbol: "CSPX.L", side: "buy", amountUsd: 10 });
    expect((preview.warnings as string[]).join(" ")).toContain("eToro offers only 'cfd'");
    expect(preview.summary).toContain("cfd (the only one offered)");
    expect(preview.settlement).toEqual({ requested: null, offered: ["cfd"] });
    await ctx.close();
  });

  it("rejects a settlement type the account is not offered, before anything can be executed", async () => {
    const ctx = await connect(cfg, orderHandler());
    const res = await raw(ctx, { symbol: "CSPX.L", side: "buy", amountUsd: 10, settlementType: "real" });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("does not offer settlementType 'real'");
    expect(textOf(res)).toContain("eToro offers cfd");
    expect(ctx.auditLines.join("\n")).not.toContain("prepared");
    expect(ctx.opened).toHaveLength(0); // no approval page was opened
    expect(ctx.calls.some((c) => c.path.endsWith("/costs"))).toBe(false);
    expect(orderCalls(ctx.calls)).toHaveLength(0);
    await ctx.close();
  });

  it("only compares settlement types with the direction being opened", async () => {
    // Real is offered long only; a short must not be accepted on the strength of the long configuration.
    const longOnlyReal: Handler = (call) =>
      call.path.endsWith("/eligibility")
        ? { json: { eligibilities: [{ instrumentId: 1234, leverageConfigs: [{ settlementType: "real", direction: "long" }, { settlementType: "cfd", direction: "short" }] }] } }
        : undefined;
    const ctx = await connect(cfg, orderHandler(longOnlyReal));
    const short = await raw(ctx, { symbol: "CSPX.L", side: "sellShort", amountUsd: 10, settlementType: "real", leverage: 1, stopLossRate: 900 });
    expect(short.isError).toBe(true);
    expect(textOf(short)).toContain("(short)");
    await ctx.close();
  });

  it("does not block when eligibility is unavailable", async () => {
    const down: Handler = (call) => (call.path.endsWith("/eligibility") ? { status: 500, json: { title: "boom" } } : undefined);
    const ctx = await connect(cfg, orderHandler(down));
    const preview = await ctx.prepare("etoro_prepare_open_position", { symbol: "CSPX.L", side: "buy", amountUsd: 10, settlementType: "real" });
    expect(preview.settlement).toEqual({ requested: "real", offered: null });
    expect((preview.warnings as string[]).join(" ")).toContain("Eligibility check unavailable");
    await ctx.close();
  });

  it("flags the regular-trading-hours variant of an instrument", async () => {
    const rth: Handler = (call) =>
      call.path === "/api/v2/market-data/instruments"
        ? { json: { items: [{ instrumentId: 1234, symbol: "AAPL.RTH", displayName: "Apple", type: "Stocks" }] } }
        : undefined;
    const ctx = await connect(cfg, orderHandler(rth));
    const preview = await ctx.prepare("etoro_prepare_open_position", { symbol: "AAPL.RTH", side: "buy", amountUsd: 10, settlementType: "cfd" });
    expect((preview.warnings as string[]).join(" ")).toContain("regular-trading-hours variant");
    await ctx.close();

    const other = await connect(cfg, orderHandler());
    const plain = await other.prepare("etoro_prepare_open_position", { symbol: "CSPX.L", side: "buy", amountUsd: 10, settlementType: "cfd" });
    expect((plain.warnings as string[]).join(" ")).not.toContain("regular-trading-hours");
    await other.close();
  });

  it("rejects orders above the per-order exposure cap (amount x leverage)", async () => {
    const ctx = await connect(cfg, orderHandler());
    const big = await raw(ctx, { ...openArgs, amountUsd: 500 });
    expect(big.isError).toBe(true);
    expect(textOf(big)).toContain("ETORO_MAX_ORDER_USD");
    const levered = await raw(ctx, { ...openArgs, amountUsd: 60, leverage: 2, stopLossRate: 700 });
    expect(levered.isError).toBe(true);
    expect(orderCalls(ctx.calls)).toHaveLength(0);
    expect(ctx.opened).toHaveLength(0);
    await ctx.close();
  });

  it("units-based orders are valued with the market ask for the cap", async () => {
    const ctx = await connect(cfg, orderHandler());
    // 1 unit at ask 846.35 is far above the 100 USD cap.
    const res = await raw(ctx, { symbol: "CSPX.L", side: "buy", units: 1 });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("ETORO_MAX_ORDER_USD");
    await ctx.close();
  });

  it("validates cross-field rules", async () => {
    const ctx = await connect(cfg, orderHandler());
    expect((await raw(ctx, { ...openArgs, units: 1 })).isError).toBe(true);
    expect(textOf(await raw(ctx, { ...openArgs, side: "sellShort" }))).toContain("stopLossRate");
    expect((await raw(ctx, { side: "buy", amountUsd: 10 })).isError).toBe(true);
    expect(orderCalls(ctx.calls)).toHaveLength(0);
    await ctx.close();
  });

  it("ambiguous symbols ask for an instrumentId", async () => {
    const ctx = await connect(cfg, orderHandler());
    const res = await raw(ctx, { symbol: "AMBIG", side: "buy", amountUsd: 10 });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("instrumentId");
    await ctx.close();
  });

  it("closing sends the documented body for the right environment, after the user executes", async () => {
    const handler = orderHandler((call) =>
      call.method === "POST" && call.path.includes("market-close-orders")
        ? { json: { orderForClose: { orderID: 5 }, token: "t" } }
        : call.path.endsWith("/portfolio")
          ? { json: { clientPortfolio: { positions: [{ positionID: 777, instrumentID: 1234, units: 2 }] } } }
          : undefined,
    );
    const ctx = await connect(cfg, handler);
    const prep = await ctx.prepare("etoro_prepare_close_position", { positionId: 777, instrumentId: 1234 });
    expect((prep.matchedPosition as { positionID: number }).positionID).toBe(777);
    expect(ctx.calls.some((c) => c.path.includes("market-close-orders"))).toBe(false);
    await ctx.execute(prep);
    const sent = ctx.calls.find((c) => c.path.includes("market-close-orders"))!;
    expect(sent.path).toBe("/api/v1/trading/execution/demo/market-close-orders/positions/777");
    expect(sent.body).toEqual({ InstrumentID: 1234, UnitsToDeduct: null });
    await ctx.close();
  });

  describe("changing a stop loss or take profit", () => {
    const portfolio = (call: RecordedCall) =>
      call.path.endsWith("/portfolio")
        ? { json: { clientPortfolio: { positions: [{ positionID: 777, instrumentID: 1234, isBuy: true, units: 2, openRate: 800, leverage: 1, stopLossRate: 0.0001, isNoStopLoss: true, takeProfitRate: 999999, isNoTakeProfit: true }] } } }
        : call.method === "PATCH"
          ? { json: { operationId: "op-1", positionId: 777, referenceId: "r-1" } }
          : undefined;

    it("previews, then sends the documented PATCH only when the user executes", async () => {
      const ctx = await connect(cfg, orderHandler(portfolio));
      const prep = await ctx.prepare("etoro_prepare_modify_position", { positionId: 777, stopLossRate: 780, takeProfitRate: 900 });
      expect(prep.request).toEqual({ stopLossRate: 780, takeProfitRate: 900 });
      expect((prep.warnings as string[]).join(" ")).toContain("moves funds from your balance");
      expect(ctx.calls.some((c) => c.method === "PATCH")).toBe(false);
      const page = await (await fetch(prep.approval.url!)).text();
      expect(page).toContain("CSPX.L");
      expect(page).toContain("Current stop loss");
      expect(page).toContain("780");
      await ctx.execute(prep);
      const sent = ctx.calls.find((c) => c.method === "PATCH")!;
      expect(sent.path).toBe("/api/v2/trading/demo/positions/777");
      expect(sent.body).toEqual({ stopLossRate: 780, takeProfitRate: 900 });
      expect(await ctx.status(prep)).toMatchObject({ status: "executed", result: { operationId: "op-1" } });
      await ctx.close();
    });

    it("warns when a stop loss or take profit is on the wrong side of the price", async () => {
      const ctx = await connect(cfg, orderHandler(portfolio));
      const prep = await ctx.prepare("etoro_prepare_modify_position", { positionId: 777, stopLossRate: 900, takeProfitRate: 700 });
      const text = (prep.warnings as string[]).join(" ");
      expect(text).toContain("new stop loss 900 is on the wrong side");
      expect(text).toContain("new take profit 700 is on the wrong side");
      await ctx.close();
    });

    it("can remove a take profit or switch the stop to trailing", async () => {
      const ctx = await connect(cfg, orderHandler(portfolio));
      const clear = await ctx.prepare("etoro_prepare_modify_position", { positionId: 777, clearTakeProfit: true });
      expect(clear.request).toEqual({ clearTakeProfit: true });
      const trailing = await ctx.prepare("etoro_prepare_modify_position", { positionId: 777, stopLossRate: 780, stopLossType: "trailing" });
      expect(trailing.request).toEqual({ stopLossRate: 780, stopLossType: "trailing" });
      await ctx.close();
    });

    it("validates the combination, and refuses a position that is not open", async () => {
      const ctx = await connect(cfg, orderHandler(portfolio));
      const call = async (args: Record<string, unknown>) =>
        (await ctx.client.callTool({ name: "etoro_prepare_modify_position", arguments: args })) as { isError?: boolean; content: Array<{ text?: string }> };
      expect(textOf(await call({ positionId: 777 }))).toContain("at least one");
      expect(textOf(await call({ positionId: 777, clearStopLoss: true, stopLossRate: 700 }))).toContain("clearStopLoss cannot be combined");
      expect(textOf(await call({ positionId: 777, clearTakeProfit: true, takeProfitRate: 900 }))).toContain("clearTakeProfit cannot be combined");
      const missing = await call({ positionId: 1, stopLossRate: 700 });
      expect(missing.isError).toBe(true);
      expect(textOf(missing)).toContain("was not found among the open positions");
      expect(ctx.opened).toHaveLength(0);
      expect(ctx.calls.some((c) => c.method === "PATCH")).toBe(false);
      await ctx.close();
    });
  });

  it("cancelling goes through the same preview and the user's Execute", async () => {
    const handler = orderHandler((call) => (call.method === "DELETE" ? { json: { token: "t" } } : undefined));
    const ctx = await connect(cfg, handler);
    const prep = await ctx.prepare("etoro_prepare_cancel_order", { orderId: 55 });
    expect(ctx.calls.some((c) => c.method === "DELETE")).toBe(false);
    await ctx.execute(prep);
    const del = ctx.calls.find((c) => c.method === "DELETE")!;
    expect(del.path).toBe("/api/v2/trading/execution/demo/orders/55");
    await ctx.close();
  });

  it("watchlist changes are proposals too: nothing is sent until the user executes", async () => {
    const handler = orderHandler((call) => (call.path === "/api/v1/watchlists" && call.method === "POST" ? { json: { id: "w1" } } : undefined));
    const ctx = await connect(cfg, handler);
    const prep = await ctx.prepare("etoro_prepare_create_watchlist", { name: "Prueba" });
    expect(ctx.calls.some((c) => c.path.startsWith("/api/v1/watchlists"))).toBe(false);
    const page = await (await fetch(prep.approval.url!)).text();
    expect(page).toContain("Prueba");
    await ctx.execute(prep);
    const sent = ctx.calls.find((c) => c.path === "/api/v1/watchlists")!;
    expect(sent.method).toBe("POST");
    expect(sent.query).toEqual({ name: "Prueba", type: "Static" });
    await ctx.close();
  });

  it("watchlist item changes show instrument names on the page and use the documented bodies", async () => {
    const handler = orderHandler((call) => (call.path.startsWith("/api/v1/watchlists/") ? { json: {} } : undefined));
    const ctx = await connect(cfg, handler);
    const add = await ctx.prepare("etoro_prepare_add_watchlist_items", { watchlistId: "w1", instrumentIds: [1234] });
    expect(await (await fetch(add.approval.url!)).text()).toContain("CSPX.L");
    await ctx.execute(add);
    const sentAdd = ctx.calls.find((c) => c.method === "POST" && c.path === "/api/v1/watchlists/w1/items")!;
    expect(sentAdd.body).toEqual([{ itemId: 1234, itemType: "Instrument" }]);
    const remove = await ctx.prepare("etoro_prepare_remove_watchlist_items", { watchlistId: "w1", instrumentIds: [1234] });
    const del = await ctx.prepare("etoro_prepare_delete_watchlist", { watchlistId: "w1" });
    expect(ctx.calls.some((c) => c.method === "DELETE")).toBe(false);
    await ctx.execute(remove);
    await ctx.execute(del);
    expect(ctx.calls.filter((c) => c.method === "DELETE").map((c) => c.path)).toEqual(["/api/v1/watchlists/w1/items", "/api/v1/watchlists/w1"]);
    await ctx.close();
  });

  it("enforces the per-minute write limit when the user executes; a blocked action stays pending", async () => {
    const limited = baseCfg({ enableWrite: true, maxWritesPerMinute: 1 });
    const ctx = await connect(limited, orderHandler());
    const first = await ctx.prepare("etoro_prepare_open_position", openArgs);
    const second = await ctx.prepare("etoro_prepare_open_position", openArgs);
    await ctx.execute(first);
    const blocked = await ctx.execute(second);
    expect(blocked.status).toBe(200);
    expect(blocked.text).toContain("Write rate limit reached");
    expect(orderCalls(ctx.calls)).toHaveLength(1);
    expect(await ctx.status(second)).toMatchObject({ status: "pending" });
    await ctx.close();
  });

  it("a failed order is reported on the page and by the status tool, without keys", async () => {
    const handler = orderHandler((call) =>
      call.method === "POST" && call.path.endsWith("/orders") ? { status: 400, json: { title: "Bad", detail: `no ${API_KEY}` } } : undefined,
    );
    const ctx = await connect(cfg, handler);
    const prep = await ctx.prepare("etoro_prepare_open_position", openArgs);
    await ctx.execute(prep);
    const status = await ctx.status(prep);
    expect(status.status).toBe("failed");
    expect(JSON.stringify(status)).not.toContain(API_KEY);
    expect(await (await fetch(prep.approval.url!)).text()).toContain("Failed");
    await ctx.close();
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

  it("trade history goes to the documented demo and real routes", async () => {
    for (const [env, path] of [["demo", "/api/v1/trading/info/trade/demo/history"], ["real", "/api/v1/trading/info/trade/history"]] as const) {
      const { client, calls, close } = await connect(baseCfg({ env }), () => ({ json: [] }));
      await client.callTool({ name: "etoro_get_trade_history", arguments: { minDate: "2026-09-01" } });
      expect(calls[0]!.path).toBe(path);
      expect(calls[0]!.query).toEqual({ minDate: "2026-09-01" });
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

describe("etoro_check_connection", () => {
  const check = async (cfg = baseCfg(), handler: Handler = orderHandler()) => {
    const ctx = await connect(cfg, handler);
    const res = await ctx.client.callTool({ name: "etoro_check_connection", arguments: {} });
    return { ...ctx, res, out: JSON.parse(textOf(res)) };
  };

  it("proves a demo key reaches the demo account", async () => {
    const { out, calls, res, close } = await check();
    expect(out.connected).toBe(true);
    expect(out.environment).toBe("demo");
    expect(out.keyIsFor).toEqual(["demo"]);
    expect(out.dataBelongsTo).toBe("demo");
    expect(out.environmentVerified).toBe(true);
    expect(out.warnings).toEqual([]);
    expect(out.advice.join(" ")).toContain("Read-only key");
    expect(out.advice.join(" ")).toContain("IP address");
    expect(out.account).toEqual({ username: "tester", gcid: "***111", demoCid: "***001", realCid: "***001" });
    expect(textOf(res)).not.toContain("9000111");
    expect(calls.every((c) => c.method === "GET")).toBe(true);
    await close();
  });

  it("cross-checks the other environment: a Demo key is rejected on the real route", async () => {
    const { out, close } = await check();
    expect(out.otherEnvironmentRoute).toEqual({ environment: "real", answered: false, sameAccountAsConfigured: null, belongsTo: null });
    expect(out.environmentVerified).toBe(true);
    await close();
  });

  it("flags routes that return the same account for both environments", async () => {
    const handler = (call: RecordedCall) =>
      call.path === "/api/v1/trading/info/aggregate-portfolio" ? { json: { cid: ME.demoCid } } : orderHandler()(call);
    const { out, close } = await check(baseCfg(), handler);
    expect(out.otherEnvironmentRoute.sameAccountAsConfigured).toBe(true);
    expect(out.environmentVerified).toBe(false);
    expect(out.warnings.join(" ")).toContain("cannot be told apart");
    await close();
  });

  it("notes when the other route answers although the key is not scoped for it", async () => {
    const handler = (call: RecordedCall) =>
      call.path === "/api/v1/trading/info/aggregate-portfolio" ? { json: { cid: ME.realCid } } : orderHandler()(call);
    const { out, close } = await check(baseCfg(), handler);
    expect(out.otherEnvironmentRoute).toEqual({ environment: "real", answered: true, sameAccountAsConfigured: false, belongsTo: "real" });
    expect(out.warnings.join(" ")).toContain("scope enforcement could not be confirmed");
    await close();
  });

  it("a key with demo AND real scopes is still verified for demo, with a loud privilege note", async () => {
    const both = { ...ME, scopes: ["etoro-public:trade.demo:read", "etoro-public:trade.demo:write", "etoro-public:trade.real:read", "etoro-public:trade.real:write", "etoro-public:feed:write"] };
    const handler = (call: RecordedCall) =>
      call.path === "/api/v1/me"
        ? { json: both }
        : call.path === "/api/v1/trading/info/aggregate-portfolio"
          ? { json: { cid: ME.realCid } }
          : orderHandler()(call);
    const { out, close } = await check(baseCfg(), handler);
    expect(out.keyIsFor).toEqual(["demo", "real"]);
    expect(out.dataBelongsTo).toBe("demo");
    expect(out.otherEnvironmentRoute).toEqual({ environment: "real", answered: true, sameAccountAsConfigured: false, belongsTo: "real" });
    expect(out.warnings).toEqual([]);
    expect(out.environmentVerified).toBe(true);
    expect(out.advice.join(" ")).toContain("ALSO place orders in the REAL environment");
    expect(out.advice.join(" ")).toContain("Strict key scope is off");
    expect(out.mode.strictKeyScope).toBe(false);
    await close();
  });

  it("warns loudly when the demo route serves the REAL account", async () => {
    const handler = (call: RecordedCall) =>
      call.path === "/api/v1/trading/info/demo/aggregate-portfolio" ? { json: { cid: ME.realCid } } : orderHandler()(call);
    const { out, close } = await check(baseCfg(), handler);
    expect(out.dataBelongsTo).toBe("real");
    expect(out.environmentVerified).toBe(false);
    expect(out.warnings.join(" ")).toContain("REAL account");
    await close();
  });

  it("warns when the key's scopes are for the other environment", async () => {
    const handler = (call: RecordedCall) =>
      call.path === "/api/v1/me" ? { json: { ...ME, scopes: ["etoro-public:real:read"] } } : orderHandler()(call);
    const { out, close } = await check(baseCfg(), handler);
    expect(out.keyIsFor).toEqual(["real"]);
    expect(out.environmentVerified).toBe(false);
    expect(out.warnings.join(" ")).toContain("scopes are for: real");
    await close();
  });

  it("works when eToro reports no scopes, relying on the account owner", async () => {
    const handler = (call: RecordedCall) => (call.path === "/api/v1/me" ? { json: { ...ME, scopes: [] } } : orderHandler()(call));
    const { out, close } = await check(baseCfg(), handler);
    expect(out.dataBelongsTo).toBe("demo");
    expect(out.environmentVerified).toBe(true);
    expect(out.warnings[0]).toContain("did not report the key's scopes");
    await close();
  });

  it("reports failed authentication without leaking keys and skips the rest", async () => {
    const handler = () => ({ status: 401, json: { title: "Unauthorized", detail: `bad ${API_KEY} ${USER_KEY}` } });
    const { res, out, calls, close } = await check(baseCfg(), handler);
    expect(out.connected).toBe(false);
    expect(out.account).toBeNull();
    expect(out.checks[0].detail).toContain("Authentication failed");
    expect(out.checks[1].detail).toContain("Skipped");
    expect(textOf(res)).not.toContain(API_KEY);
    expect(textOf(res)).not.toContain(USER_KEY);
    expect(calls).toHaveLength(1);
    await close();
  });
});

describe("environment guard on trading previews", () => {
  const cfg = baseCfg({ enableWrite: true });
  const prepare = (client: Awaited<ReturnType<typeof connect>>["client"]) =>
    client.callTool({ name: "etoro_prepare_open_position", arguments: openArgs });
  const withMe = (me: object) => (call: RecordedCall) => (call.path === "/api/v1/me" ? { json: me } : orderHandler()(call));

  it("blocks a key whose scopes are only for the other environment", async () => {
    const { client, calls, close } = await connect(cfg, withMe({ ...ME, scopes: ["etoro-public:real:read", "etoro-public:real:write"] }));
    const res = await prepare(client);
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("does not have Write permission for the demo environment");
    expect(textOf(res)).toContain("real environment");
    expect(calls.some((c) => c.path.includes("market-data") || c.path.endsWith("/costs"))).toBe(false);
    await close();
  });

  it("blocks a read-only key", async () => {
    const { client, close } = await connect(cfg, withMe({ ...ME, scopes: ["etoro-public:demo:read"] }));
    const res = await prepare(client);
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("Write permission");
    await close();
  });

  it("blocks when the demo route answers with the real account", async () => {
    const handler = (call: RecordedCall) =>
      call.path === "/api/v1/trading/info/demo/aggregate-portfolio" ? { json: { cid: ME.realCid } } : orderHandler()(call);
    const { client, calls, close } = await connect(cfg, handler);
    const res = await prepare(client);
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("REAL account");
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
    await close();
  });

  it("fails closed when the identity call fails", async () => {
    const handler = (call: RecordedCall) => (call.path === "/api/v1/me" ? { status: 500, json: { title: "boom" } } : orderHandler()(call));
    const { client, close } = await connect(cfg, handler);
    const res = await prepare(client);
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("Could not verify");
    await close();
  });

  it("with no scopes reported, allows only if the account owner proves the environment", async () => {
    const noScopes = (extra?: Handler) => (call: RecordedCall) =>
      call.path === "/api/v1/me" ? { json: { ...ME, scopes: [] } } : (extra?.(call) ?? orderHandler()(call));
    const ok1 = await connect(cfg, noScopes());
    expect((await prepare(ok1.client)).isError).toBeFalsy();
    await ok1.close();
    const inconclusive = await connect(
      cfg,
      noScopes((c) => (c.path === "/api/v1/trading/info/demo/aggregate-portfolio" ? { json: { cid: 424242 } } : undefined)),
    );
    const res = await prepare(inconclusive.client);
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("could not be verified");
    await inconclusive.close();
  });

  it("strict key scope refuses keys that can also write in the other environment", async () => {
    const both = { ...ME, scopes: ["etoro-public:trade.demo:write", "etoro-public:trade.real:write"] };
    const handler = (call: RecordedCall) => (call.path === "/api/v1/me" ? { json: both } : orderHandler()(call));
    const strict = await connect(baseCfg({ enableWrite: true, strictKeyScope: true }), handler);
    const res = await prepare(strict.client);
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("ETORO_STRICT_KEY_SCOPE");
    await strict.close();
    const relaxed = await connect(baseCfg({ enableWrite: true, strictKeyScope: false }), handler);
    expect((await prepare(relaxed.client)).isError).toBeFalsy();
    await relaxed.close();
  });

  it("a real-environment setup refuses a key that can also write in demo (strict is the default there)", async () => {
    const { loadConfig } = await import("../src/config.js");
    const realCfg = loadConfig({
      ETORO_API_KEY: "api-key-value-1",
      ETORO_USER_KEY: "user-key-value-2",
      ETORO_ENV: "real",
      ETORO_ENABLE_WRITE: "true",
      ETORO_ALLOW_REAL_WRITE: "true",
    });
    expect(realCfg.strictKeyScope).toBe(true);
    const both = { ...ME, scopes: ["etoro-public:trade.demo:write", "etoro-public:trade.real:write"] };
    const handler = (call: RecordedCall) =>
      call.path === "/api/v1/me"
        ? { json: both }
        : call.path === "/api/v1/trading/info/aggregate-portfolio"
          ? { json: { cid: ME.realCid } }
          : orderHandler()(call);
    const strict = await connect(realCfg, handler);
    const res = await prepare(strict.client);
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("can also write in the demo environment");
    await strict.close();
    const realOnly = await connect(realCfg, (call) =>
      call.path === "/api/v1/me" ? { json: { ...ME, scopes: ["etoro-public:trade.real:read", "etoro-public:trade.real:write"] } } : handler(call),
    );
    expect((await prepare(realOnly.client)).isError).toBeFalsy();
    await realOnly.close();
  });

  it("verifies once and caches the result", async () => {
    const { client, calls, close } = await connect(cfg, orderHandler());
    await prepare(client);
    await prepare(client);
    expect(calls.filter((c) => c.path === "/api/v1/me")).toHaveLength(1);
    await close();
  });
});
