import { describe, expect, it } from "vitest";
import { type DemoCloseOptions, type DemoOrderOptions, parseCli, pressExecute, runDemoClose, runDemoOrder } from "../scripts/demo-order.mjs";
import { type Handler, type RecordedCall, ME, baseCfg, connect, orderHandler, pressButton, textOf } from "./helpers.js";

const cfg = baseCfg({ enableWrite: true });

/** Demo answers for the order lifecycle on top of the standard order handler. */
const lifecycle = (opts: { executes?: boolean; status?: object } = {}): Handler => {
  const executes = opts.executes ?? true;
  return orderHandler((call: RecordedCall) => {
    if (call.path === "/api/v2/trading/info/demo/orders:lookup") {
      return {
        json: {
          orderId: 99,
          status: opts.status ?? { id: executes ? 2 : 1, name: executes ? "Executed" : "Pending" },
          positionExecutions: executes ? [{ positionId: 555, units: 0.1 }] : [],
        },
      };
    }
    if (call.path === "/api/v1/trading/info/demo/portfolio") {
      return { json: { clientPortfolio: { positions: [{ positionID: 555, instrumentID: 1234, units: 0.1, openRate: 846.3, amount: 50, leverage: 1, settlementTypeID: 1, isSettled: true }] } } };
    }
    if (call.method === "POST" && call.path.includes("market-close-orders")) {
      return { json: { orderForClose: { orderID: 100 }, token: "t-close" } };
    }
    return undefined;
  });
};

async function run(handler: Handler, opts: Partial<DemoOrderOptions>, answers: boolean[] = [true, true]) {
  const ctx = await connect(cfg, handler);
  const lines: string[] = [];
  const questions: string[] = [];
  const result = await runDemoOrder(
    {
      call: async (name, args) => {
        const res = await ctx.client.callTool({ name, arguments: args });
        return { isError: Boolean(res.isError), text: textOf(res) };
      },
      confirm: async (q) => {
        questions.push(q);
        return answers.shift() ?? false;
      },
      approve: async (url) => (await pressButton(url, "execute")).status,
      log: (l) => lines.push(l),
      sleep: async () => {},
    },
    { amountUsd: 50, pollMs: 0, ...opts, symbol: opts.symbol ?? "CSPX.L" },
  );
  return { ...ctx, result, lines, questions, orderPosts: ctx.calls.filter((c) => c.method === "POST" && c.path.endsWith("/orders")) };
}

describe("demo order script flow", () => {
  it("executes through the real approval page with the script's own Execute press", async () => {
    const ctx = await connect(cfg, lifecycle());
    const lines: string[] = [];
    const result = await runDemoOrder(
      {
        call: async (name, args) => {
          const res = await ctx.client.callTool({ name, arguments: args });
          return { isError: Boolean(res.isError), text: textOf(res) };
        },
        confirm: async () => true,
        approve: (url) => pressExecute(url),
        log: (l) => lines.push(l),
        sleep: async () => {},
      },
      { amountUsd: 50, pollMs: 0, symbol: "CSPX.L" },
    );
    expect(result).toMatchObject({ ok: true, stage: "executed", orderId: 99 });
    expect(ctx.calls.filter((c) => c.method === "POST" && c.path.endsWith("/orders"))).toHaveLength(1);
    await ctx.close();
  });

  it("stops with a clear message when the server does not return the approval address", async () => {
    const ctx = await connect(baseCfg({ enableWrite: true, showApprovalUrl: false }), lifecycle());
    const lines: string[] = [];
    const result = await runDemoOrder(
      {
        call: async (name, args) => {
          const res = await ctx.client.callTool({ name, arguments: args });
          return { isError: Boolean(res.isError), text: textOf(res) };
        },
        confirm: async () => true,
        approve: (url) => pressExecute(url),
        log: (l) => lines.push(l),
        sleep: async () => {},
      },
      { amountUsd: 50, pollMs: 0, symbol: "CSPX.L" },
    );
    expect(result).toMatchObject({ ok: false, stage: "execute" });
    expect(lines.join("\n")).toContain("ETORO_SHOW_APPROVAL_URL");
    expect(ctx.calls.filter((c) => c.method === "POST" && c.path.endsWith("/orders"))).toHaveLength(0);
    await ctx.close();
  });

  it("previews, asks, executes on the DEMO route and follows the order", async () => {
    const { result, lines, questions, orderPosts, close } = await run(lifecycle(), {});
    expect(result).toMatchObject({ ok: true, stage: "executed", orderId: 99, positionId: 555 });
    expect(questions).toEqual(["Execute this DEMO order now?"]);
    expect(orderPosts).toHaveLength(1);
    expect(orderPosts[0]!.path).toBe("/api/v2/trading/execution/demo/orders");
    const out = lines.join("\n");
    expect(out).toContain("Connection [OK]");
    expect(out).toContain("Position opened: id 555");
    await close();
  });

  it("sends nothing when the user says no", async () => {
    const { result, orderPosts, close } = await run(lifecycle(), {}, [false]);
    expect(result).toMatchObject({ ok: false, stage: "declined" });
    expect(orderPosts).toHaveLength(0);
    await close();
  });

  it("--yes skips the question; --close previews and closes the position on the demo route", async () => {
    const { result, questions, calls, close } = await run(lifecycle(), { yes: true, close: true });
    expect(result).toMatchObject({ ok: true, stage: "closed", positionId: 555 });
    expect(questions).toHaveLength(0);
    const closing = calls.find((c) => c.path.includes("market-close-orders"))!;
    expect(closing.path).toBe("/api/v1/trading/execution/demo/market-close-orders/positions/555");
    expect(closing.body).toEqual({ InstrumentID: 1234, UnitsToDeduct: null });
    await close();
  });

  it("asks again before closing and leaves the position open if declined", async () => {
    const { result, questions, calls, close } = await run(lifecycle(), { close: true }, [true, false]);
    expect(questions).toHaveLength(2);
    expect(result).toMatchObject({ ok: true, stage: "executed", positionId: 555 });
    expect(calls.some((c) => c.path.includes("market-close-orders") && c.method === "POST")).toBe(false);
    await close();
  });

  it("reports an order that has not produced a position yet, with how to check it later", async () => {
    const { result, lines, close } = await run(lifecycle({ executes: false }), { pollAttempts: 3 });
    expect(result).toMatchObject({ ok: true, stage: "executed", orderId: 99 });
    expect(result.positionId).toBeUndefined();
    expect(lines.join("\n")).toContain("etoro_get_order");
    await close();
  });

  it("stops polling on a rejected order", async () => {
    const { lines, calls, close } = await run(lifecycle({ executes: false, status: { id: 9, name: "Rejected", errorCode: 123, errorMessage: "nope" } }), { pollAttempts: 5 });
    expect(calls.filter((c) => c.path.endsWith("/orders:lookup"))).toHaveLength(1);
    expect(lines.join("\n")).toContain("Rejected");
    await close();
  });

  it("refuses to go on when the environment cannot be verified as demo", async () => {
    const handler: Handler = (call) =>
      call.path === "/api/v1/trading/info/demo/aggregate-portfolio" ? { json: { cid: ME.realCid } } : lifecycle()(call);
    const { result, orderPosts, lines, close } = await run(handler, {});
    expect(result).toMatchObject({ ok: false, stage: "connection" });
    expect(orderPosts).toHaveLength(0);
    expect(lines.join("\n")).toContain("no order was prepared");
    await close();
  });

  it("surfaces a preview refusal (cap) without executing", async () => {
    const { result, orderPosts, lines, close } = await run(lifecycle(), { amountUsd: 5000 });
    expect(result).toMatchObject({ ok: false, stage: "preview" });
    expect(orderPosts).toHaveLength(0);
    expect(lines.join("\n")).toContain("ETORO_MAX_ORDER_USD");
    await close();
  });
});

describe("order follow-up details", () => {
  it("prints the execution details and the settlement fields of the new position", async () => {
    const { lines, close } = await run(lifecycle(), {});
    const out = lines.join("\n");
    expect(out).toContain("Execution details:");
    expect(out).toContain("In your portfolio: CSPX.L");
    expect(out).toContain("settlementTypeID 1 | isSettled true");
    await close();
  });

  it("treats the 404 right after placing an order as 'not registered yet'", async () => {
    let lookups = 0;
    const handler: Handler = (call) => {
      if (call.path === "/api/v2/trading/info/demo/orders:lookup" && ++lookups === 1) return { status: 404, json: { title: "Order category not found" } };
      return lifecycle()(call);
    };
    const { result, lines, close } = await run(handler, {});
    expect(result.positionId).toBe(555);
    expect(lines.join("\n")).toContain("not registered yet");
    expect(lines.join("\n")).not.toContain("eToro API 404");
    await close();
  });
});

async function runClose(handler: Handler, opts: Partial<DemoCloseOptions>, answers: boolean[] = [true]) {
  const ctx = await connect(cfg, handler);
  const lines: string[] = [];
  const questions: string[] = [];
  const result = await runDemoClose(
    {
      call: async (name, args) => {
        const res = await ctx.client.callTool({ name, arguments: args });
        return { isError: Boolean(res.isError), text: textOf(res) };
      },
      confirm: async (q) => {
        questions.push(q);
        return answers.shift() ?? false;
      },
      approve: async (url) => (await pressButton(url, "execute")).status,
      log: (l) => lines.push(l),
      sleep: async () => {},
    },
    { positionId: 555, pollMs: 0, ...opts },
  );
  return { ...ctx, result, lines, questions };
}

describe("demo close script flow", () => {
  /** Breakdown shows the position until the close order has been posted, then it disappears. */
  const closing = (): Handler => {
    let closed = false;
    return (call) => {
      if (call.method === "POST" && call.path.includes("market-close-orders")) {
        closed = true;
        return { json: { orderForClose: { orderID: 100 }, token: "t" } };
      }
      if (call.path === "/api/v1/trading/info/demo/portfolio" && closed) return { json: { clientPortfolio: { positions: [] } } };
      return lifecycle()(call);
    };
  };

  it("finds the instrument from the open position, previews, asks, closes on the demo route and verifies", async () => {
    const { result, lines, questions, calls, close } = await runClose(closing(), {});
    expect(result).toMatchObject({ ok: true, stage: "closed", positionId: 555 });
    expect(questions).toEqual(["Close this DEMO position now?"]);
    const closeCall = calls.find((c) => c.path.includes("market-close-orders"))!;
    expect(closeCall.path).toBe("/api/v1/trading/execution/demo/market-close-orders/positions/555");
    expect(closeCall.body).toEqual({ InstrumentID: 1234, UnitsToDeduct: null });
    expect(lines.join("\n")).toContain("no longer open");
    await close();
  });

  it("sends nothing if declined, and stops if the position is not open", async () => {
    const declined = await runClose(closing(), {}, [false]);
    expect(declined.result).toMatchObject({ ok: false, stage: "declined" });
    expect(declined.calls.some((c) => c.path.includes("market-close-orders") && c.method === "POST")).toBe(false);
    await declined.close();
    const missing = await runClose(closing(), { positionId: 999 });
    expect(missing.result).toMatchObject({ ok: false, stage: "position" });
    expect(missing.calls.some((c) => c.path.includes("market-close-orders") && c.method === "POST")).toBe(false);
    await missing.close();
  });

  it("reports a position still listed after the checks, with how to retry", async () => {
    const stuck: Handler = (call) =>
      call.method === "POST" && call.path.includes("market-close-orders") ? { json: { orderForClose: {}, token: "t" } } : lifecycle()(call);
    const { result, lines, close } = await runClose(stuck, { pollAttempts: 2 });
    expect(result).toMatchObject({ ok: true, stage: "closing" });
    expect(lines.join("\n")).toContain("--close-position 555");
    await close();
  });
});

describe("command line", () => {
  it("accepts -y and --yes, and nothing else, as auto-confirmation", () => {
    expect(parseCli(["--symbol", "AAPL", "-y"]).yes).toBe(true);
    expect(parseCli(["--yes"]).yes).toBe(true);
    expect(parseCli(["--symbol", "AAPL", "--amount", "50"]).yes).toBe(false);
    expect(parseCli(["--close"]).yes).toBe(false);
    expect(parseCli(["--symbol", "-yes"]).yes).toBe(false);
  });

  it("reads option values and flags", () => {
    const cli = parseCli(["--symbol", "CSPX.L", "--amount", "20", "--close", "-y"]);
    expect(cli.value("symbol")).toBe("CSPX.L");
    expect(cli.value("amount")).toBe("20");
    expect(cli.value("settlement")).toBeUndefined();
    expect(cli.flag("close")).toBe(true);
  });
});
