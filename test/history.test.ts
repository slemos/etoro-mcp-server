import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { ProposalStore } from "../src/approval/proposals.js";
import { TicketServer } from "../src/approval/server.js";
import { ConfigError, loadConfig } from "../src/config.js";
import { EtoroApiError } from "../src/errors.js";
import { HistoryDb, type ActionRecord } from "../src/history/db.js";
import { parseHistoryQuery } from "../src/history/query.js";
import { renderCsv } from "../src/history/render.js";
import { dayKey, formatClock, startOfDay } from "../src/history/time.js";
import { createServer } from "../src/server.js";
import { baseCfg, connect, textOf } from "./helpers.js";

const dirs: string[] = [];
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "etoro-history-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const T0 = Date.UTC(2026, 9, 6, 15, 0, 0);

const action = (over: Partial<ActionRecord> = {}): ActionRecord => ({
  id: crypto.randomUUID(),
  env: "demo",
  tool: "open_position",
  summary: "OPEN BUY AAPL | $50",
  rows: [{ label: "Instrument", value: "AAPL" }],
  warnings: [],
  exposureUsd: 50,
  status: "pending",
  createdAt: T0,
  expiresAt: T0 + 600_000,
  ...over,
});

const input = (exposureUsd = 10, run: () => Promise<unknown> = async () => ({ orderId: 7 })) => ({
  tool: "open_position",
  summary: "OPEN BUY X",
  rows: [{ label: "Instrument", value: "X" }],
  exposureUsd,
  run,
});

describe("time helpers", () => {
  it("cuts days at midnight of the configured time zone", () => {
    // 2026-10-06 23:30 in Santiago (UTC-3 in October) is already the 7th in UTC.
    const t = Date.UTC(2026, 9, 7, 2, 30);
    expect(dayKey(t, "UTC")).toBe("2026-10-07");
    expect(dayKey(t, "America/Santiago")).toBe("2026-10-06");
    expect(formatClock(t, "America/Santiago")).toBe("2026-10-06 23:30:00");
  });

  it("finds where a day starts, including across a daylight-saving change", () => {
    expect(new Date(startOfDay("2026-10-06", "UTC")).toISOString()).toBe("2026-10-06T00:00:00.000Z");
    expect(new Date(startOfDay("2026-10-06", "America/Santiago")).toISOString()).toBe("2026-10-06T03:00:00.000Z");
    // Chile moves its clocks forward at the start of the first Sunday of September (2026-09-06).
    expect(new Date(startOfDay("2026-09-07", "America/Santiago")).toISOString()).toBe("2026-09-07T03:00:00.000Z");
    expect(new Date(startOfDay("2026-09-05", "America/Santiago")).toISOString()).toBe("2026-09-05T04:00:00.000Z");
    expect(startOfDay("2026-10-06", "UTC", 1) - startOfDay("2026-10-06", "UTC")).toBe(86_400_000);
  });
});

describe("HistoryDb", () => {
  it("stores actions and finds them by words, ids, filters and dates, newest first", () => {
    const db = new HistoryDb(":memory:", () => T0);
    db.insertAction(action({ id: "a1", summary: "OPEN BUY AAPL | $50", createdAt: T0 - 3 * 86_400_000, orderId: 100200301 }));
    db.insertAction(action({ id: "a2", tool: "close_position", summary: "CLOSE position 400500601", positionId: 400500601, createdAt: T0 - 86_400_000, status: "executed" }));
    db.insertAction(action({ id: "a3", env: "real", tool: "cancel_order", summary: "CANCEL order 99", createdAt: T0, status: "rejected" }));

    expect(db.search().rows.map((r) => r.id)).toEqual(["a3", "a2", "a1"]);
    expect(db.search({ q: "aapl" }).rows.map((r) => r.id)).toEqual(["a1"]);
    expect(db.search({ q: "100200301" }).rows.map((r) => r.id)).toEqual(["a1"]);
    expect(db.search({ q: "400500601" }).rows.map((r) => r.id)).toEqual(["a2"]);
    expect(db.search({ q: "close 400500601" }).rows.map((r) => r.id)).toEqual(["a2"]);
    expect(db.search({ q: "close aapl" }).total).toBe(0);
    expect(db.search({ env: "real" }).rows.map((r) => r.id)).toEqual(["a3"]);
    expect(db.search({ status: "executed" }).rows.map((r) => r.id)).toEqual(["a2"]);
    expect(db.search({ tool: "cancel_order" }).total).toBe(1);
    expect(db.search({ from: T0 - 2 * 86_400_000, to: T0 }).rows.map((r) => r.id)).toEqual(["a2"]);
    const page = db.search({ limit: 2, offset: 1 });
    expect(page.total).toBe(3);
    expect(page.rows.map((r) => r.id)).toEqual(["a2", "a1"]);
    expect(db.tools()).toEqual(["cancel_order", "close_position", "open_position"]);
  });

  it("treats search words literally: wildcards and quotes match nothing special and break nothing", () => {
    const db = new HistoryDb(":memory:", () => T0);
    db.insertAction(action({ id: "a1", summary: "OPEN BUY 100% AAPL" }));
    db.insertAction(action({ id: "a2", summary: "OPEN BUY MSFT" }));
    expect(db.search({ q: "%" }).rows.map((r) => r.id)).toEqual(["a1"]);
    expect(db.search({ q: "O_EN" }).total).toBe(0);
    expect(db.search({ q: "'; DROP TABLE actions; --" }).total).toBe(0);
    expect(db.search({ q: '" OR 1=1 --' }).total).toBe(0);
    expect(db.search().total).toBe(2);
  });

  it("keeps the record across a restart, privately", () => {
    const path = join(tmp(), "nested", "history.sqlite");
    const first = new HistoryDb(path, () => T0);
    first.insertAction(action({ id: "a1", status: "executed", result: { orderId: 5 } }));
    first.recordEvent("demo", { event: "executed", tool: "open_position", actionId: "a1", summary: "x" });
    first.close();

    const second = new HistoryDb(path, () => T0);
    expect(second.get("a1")).toMatchObject({ id: "a1", status: "executed", result: { orderId: 5 }, rows: [{ label: "Instrument", value: "AAPL" }] });
    expect(second.events("a1")).toHaveLength(1);
    expect(second.persistent).toBe(true);
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    second.close();
  });

  it("refuses a database written by a newer version, and never loses it", () => {
    const path = join(tmp(), "history.sqlite");
    new HistoryDb(path).close();
    const raw = new DatabaseSync(path);
    raw.exec("PRAGMA user_version = 99");
    raw.close();
    expect(() => new HistoryDb(path)).toThrow(/newer version/);
  });

  it("settles what a dead process left behind: stale executions fail, overdue pendings expire", () => {
    let t = T0;
    const db = new HistoryDb(":memory:", () => t);
    db.insertAction(action({ id: "run", status: "executing", decidedAt: T0 }));
    db.insertAction(action({ id: "wait", status: "pending", expiresAt: T0 + 600_000 }));
    expect(db.get("run")?.status).toBe("executing");
    t = T0 + 11 * 60_000;
    expect(db.get("run")).toMatchObject({ status: "failed" });
    expect(db.get("run")?.error).toMatch(/Interrupted/);
    expect(db.get("wait")?.status).toBe("expired");
  });

  describe("the daily ledger", () => {
    const reserve = (db: HistoryDb, id: string, over: Partial<Parameters<HistoryDb["reserve"]>[0]> = {}) =>
      db.reserve({ actionId: id, env: "demo", exposureUsd: 100, now: T0, maxUsd: 250, maxWrites: 10, timezone: "UTC", ...over });

    it("stops at the daily exposure cap and at the daily write cap, naming the setting", () => {
      const db = new HistoryDb(":memory:", () => T0);
      reserve(db, "1");
      reserve(db, "2");
      expect(() => reserve(db, "3")).toThrow(/ETORO_MAX_DAILY_USD/);
      expect(db.usage("demo", T0, "UTC")).toMatchObject({ usd: 200, writes: 2 });
      expect(() => reserve(db, "w", { exposureUsd: 0, maxWrites: 2 })).toThrow(/ETORO_MAX_DAILY_WRITES/);
      reserve(db, "4", { exposureUsd: 0 });
      expect(db.usage("demo", T0, "UTC").writes).toBe(3);
    });

    it("counts each environment separately and gives a reservation back when released", () => {
      const db = new HistoryDb(":memory:", () => T0);
      reserve(db, "1", { exposureUsd: 200 });
      reserve(db, "2", { env: "real", exposureUsd: 200 });
      expect(() => reserve(db, "3")).toThrow(PolicyErrorLike);
      db.release("1");
      reserve(db, "3");
      expect(db.usage("demo", T0, "UTC").usd).toBe(100);
      expect(db.usage("real", T0, "UTC").usd).toBe(200);
    });

    it("starts a new day at midnight of the configured time zone", () => {
      const db = new HistoryDb(":memory:", () => T0);
      const lateEvening = Date.UTC(2026, 9, 7, 2, 30); // 23:30 on the 6th in Santiago, already the 7th in UTC
      reserve(db, "1", { now: lateEvening, exposureUsd: 200, timezone: "America/Santiago" });
      expect(db.usage("demo", lateEvening, "America/Santiago").usd).toBe(200);
      expect(db.usage("demo", lateEvening, "UTC").usd).toBe(0);
      const nextMorning = Date.UTC(2026, 9, 7, 4, 0); // 01:00 on the 7th in Santiago
      expect(db.usage("demo", nextMorning, "America/Santiago").usd).toBe(0);
      reserve(db, "2", { now: nextMorning, exposureUsd: 200, timezone: "America/Santiago" });
    });

    it("holds across two processes sharing the file: neither can use what the other already spent", () => {
      const path = join(tmp(), "history.sqlite");
      const desktop = new HistoryDb(path, () => T0);
      const code = new HistoryDb(path, () => T0);
      reserve(desktop, "1", { exposureUsd: 200 });
      expect(() => reserve(code, "2", { exposureUsd: 100 })).toThrow(/ETORO_MAX_DAILY_USD/);
      reserve(code, "3", { exposureUsd: 50 });
      expect(desktop.usage("demo", T0, "UTC")).toMatchObject({ usd: 250, writes: 2 });
      desktop.close();
      code.close();
    });
  });
});

class PolicyErrorLike {
  static [Symbol.hasInstance](err: unknown): boolean {
    return err instanceof Error && err.name === "PolicyError";
  }
}

describe("ProposalStore with the history", () => {
  it("blocks at the daily cap, keeps the action pending, and the cap survives a restart", async () => {
    const path = join(tmp(), "history.sqlite");
    const cfg = baseCfg({ maxDailyUsd: 150, maxSessionUsd: 10_000 });
    const first = new ProposalStore(cfg, () => T0, undefined, undefined, new HistoryDb(path, () => T0));
    expect((await first.execute(first.create(input(100)).id)).outcome).toBe("executed");
    first.db.close();

    // A new process (the server was restarted) still knows what was executed today.
    const second = new ProposalStore(cfg, () => T0, undefined, undefined, new HistoryDb(path, () => T0));
    const p = second.create(input(100));
    const out = await second.execute(p.id);
    expect(out.outcome).toBe("blocked");
    expect(out.message).toMatch(/ETORO_MAX_DAILY_USD/);
    expect(p.status).toBe("pending");
    expect((await second.execute(second.create(input(50)).id)).outcome).toBe("executed");
    second.db.close();
  });

  it("gives the daily allowance back when eToro clearly refuses, but not when the outcome is unknown", async () => {
    const store = new ProposalStore(baseCfg({ maxDailyUsd: 100 }), () => T0);
    const refused = store.create(input(100, async () => Promise.reject(new EtoroApiError("bad request", 400))));
    expect((await store.execute(refused.id)).outcome).toBe("failed");
    expect(store.db.usage("demo", T0, "UTC")).toMatchObject({ usd: 0, writes: 0 });

    // A timeout, a network error or a 5xx may have reached eToro: the order might exist, so it stays counted.
    for (const err of [new EtoroApiError("gateway", 502), new EtoroApiError("timeout", 408), new Error("socket hang up")]) {
      const unknown = store.create(input(10, async () => Promise.reject(err)));
      expect((await store.execute(unknown.id)).outcome).toBe("failed");
    }
    expect(store.db.usage("demo", T0, "UTC")).toMatchObject({ usd: 30, writes: 3 });
    expect((await store.execute(store.create(input(100)).id)).outcome).toBe("blocked");
  });

  it("fails closed when the daily limits cannot be checked", async () => {
    const store = new ProposalStore(baseCfg(), () => T0);
    store.db.close();
    const p = store.create(input());
    let ran = false;
    const q = store.create(input(10, async () => ((ran = true), {})));
    const out = await store.execute(q.id);
    expect(out.outcome).toBe("blocked");
    expect(out.message).toMatch(/Could not check the daily limits/);
    expect(ran).toBe(false);
    expect(p.status).toBe("pending");
  });

  it("records the life cycle: prepared, executed with eToro's ids, rejected, failed, expired", async () => {
    let t = T0;
    const store = new ProposalStore(baseCfg({ confirmTtlMs: 60_000 }), () => t);
    const ok = store.create({ ...input(10, async () => ({ orderForOpen: { orderID: 100200301 }, token: "x" })), refs: { instrumentId: 1001 } });
    const bad = store.create(input(10, async () => Promise.reject(new Error("boom"))));
    const no = store.create(input());
    const late = store.create(input());
    await store.execute(ok.id);
    await store.execute(bad.id);
    store.reject(no.id);
    t += 60_001;
    store.get(late.id);

    expect(store.db.get(ok.id)).toMatchObject({ status: "executed", orderId: 100200301, instrumentId: 1001, exposureUsd: 10 });
    expect(store.db.get(bad.id)).toMatchObject({ status: "failed", error: "boom" });
    expect(store.db.get(no.id)?.status).toBe("rejected");
    expect(store.db.get(late.id)?.status).toBe("expired");
    expect(store.db.events(ok.id).map((e) => e.event)).toEqual(["prepared", "approved_by_user", "executed"]);
  });

  it("never writes the approval token or anti-CSRF value to the history", async () => {
    const path = join(tmp(), "history.sqlite");
    const store = new ProposalStore(baseCfg(), () => T0, undefined, undefined, new HistoryDb(path, () => T0));
    const p = store.create(input());
    await store.execute(p.id);
    store.db.close();
    const raw = new DatabaseSync(path);
    const dump = JSON.stringify([raw.prepare("SELECT * FROM actions").all(), raw.prepare("SELECT * FROM events").all(), raw.prepare("SELECT * FROM ledger").all()]);
    raw.close();
    expect(dump).not.toContain(p.token);
    expect(dump).not.toContain(p.csrf);
  });
});

describe("query parsing", () => {
  it("turns dates into the configured time zone's day boundaries and drops anything invalid", () => {
    const ok = parseHistoryQuery({ q: " aapl ", env: "real", status: "executed", from: "2026-10-01", to: "2026-10-06" }, "UTC");
    expect(ok.problems).toEqual([]);
    expect(ok.filter).toMatchObject({ q: "aapl", env: "real", status: "executed" });
    expect(new Date(ok.filter.from!).toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(new Date(ok.filter.to!).toISOString()).toBe("2026-10-07T00:00:00.000Z");

    const bad = parseHistoryQuery({ env: "prod", status: "weird", tool: "DROP TABLE", from: "yesterday", to: "2026-13-45" }, "UTC");
    expect(bad.problems).toHaveLength(5);
    expect(bad.filter).toMatchObject({ offset: 0 });
    expect(bad.filter.env).toBeUndefined();
    expect(bad.filter.from).toBeUndefined();
    expect(bad.form).toEqual({ q: "", env: "", tool: "", status: "", from: "", to: "" });
  });
});

describe("CSV", () => {
  it("quotes cells and neutralizes spreadsheet formulas", () => {
    const csv = renderCsv(
      [{ id: "x", env: "demo", tool: "open_position", status: "executed", summary: '=HYPERLINK("http://evil","x"),y', exposureUsd: 5, createdAt: T0, expiresAt: T0 }],
      "UTC",
    );
    const lines = csv.trimEnd().split("\r\n");
    expect(lines[0]).toBe("time,environment,action,status,summary,exposure_usd,order_id,position_id,instrument_id,error,action_id");
    expect(lines[1]).toContain(`"'=HYPERLINK(""http://evil"",""x""),y"`);
  });
});

describe("the history page and tools", () => {
  const cfg = (over: Parameters<typeof baseCfg>[0] = {}) => baseCfg({ enableWrite: true, showApprovalUrl: true, ...over });
  const handler = () => undefined;

  const open = async (c: Awaited<ReturnType<typeof connect>>) => {
    const res = JSON.parse(textOf(await c.client.callTool({ name: "etoro_open_history", arguments: {} })));
    return { ...res, url: res.url as string };
  };

  it("opens a read-only page for the user, with today's usage and the actions, escaped", async () => {
    const c = await connect(cfg(), handler);
    const p = c.store.create({ ...input(40), summary: 'OPEN <b>AAPL</b> & "co"' });
    await c.store.execute(p.id);
    const opened = await open(c);
    expect(opened.opened).toBe(true);
    expect(c.opened).toContain(opened.url);
    expect(opened.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/h\/[A-Za-z0-9_-]{43}$/);

    const res = await fetch(opened.url);
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<b>AAPL</b>");
    expect(html).toContain("OPEN &lt;b&gt;AAPL&lt;/b&gt; &amp; &quot;co&quot;");
    expect(html).toMatch(/\$40\.00 of \$1000\.00 · 1 of 25 writes/);
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(res.headers.get("cache-control")).toBe("no-store");
    await c.close();
  });

  it("does not give the address to the model unless asked to", async () => {
    const c = await connect(cfg({ showApprovalUrl: false }), handler);
    const text = textOf(await c.client.callTool({ name: "etoro_open_history", arguments: {} }));
    expect(text).not.toContain("127.0.0.1");
    expect(c.opened.some((u) => u.includes("/h/"))).toBe(true);
    await c.close();
  });

  it("searches, filters, pages and shows the detail of an action", async () => {
    const c = await connect(cfg(), handler);
    const a = c.store.create({ ...input(10, async () => ({ orderId: 4242 })), summary: "OPEN BUY AAPL", refs: { instrumentId: 1001 } });
    await c.store.execute(a.id);
    const b = c.store.create({ ...input(), summary: "OPEN BUY MSFT" });
    c.store.reject(b.id);
    const { url } = await open(c);

    const aapl = await (await fetch(`${url}?q=aapl`)).text();
    expect(aapl).toContain("OPEN BUY AAPL");
    expect(aapl).not.toContain("OPEN BUY MSFT");
    expect(await (await fetch(`${url}?q=4242`)).text()).toContain("OPEN BUY AAPL");
    expect(await (await fetch(`${url}?status=rejected`)).text()).toContain("OPEN BUY MSFT");
    const bad = await (await fetch(`${url}?env=%22%3E%3Cscript%3E&from=nope`)).text();
    expect(bad).not.toContain("<script");
    expect(bad).toContain("ignored");

    const detail = await fetch(`${url}/a/${a.id}`);
    const html = await detail.text();
    expect(detail.status).toBe(200);
    expect(html).toContain("OPEN BUY AAPL");
    expect(html).toContain("4242");
    expect(html).toContain("approved_by_user");
    expect((await fetch(`${url}/a/00000000-0000-4000-8000-000000000000`)).status).toBe(404);
    await c.close();
  });

  it("exports the filtered history as CSV", async () => {
    const c = await connect(cfg(), handler);
    await c.store.execute(c.store.create({ ...input(), summary: "OPEN BUY AAPL" }).id);
    const { url } = await open(c);
    const res = await fetch(`${url}/export.csv?q=aapl`);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toMatch(/attachment; filename="etoro-history-\d{4}-\d{2}-\d{2}\.csv"/);
    const csv = await res.text();
    expect(csv.split("\r\n")[1]).toContain("OPEN BUY AAPL");
    await c.close();
  });

  it("is read-only and locked: wrong token, expired link, foreign Host, any non-GET method", async () => {
    let t = 5_000_000;
    const store = new ProposalStore(baseCfg(), () => t);
    const tickets = new TicketServer(store, { now: () => t, config: baseCfg() });
    const url = await tickets.historyUrl();
    const origin = new URL(url).origin;
    expect((await fetch(url)).status).toBe(200);
    expect((await fetch(`${origin}/h/${"A".repeat(43)}`)).status).toBe(404);
    // DNS rebinding: the request reaches 127.0.0.1 but carries the attacker's name in Host.
    const { request } = await import("node:http");
    const foreign = await new Promise<number>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: Number(new URL(url).port), path: new URL(url).pathname, headers: { host: `evil.example:${new URL(url).port}` } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end();
    });
    expect(foreign).toBe(403);
    for (const method of ["POST", "PUT", "DELETE"]) {
      expect((await fetch(url, { method, body: method === "DELETE" ? undefined : "x" })).status).toBe(405);
    }
    // A proposal's approval address is not a history address, and the other way round.
    const p = store.create(input());
    const ticket = await tickets.urlFor(p);
    expect((await fetch(`${origin}/h/${p.token}`)).status).toBe(404);
    expect((await fetch(`${origin}/t/${new URL(url).pathname.split("/")[2]}`)).status).toBe(404);
    expect(ticket).toContain("/t/");
    t += 61 * 60_000;
    expect((await fetch(url)).status).toBe(404);
    await tickets.close();
  });

  it("lets Claude search the history, and finds an action after a restart", async () => {
    const path = join(tmp(), "history.sqlite");
    const first = await connect(cfg({ historyPath: path }), handler);
    const p = first.store.create({ ...input(10, async () => ({ orderId: 555 })), summary: "OPEN BUY AAPL" });
    await first.store.execute(p.id);
    await first.close();
    first.store.db.close();

    const second = await connect(cfg({ historyPath: path }), handler);
    const found = JSON.parse(textOf(await second.client.callTool({ name: "etoro_get_action_history", arguments: { query: "aapl" } })));
    expect(found).toMatchObject({ total: 1, persistent: true, today: { executedWrites: 1, maxDailyWrites: 25 } });
    expect(found.actions[0]).toMatchObject({ actionId: p.id, status: "executed", orderId: 555, action: "open_position" });

    const status = JSON.parse(textOf(await second.client.callTool({ name: "etoro_get_action_status", arguments: { actionId: p.id } })));
    expect(status).toMatchObject({ status: "executed", fromHistory: true, result: { orderId: 555 } });

    const bad = await second.client.callTool({ name: "etoro_get_action_history", arguments: { from: "last week" } });
    expect(bad.isError).toBe(true);
    await second.close();
    second.store.db.close();
  });
});

describe("opening the history database at startup", () => {
  it("a server that can write refuses to start without it; a read-only one falls back to memory", () => {
    const dir = tmp();
    const file = join(dir, "not-a-directory");
    writeFileSync(file, "x");
    const broken = join(file, "history.sqlite");
    expect(() => createServer(baseCfg({ enableWrite: true, historyPath: broken }), { log: () => {} })).toThrow(ConfigError);
    const lines: string[] = [];
    const { ctx } = createServer(baseCfg({ historyPath: broken }), { log: (l) => lines.push(l) });
    expect(ctx.store.db.persistent).toBe(false);
    expect(lines.join("\n")).toMatch(/in-memory history/);
  });
});

describe("configuration", () => {
  const keys = { ETORO_API_KEY: "api-key-value-1", ETORO_USER_KEY: "user-key-value-2" };

  it("has sensible daily defaults and a history file in the user's data directory", () => {
    const cfg = loadConfig(keys);
    expect(cfg).toMatchObject({ maxDailyUsd: 1000, maxDailyWrites: 25, timezone: "UTC" });
    expect(cfg.historyPath).toMatch(/etoro-mcp-server.*history\.sqlite$/);
  });

  it("reads the limits, the time zone and the history path from the environment", () => {
    const cfg = loadConfig({ ...keys, ETORO_MAX_DAILY_USD: "250", ETORO_MAX_DAILY_WRITES: "8", ETORO_TIMEZONE: "America/Santiago", ETORO_HISTORY_DB: "/tmp/x/h.sqlite" });
    expect(cfg).toMatchObject({ maxDailyUsd: 250, maxDailyWrites: 8, timezone: "America/Santiago", historyPath: "/tmp/x/h.sqlite" });
    expect(loadConfig({ ...keys, ETORO_HISTORY_DB: "off" }).historyPath).toBe(":memory:");
  });

  it("rejects values that make no sense", () => {
    expect(() => loadConfig({ ...keys, ETORO_TIMEZONE: "Mars/Olympus" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...keys, ETORO_MAX_DAILY_USD: "0" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...keys, ETORO_MAX_DAILY_WRITES: "5000" })).toThrow(ConfigError);
  });
});
