import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ApprovalGrant, consumeGrant } from "../src/approval/grant.js";
import { ProposalStore } from "../src/approval/proposals.js";
import { escapeHtml, renderTicket } from "../src/approval/render.js";
import { TicketServer } from "../src/approval/server.js";
import { EtoroClient } from "../src/client.js";
import { R, type RouteSpec } from "../src/endpoints.js";
import { PolicyError } from "../src/errors.js";
import { baseCfg, mockFetch, pressButton } from "./helpers.js";

const input = (exposureUsd = 10, run: () => Promise<unknown> = async () => ({ orderId: 1 })) => ({
  tool: "open_position",
  summary: "OPEN BUY X",
  rows: [{ label: "Instrument", value: "X" }],
  exposureUsd,
  run,
});

describe("ProposalStore", () => {
  it("expires proposals that the user never executes", async () => {
    let t = 1_000;
    const store = new ProposalStore(baseCfg({ confirmTtlMs: 60_000 }), () => t);
    const p = store.create(input());
    expect(store.get(p.id)?.status).toBe("pending");
    t += 60_001;
    expect(store.get(p.id)?.status).toBe("expired");
    expect((await store.execute(p.id)).outcome).toBe("not_pending");
  });

  it("runs the action once, with a grant, when the user executes; later presses do nothing", async () => {
    const store = new ProposalStore(baseCfg());
    let runs = 0;
    const p = store.create(input(10, async () => ++runs));
    expect((await store.execute(p.id)).outcome).toBe("executed");
    expect((await store.execute(p.id)).outcome).toBe("not_pending");
    expect(runs).toBe(1);
    expect(store.view(p)).toMatchObject({ status: "executed", result: 1 });
  });

  it("a failing action is marked failed with a one-line error and keeps no secrets in the view", async () => {
    const store = new ProposalStore(baseCfg());
    const p = store.create(input(10, async () => Promise.reject(new Error("boom\nsecond line"))));
    const out = await store.execute(p.id);
    expect(out.outcome).toBe("failed");
    expect(store.view(p)).toMatchObject({ status: "failed", error: "boom" });
    expect(JSON.stringify(store.view(p))).not.toContain(p.token);
    expect(JSON.stringify(store.view(p))).not.toContain(p.csrf);
  });

  it("enforces the per-minute write limit and releases it after a minute; a blocked action stays pending", async () => {
    let t = 1_000;
    const store = new ProposalStore(baseCfg({ maxWritesPerMinute: 2 }), () => t);
    for (let i = 0; i < 2; i++) expect((await store.execute(store.create(input()).id)).outcome).toBe("executed");
    const third = store.create(input());
    const blocked = await store.execute(third.id);
    expect(blocked.outcome).toBe("blocked");
    expect(blocked.message).toContain("Write rate limit");
    expect(third.status).toBe("pending");
    t += 61_000;
    expect((await store.execute(third.id)).outcome).toBe("executed");
  });

  it("enforces the session exposure cap", async () => {
    const store = new ProposalStore(baseCfg({ maxSessionUsd: 150 }));
    expect((await store.execute(store.create(input(100)).id)).outcome).toBe("executed");
    const out = await store.execute(store.create(input(100)).id);
    expect(out.outcome).toBe("blocked");
    expect(out.message).toMatch(/Session exposure cap/);
  });

  it("limits how many proposals can wait for the user", () => {
    const store = new ProposalStore(baseCfg());
    for (let i = 0; i < 20; i++) store.create(input());
    expect(() => store.create(input())).toThrow(PolicyError);
  });

  it("rejecting is final", async () => {
    const store = new ProposalStore(baseCfg());
    const p = store.create(input());
    expect(store.reject(p.id).status).toBe("rejected");
    expect((await store.execute(p.id)).outcome).toBe("not_pending");
  });
});

describe("the write gate", () => {
  /** Every route the allowlist marks as a write, built with sample arguments. */
  const writeRoutes = (): RouteSpec[] => {
    const routes: RouteSpec[] = [];
    for (const env of ["demo", "real"] as const) {
      for (const make of Object.values(R) as Array<(...args: never[]) => RouteSpec>) {
        const args = make.length === 0 ? [] : make.length === 1 ? (make.toString().includes("env") ? [env] : ["w1"]) : [env, 1];
        let route: RouteSpec | undefined;
        try {
          route = (make as (...a: unknown[]) => RouteSpec)(...args);
        } catch {
          route = undefined;
        }
        if (route?.kind === "write") routes.push(route);
      }
    }
    return routes;
  };

  it("finds the write routes this test is meant to cover", () => {
    const ids = new Set(writeRoutes().map((r) => r.id));
    for (const id of ["createOrder", "closePosition", "cancelOrder", "transfer", "createWatchlist", "addWatchlistItems", "removeWatchlistItems", "deleteWatchlist"]) {
      expect(ids.has(id), id).toBe(true);
    }
  });

  it("refuses every write route without a grant, even with every switch on", async () => {
    const { fn, calls } = mockFetch(() => ({ json: {} }));
    const client = new EtoroClient(baseCfg({ env: "real", enableWrite: true, allowRealWrite: true, allowTransfers: true }), fn, async () => {});
    for (const route of writeRoutes()) {
      await expect(client.call(route, { body: {} }), route.id).rejects.toThrow(/approval page/);
    }
    expect(calls).toHaveLength(0);
  });

  it("a grant works once and cannot be forged or reused", async () => {
    const { fn, calls } = mockFetch(() => ({ json: {} }));
    const client = new EtoroClient(baseCfg({ enableWrite: true }), fn, async () => {});
    const grant = ApprovalGrant.mint();
    await client.call(R.createOrder("demo"), { body: {}, grant });
    await expect(client.call(R.createOrder("demo"), { body: {}, grant })).rejects.toBeInstanceOf(PolicyError);
    await expect(client.call(R.createOrder("demo"), { body: {}, grant: {} as ApprovalGrant })).rejects.toBeInstanceOf(PolicyError);
    expect(consumeGrant(Object.create(ApprovalGrant.prototype))).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("read routes need no grant", async () => {
    const { fn } = mockFetch(() => ({ json: { ok: true } }));
    const client = new EtoroClient(baseCfg(), fn, async () => {});
    await expect(client.call(R.rates(), { query: { instrumentIds: [1] } })).resolves.toEqual({ ok: true });
  });

  it("only the proposal store mints grants", () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? walk(path) : path.endsWith(".ts") ? [path] : [];
      });
    const root = new URL("../src", import.meta.url).pathname;
    const minters = walk(root).filter((f) => /ApprovalGrant\.mint\(/.test(readFileSync(f, "utf8")));
    expect(minters.map((f) => f.slice(root.length + 1))).toEqual(["approval/grant.ts", "approval/proposals.ts"].filter((f) => minters.some((m) => m.endsWith(f))));
    expect(minters.some((f) => f.endsWith("approval/proposals.ts"))).toBe(true);
    expect(minters.every((f) => f.includes("/approval/"))).toBe(true);
  });
});

describe("the approval page", () => {
  const setup = (over: Parameters<typeof baseCfg>[0] = {}) => {
    const cfg = baseCfg(over);
    let t = 1_000_000;
    const store = new ProposalStore(cfg, () => t);
    const tickets = new TicketServer(store, { now: () => t });
    return { store, tickets, advance: (ms: number) => (t += ms) };
  };

  it("serves a page with the exact action, escaped, no scripts, and strict headers", async () => {
    const { store, tickets } = setup();
    const p = store.create({
      ...input(),
      summary: 'OPEN <script>alert("x")</script> & "co"',
      rows: [{ label: "Instrument", value: "<img src=x onerror=alert(1)>" }],
    });
    const url = await tickets.urlFor(p);
    const res = await fetch(url);
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &quot;co&quot;");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    // "no-referrer" would make browsers send "Origin: null" on the page's own form posts (found with a real browser).
    expect(res.headers.get("referrer-policy")).toBe("same-origin");
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/t\/[A-Za-z0-9_-]{43}$/);
    await tickets.close();
  });

  it("a GET never executes anything", async () => {
    const { store, tickets } = setup();
    let runs = 0;
    const p = store.create(input(10, async () => ++runs));
    const url = await tickets.urlFor(p);
    for (const suffix of ["", "/execute", "/reject"]) {
      await fetch(url + suffix);
    }
    expect(runs).toBe(0);
    expect(p.status).toBe("pending");
    await tickets.close();
  });

  it("rejects a wrong token, a foreign Host, a missing or foreign Origin, and a wrong anti-CSRF value", async () => {
    const { store, tickets } = setup();
    let runs = 0;
    const p = store.create(input(10, async () => ++runs));
    const url = await tickets.urlFor(p);
    const port = new URL(url).port;

    expect((await fetch(url.replace(p.token, "A".repeat(43)))).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(404);

    // DNS rebinding: the request reaches 127.0.0.1 but carries the attacker's name in Host.
    const { request } = await import("node:http");
    const rebound = await new Promise<number>((resolve) => {
      const req = request({ host: "127.0.0.1", port: Number(port), path: `/t/${p.token}`, headers: { host: `evil.example:${port}` } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.end();
    });
    expect(rebound).toBe(403);

    expect((await pressButton(url, "execute", { origin: null })).status).toBe(403);
    expect((await pressButton(url, "execute", { origin: "http://evil.example" })).status).toBe(403);
    expect((await pressButton(url, "execute", { csrf: "wrong" })).status).toBe(403);
    // A modern browser says when the request comes from another site; the server believes it.
    const cross = await fetch(`${url}/execute`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: new URL(url).origin, "sec-fetch-site": "cross-site" },
      body: `csrf=${encodeURIComponent(p.csrf)}`,
      redirect: "manual",
    });
    expect(cross.status).toBe(403);
    expect((await pressButton(url, "reject", { csrf: "" })).status).toBe(403);
    expect(runs).toBe(0);
    expect(p.status).toBe("pending");

    expect((await pressButton(url, "execute")).status).toBe(303);
    expect(runs).toBe(1);
    await tickets.close();
  });

  it("an expired proposal cannot be executed from its page", async () => {
    const { store, tickets, advance } = setup({ confirmTtlMs: 60_000 });
    let runs = 0;
    const p = store.create(input(10, async () => ++runs));
    const url = await tickets.urlFor(p);
    advance(61_000);
    await pressButton(url, "execute");
    expect(runs).toBe(0);
    expect(p.status).toBe("expired");
    await tickets.close();
  });

  it("logs the address and reports whether a browser opened, and never throws if opening fails", async () => {
    const cfg = baseCfg();
    const store = new ProposalStore(cfg);
    const lines: string[] = [];
    const tickets = new TicketServer(store, { openUrl: async () => Promise.reject(new Error("no display")), log: (l) => lines.push(l) });
    const p = store.create(input());
    expect(await tickets.open(p, true)).toBe(false);
    expect(await tickets.open(p, false)).toBe(false);
    expect(lines[0]).toContain(`/t/${p.token}`);
    await tickets.close();
  });
});

describe("escapeHtml and renderTicket", () => {
  it("escapes the five dangerous characters", () => {
    expect(escapeHtml(`<a href="x" onclick='y'>&</a>`)).toBe("&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;");
  });

  it("shows REAL clearly and offers no buttons once the action is decided", () => {
    const store = new ProposalStore(baseCfg({ env: "real" }));
    const p = store.create(input());
    expect(renderTicket(p, { now: Date.now() })).toContain(">REAL<");
    expect(renderTicket(p, { now: Date.now() })).toContain("Execute");
    p.status = "rejected";
    const done = renderTicket(p, { now: Date.now() });
    expect(done).not.toContain("<button");
    expect(done).toContain("nothing was sent to eToro");
  });
});
