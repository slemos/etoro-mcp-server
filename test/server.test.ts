import { describe, expect, it } from "vitest";
import { API_KEY, ME, USER_KEY, type Handler, type RecordedCall, baseCfg, connect, eligibilityFor, orderHandler, textOf } from "./helpers.js";

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

  const prepare = async (client: Awaited<ReturnType<typeof connect>>["client"], args: Record<string, unknown>) =>
    client.callTool({ name: "etoro_prepare_open_position", arguments: args });
  const offering = (...settlements: Array<"cfd" | "real">): Handler => (call) =>
    call.path.endsWith("/eligibility") ? { json: eligibilityFor(1234, settlements) } : undefined;

  it("warns when no settlement type is given and eToro could pick either, and stays quiet when it is explicit", async () => {
    const { client, close } = await connect(cfg, orderHandler(offering("real", "cfd")), "accept");
    const implicit = JSON.parse(textOf(await prepare(client, { symbol: "CSPX.L", side: "buy", amountUsd: 10 })));
    expect(implicit.warnings.join(" ")).toContain("No settlementType was given, so eToro chooses it");
    expect(implicit.warnings.join(" ")).toContain("CFD");
    const explicit = JSON.parse(textOf(await prepare(client, { ...openArgs, amountUsd: 10, settlementType: "real" })));
    expect(explicit.warnings.join(" ")).not.toContain("No settlementType");
    expect(explicit.settlement).toEqual({ requested: "real", offered: ["real", "cfd"] });
    await close();
  });

  it("says so when the account is only offered one settlement type", async () => {
    const { client, close } = await connect(cfg, orderHandler(), "accept");
    const preview = JSON.parse(textOf(await prepare(client, { symbol: "CSPX.L", side: "buy", amountUsd: 10 })));
    expect(preview.warnings.join(" ")).toContain("eToro offers only 'cfd'");
    expect(preview.summary).toContain("cfd (the only one offered)");
    expect(preview.settlement).toEqual({ requested: null, offered: ["cfd"] });
    await close();
  });

  it("rejects a settlement type the account is not offered, before anything can be confirmed", async () => {
    const { client, calls, auditLines, close } = await connect(cfg, orderHandler(), "accept");
    const res = await prepare(client, { symbol: "CSPX.L", side: "buy", amountUsd: 10, settlementType: "real" });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("does not offer settlementType 'real'");
    expect(textOf(res)).toContain("eToro offers cfd");
    expect(auditLines.join("\n")).not.toContain("prepared");
    expect(calls.some((c) => c.path.endsWith("/costs"))).toBe(false);
    expect(orderCalls(calls)).toHaveLength(0);
    await close();
  });

  it("only compares settlement types with the direction being opened", async () => {
    // Real is offered long only; a short must not be accepted on the strength of the long configuration.
    const longOnlyReal: Handler = (call) =>
      call.path.endsWith("/eligibility")
        ? { json: { eligibilities: [{ instrumentId: 1234, leverageConfigs: [{ settlementType: "real", direction: "long" }, { settlementType: "cfd", direction: "short" }] }] } }
        : undefined;
    const { client, close } = await connect(cfg, orderHandler(longOnlyReal), "accept");
    const short = await prepare(client, { symbol: "CSPX.L", side: "sellShort", amountUsd: 10, settlementType: "real", leverage: 1, stopLossRate: 900 });
    expect(short.isError).toBe(true);
    expect(textOf(short)).toContain("(short)");
    await close();
  });

  it("does not block when eligibility is unavailable", async () => {
    const down: Handler = (call) => (call.path.endsWith("/eligibility") ? { status: 500, json: { title: "boom" } } : undefined);
    const { client, close } = await connect(cfg, orderHandler(down), "accept");
    const preview = JSON.parse(textOf(await prepare(client, { symbol: "CSPX.L", side: "buy", amountUsd: 10, settlementType: "real" })));
    expect(preview.settlement).toEqual({ requested: "real", offered: null });
    expect(preview.warnings.join(" ")).toContain("Eligibility check unavailable");
    await close();
  });

  it("flags the regular-trading-hours variant of an instrument", async () => {
    const rth: Handler = (call) =>
      call.path === "/api/v2/market-data/instruments"
        ? { json: { items: [{ instrumentId: 1234, symbol: "AAPL.RTH", displayName: "Apple", type: "Stocks" }] } }
        : undefined;
    const { client, close } = await connect(cfg, orderHandler(rth), "accept");
    const preview = JSON.parse(textOf(await prepare(client, { symbol: "AAPL.RTH", side: "buy", amountUsd: 10, settlementType: "cfd" })));
    expect(preview.warnings.join(" ")).toContain("regular-trading-hours variant");
    await close();

    const other = await connect(cfg, orderHandler(), "accept");
    const plain = JSON.parse(textOf(await prepare(other.client, { symbol: "CSPX.L", side: "buy", amountUsd: 10, settlementType: "cfd" })));
    expect(plain.warnings.join(" ")).not.toContain("regular-trading-hours");
    await other.close();
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

describe("etoro_check_connection", () => {
  const check = async (cfg = baseCfg(), handler: Handler = orderHandler(), elicit: "accept" | "none" = "accept") => {
    const ctx = await connect(cfg, handler, elicit);
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
    expect(out.client.supportsConfirmationPrompts).toBe(true);
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
