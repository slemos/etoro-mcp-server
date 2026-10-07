#!/usr/bin/env node
/**
 * Security checks that run the BUILT server (dist/index.js) as a real stdio process, the way an MCP
 * client does, with the network cut off by scripts/security-preload.mjs. No eToro account, key or
 * connection is involved: the keys are fake and any request the server tries to make is recorded and
 * refused. It is the dynamic counterpart of CodeQL (which only reads the source).
 *
 *   npm run build && npm run security:check
 *
 * Checks: which tools exist under each permission switch; that a non-eToro base URL is refused at
 * startup; that hostile tool arguments are rejected without touching the network; that ids cannot
 * rewrite the request path; and that secrets never reach tool results, stderr or the audit log.
 */
import { spawn } from "node:child_process";
import { request } from "node:http";
import { mkdtempSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = resolve(new URL("..", import.meta.url).pathname);
const entry = join(root, "dist/index.js");
const preload = join(root, "scripts/security-preload.mjs");
const work = mkdtempSync(join(tmpdir(), "etoro-security-"));

const API_KEY = "SECCHECK-api-key-0123456789abcdef";
const USER_KEY = "SECCHECK-user-key-fedcba9876543210";
const WRITE_TOOLS = [
  "etoro_prepare_open_position",
  "etoro_prepare_close_position",
  "etoro_prepare_modify_position",
  "etoro_prepare_cancel_order",
  "etoro_prepare_cancel_close_order",
  "etoro_prepare_create_price_alert",
  "etoro_prepare_update_price_alert",
  "etoro_prepare_delete_price_alert",
  "etoro_prepare_create_watchlist",
  "etoro_prepare_add_watchlist_items",
  "etoro_prepare_remove_watchlist_items",
  "etoro_prepare_delete_watchlist",
];

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n      ${detail}`}`);
}

/** Plays the user's browser on an approval page: reads the form, then posts it (or a tampered version). */
async function pressOnPage(url, action = "execute", over = {}) {
  const page = await (await fetch(url)).text();
  const csrf = over.csrf ?? /name="csrf" value="([^"]+)"/.exec(page)?.[1] ?? "";
  const headers = { "content-type": "application/x-www-form-urlencoded" };
  const origin = over.origin === undefined ? new URL(url).origin : over.origin;
  if (origin !== null) headers.origin = origin;
  const res = await fetch(`${url}/${action}`, { method: "POST", headers, body: `csrf=${encodeURIComponent(csrf)}`, redirect: "manual" });
  return res.status;
}

/** Calls a prepare tool and returns { actionId, url, text }; url is only present when ETORO_SHOW_APPROVAL_URL is on. */
async function prepare(client, name, args) {
  const res = await call(client, name, args);
  let parsed = {};
  try {
    parsed = JSON.parse(res.text);
  } catch {
    // an error text
  }
  return { refused: res.refused, text: res.text, actionId: parsed.actionId, url: parsed.approval?.url };
}

const baseEnv = (extra = {}) => ({
  PATH: process.env.PATH,
  HOME: work,
  ETORO_API_KEY: API_KEY,
  ETORO_USER_KEY: USER_KEY,
  NODE_OPTIONS: `--import ${preload}`,
  ETORO_OPEN_BROWSER: "false", // never pop a browser window during the checks
  ...extra,
});

/** Starts the server with the given environment; returns the client, captured stderr and the fetch log path. */
async function start(name, extra = {}) {
  const fetchLog = join(work, `${name}.fetch.jsonl`);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    env: baseEnv({ SECURITY_CHECK_FETCH_LOG: fetchLog, ...extra }),
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => (stderr += chunk));
  const client = new Client({ name: "security-check", version: "0.0.0" });
  await client.connect(transport);
  return {
    client,
    stderr: () => stderr,
    fetches: () => (existsSync(fetchLog) ? readFileSync(fetchLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []),
    close: () => client.close(),
  };
}

async function toolNames(name, extra) {
  const s = await start(name, extra);
  const { tools } = await s.client.listTools();
  await s.close();
  return tools;
}

/** Calls a tool; protocol-level rejections and tool errors both count as "refused". */
async function call(client, name, args) {
  try {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content ?? []).map((c) => c.text ?? "").join("\n");
    return { refused: res.isError === true, text };
  } catch (err) {
    return { refused: true, text: err instanceof Error ? err.message : String(err) };
  }
}

/** Runs the server to completion and returns its exit code and stderr (for startup failures). */
function runToExit(extra) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [entry], { env: baseEnv(extra), stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (c) => (stderr += c));
    const timer = setTimeout(() => child.kill(), 10_000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      done({ code, stderr });
    });
    child.stdin.end();
  });
}

async function main() {
  if (!existsSync(entry)) {
    console.error("dist/index.js not found: run `npm run build` first.");
    process.exit(2);
  }

  // 1. Permission switches decide which tools exist.
  const readOnly = await toolNames("readonly", {});
  check("default: server is read-only (no write tool is registered)", WRITE_TOOLS.every((t) => !readOnly.some((x) => x.name === t)), readOnly.map((t) => t.name).join(", "));
  check("default: every tool is annotated read-only", readOnly.every((t) => t.annotations?.readOnlyHint === true && t.annotations?.destructiveHint === false));

  const demoWrite = await toolNames("demo-write", { ETORO_ENABLE_WRITE: "true" });
  check("demo + ETORO_ENABLE_WRITE: write tools exist", WRITE_TOOLS.every((t) => demoWrite.some((x) => x.name === t)));
  check("demo + ETORO_ENABLE_WRITE: no transfer tool", !demoWrite.some((t) => t.name === "etoro_prepare_transfer"));
  check("no tool Claude can call executes an action: there is no etoro_confirm_action", !demoWrite.some((t) => /confirm|execute/.test(t.name)));
  check("the only way to follow an action is a read-only status tool", demoWrite.find((t) => t.name === "etoro_get_action_status")?.annotations?.readOnlyHint === true);

  const realNoSecond = await toolNames("real-no-second-switch", { ETORO_ENV: "real", ETORO_ENABLE_WRITE: "true" });
  check("real + ETORO_ENABLE_WRITE without ETORO_ALLOW_REAL_WRITE: still read-only", WRITE_TOOLS.every((t) => !realNoSecond.some((x) => x.name === t)));

  const switchReal = await toolNames("use-real-switch", { ETORO_USE_REAL: "true", ETORO_ENABLE_WRITE: "true" });
  check("ETORO_USE_REAL=true selects real, so writes still need the second switch", WRITE_TOOLS.every((t) => !switchReal.some((x) => x.name === t)));
  const contradiction = await runToExit({ ETORO_ENV: "demo", ETORO_USE_REAL: "true" });
  check("ETORO_ENV and ETORO_USE_REAL that disagree are refused at startup", contradiction.code !== 0 && /set only one/.test(contradiction.stderr), `exit ${contradiction.code}: ${contradiction.stderr.slice(0, 200)}`);

  const realWrite = await toolNames("real-write", { ETORO_ENV: "real", ETORO_ENABLE_WRITE: "true", ETORO_ALLOW_REAL_WRITE: "true" });
  check("real writes enabled: no transfer tool without ETORO_ALLOW_TRANSFERS", !realWrite.some((t) => t.name === "etoro_prepare_transfer"));
  const demoTransfers = await toolNames("demo-transfers", { ETORO_ENABLE_WRITE: "true", ETORO_ALLOW_TRANSFERS: "true" });
  check("ETORO_ALLOW_TRANSFERS does nothing on demo", !demoTransfers.some((t) => t.name === "etoro_prepare_transfer"));

  // 2. The keys can only be sent to an eToro host.
  for (const url of ["http://public-api.etoro.com", "https://evil.example", "https://etoro.com.evil.example", "https://public-api.etoro.com.evil.example", "https://user@evil.example/"]) {
    const run = await runToExit({ ETORO_BASE_URL: url });
    check(`ETORO_BASE_URL=${url} is refused at startup`, run.code !== 0 && /ETORO_BASE_URL/.test(run.stderr), `exit ${run.code}: ${run.stderr.slice(0, 200)}`);
  }

  // 3. Hostile arguments are rejected before any request is made.
  const s = await start("hostile", { ETORO_ENABLE_WRITE: "true", ETORO_SHOW_APPROVAL_URL: "true", ETORO_AUDIT_LOG: join(work, "audit.jsonl") });
  const tooMany = Array.from({ length: 101 }, (_, i) => i + 1);
  const hostile = [
    ["etoro_get_order", { orderId: -1 }],
    ["etoro_get_order", { orderId: "1 OR 1=1" }],
    ["etoro_get_order", { orderId: 1.5 }],
    ["etoro_get_rates", { instrumentIds: [] }],
    ["etoro_get_rates", { instrumentIds: tooMany }],
    ["etoro_get_rates", { instrumentIds: ["1; DROP TABLE"] }],
    ["etoro_get_instruments", { symbols: ["A".repeat(500)] }],
    ["etoro_check_eligibility", {}],
    ["etoro_prepare_open_position", { symbol: "AAPL", side: "buy", amountUsd: -5 }],
    ["etoro_prepare_open_position", { symbol: "AAPL", instrumentId: 1001, side: "buy", amountUsd: 5 }],
    ["etoro_prepare_open_position", { symbol: "AAPL", side: "buy" }],
    ["etoro_prepare_open_position", { symbol: "AAPL", side: "buy", amountUsd: 5, leverage: 1000 }],
    ["etoro_prepare_open_position", { symbol: "AAPL", side: "buy", amountUsd: 5, settlementType: "margin; rm -rf /" }],
    ["etoro_prepare_open_position", { symbol: "AAPL", side: "sellShort", amountUsd: 5 }],
    ["etoro_prepare_close_position", { positionId: "abc", instrumentId: 1 }],
    ["etoro_prepare_cancel_order", { orderId: 0 }],
    ["etoro_search_instruments", { query: "" }],
    ["etoro_search_instruments", { query: "apple", limit: 500 }],
    ["etoro_get_candles", { instrumentId: 1001, interval: "2d" }],
    ["etoro_get_candles", { instrumentId: 1001, from: "2026-01-01" }],
    ["etoro_get_candles", { instrumentId: 1001, from: "2026-02-01T00:00:00Z", to: "2026-01-01T00:00:00Z" }],
    ["etoro_get_candles", { instrumentId: "1001/../me" }],
    ["etoro_prepare_modify_position", { positionId: 1 }],
    ["etoro_prepare_modify_position", { positionId: -1, stopLossRate: 10 }],
    ["etoro_prepare_modify_position", { positionId: 1, stopLossRate: -5 }],
    ["etoro_prepare_modify_position", { positionId: 1, clearStopLoss: true, stopLossRate: 5 }],
    ["etoro_prepare_modify_position", { positionId: 1, stopLossType: "diagonal" }],
    ["etoro_get_action_status", { actionId: "not-a-uuid" }],
    ["etoro_get_action_status", { actionId: "00000000-0000-4000-8000-000000000000" }],
    ["etoro_prepare_create_watchlist", { name: "" }],
    ["etoro_prepare_add_watchlist_items", { watchlistId: "x", instrumentIds: [] }],
    ["etoro_confirm_action", { confirmationId: "00000000-0000-4000-8000-000000000000" }],
    ["etoro_does_not_exist", {}],
  ];
  let wronglyAccepted = [];
  for (const [name, args] of hostile) {
    const res = await call(s.client, name, args);
    if (!res.refused) wronglyAccepted.push(`${name} ${JSON.stringify(args).slice(0, 80)}`);
  }
  check(`${hostile.length} hostile or malformed calls are all refused`, wronglyAccepted.length === 0, wronglyAccepted.join("\n      "));
  // Trading previews first read GET /api/v1/me to verify the environment (before looking at the arguments), so
  // those reads are expected; nothing else may be requested, and above all no write.
  const guardReads = new Set(["/api/v1/me", "/api/v1/trading/info/demo/aggregate-portfolio", "/api/v1/trading/info/aggregate-portfolio"]);
  const unexpected = s.fetches().filter((f) => f.method !== "GET" || !guardReads.has(f.path));
  check("...and none of them sent a write or any request besides the environment check", unexpected.length === 0, JSON.stringify(unexpected.slice(0, 3)));
  const unknownStatus = await call(s.client, "etoro_get_action_status", { actionId: "00000000-0000-4000-8000-000000000000" });
  check("an unknown actionId reports an error and executes nothing", unknownStatus.refused && /Unknown actionId/.test(unknownStatus.text), unknownStatus.text);

  // 4. Identifiers cannot rewrite the request path, whatever they contain. Watchlist changes are proposals, so each one
  //    is prepared and then executed on its approval page, exactly as a user would.
  const ids = ["..", ".", "../../orders", "a/b", "a?x=1", "a#frag", "%2e%2e", "x\u0000y", " ../ "];
  const proposals = [];
  for (const watchlistId of ids) {
    proposals.push(await prepare(s.client, "etoro_prepare_delete_watchlist", { watchlistId }));
    proposals.push(await prepare(s.client, "etoro_prepare_add_watchlist_items", { watchlistId, instrumentIds: [1] }));
  }
  const writesBeforeExecute = s.fetches().filter((f) => f.method !== "GET");
  check(`${proposals.length} prepared watchlist changes sent nothing to eToro before the user pressed Execute`, proposals.every((p) => p.url) && writesBeforeExecute.length === 0, JSON.stringify(writesBeforeExecute.slice(0, 2)));
  const before = s.fetches().length;
  for (const p of proposals) if (p.url) await pressOnPage(p.url, "execute");
  const attempted = s.fetches().slice(before);
  const bad = attempted.filter((f) => {
    const rest = f.path.startsWith("/api/v1/watchlists/") ? f.path.slice("/api/v1/watchlists/".length) : null;
    const segments = rest === null ? [] : rest.split("/");
    const idSegment = segments[0] ?? "";
    const tail = segments.slice(1).join("/");
    // One non-empty, non-dot id segment, optionally followed by exactly "items"; no query string or fragment.
    return rest === null || idSegment === "" || idSegment === "." || idSegment === ".." || !(tail === "" || tail === "items") || f.url.includes("?") || f.url.includes("#");
  });
  check(
    `watchlist ids (${ids.length} hostile values) always stay inside /api/v1/watchlists/<one segment>`,
    attempted.length > 0 && bad.length === 0,
    attempted.length === 0 ? "no request was attempted, so nothing was checked" : bad.map((f) => `${f.method} ${f.url}`).join("\n      "),
  );

  // 5. Secrets never leave through results, stderr or the audit log. The tripwire's error contains the
  //    request headers, so this is the worst case; the log of attempted requests is the positive control.
  const leaky = [];
  for (const [name, args] of [
    ["etoro_get_balances", {}],
    ["etoro_get_portfolio", {}],
    ["etoro_check_connection", {}],
    ["etoro_prepare_open_position", { symbol: "AAPL", side: "buy", amountUsd: 5, settlementType: "cfd" }],
  ]) {
    const res = await call(s.client, name, args);
    if (res.text.includes(API_KEY) || res.text.includes(USER_KEY)) leaky.push(name);
  }
  // The one write below is executed on its approval page; its failure carries the request headers (the tripwire error).
  const secretProposal = await prepare(s.client, "etoro_prepare_create_watchlist", { name: "secrets" });
  await pressOnPage(secretProposal.url, "execute");
  const statusText = (await call(s.client, "etoro_get_action_status", { actionId: secretProposal.actionId })).text;
  const pageText = await (await fetch(secretProposal.url)).text();
  const sent = s.fetches();
  check("positive control: the fake keys really were in the request headers", sent.some((f) => f.apiKey === API_KEY && f.userKey === USER_KEY));
  check(
    "tool results, the action status and the approval page never contain the keys, even when the failing request's headers are in the error",
    leaky.length === 0 && ![statusText, pageText].some((t) => t.includes(API_KEY) || t.includes(USER_KEY)),
    leaky.join(", "),
  );
  await s.close();
  check("stderr never contains the keys", !s.stderr().includes(API_KEY) && !s.stderr().includes(USER_KEY), s.stderr().slice(0, 300));
  const auditFile = join(work, "audit.jsonl");
  const audit = existsSync(auditFile) ? readFileSync(auditFile, "utf8") : "";
  check("the audit log never contains the keys", !audit.includes(API_KEY) && !audit.includes(USER_KEY));
  check("the audit log records the user's Execute before each executed action", audit.includes("approved_by_user") && audit.includes('"event":"prepared"'));

  // 6. The approval page: only the user, through the page, can make a write happen.
  const g = await start("approval", { ETORO_ENABLE_WRITE: "true", ETORO_SHOW_APPROVAL_URL: "true" });
  const evil = '<script>alert(1)</script>';
  const prop = await prepare(g.client, "etoro_prepare_create_watchlist", { name: evil });
  const page = await fetch(prop.url);
  const html = await page.text();
  check("the approval page is plain HTML: no script, the hostile name is escaped", page.status === 200 && !html.includes("<script") && html.includes("&lt;script&gt;"));
  check("the approval page sends a CSP that forbids everything but inline styles", /default-src 'none'/.test(page.headers.get("content-security-policy") ?? "") && page.headers.get("cache-control") === "no-store");
  const url = new URL(prop.url);
  check("a wrong token is a 404", (await fetch(prop.url.replace(/\/t\/[^/]+/, `/t/${"A".repeat(43)}`))).status === 404);
  const rebound = await new Promise((resolve) => {
    const req = request({ host: "127.0.0.1", port: Number(url.port), path: url.pathname, headers: { host: `evil.example:${url.port}` } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.end();
  });
  check("a request carrying another Host (DNS rebinding) is refused", rebound === 403, `status ${rebound}`);
  check("a POST without an Origin, with a foreign Origin or with a wrong anti-CSRF value is refused", (await pressOnPage(prop.url, "execute", { origin: null })) === 403 && (await pressOnPage(prop.url, "execute", { origin: "http://evil.example" })) === 403 && (await pressOnPage(prop.url, "execute", { csrf: "nope" })) === 403);
  check("a GET on the execute address does not execute", (await fetch(`${prop.url}/execute`)).status === 405);
  check("none of that sent a write to eToro", g.fetches().filter((f) => f.method !== "GET").length === 0, JSON.stringify(g.fetches().slice(0, 2)));
  await pressOnPage(prop.url, "execute");
  const writes = g.fetches().filter((f) => f.method !== "GET");
  check("only the user's Execute press made the write happen, once", writes.length === 1 && writes[0].path === "/api/v1/watchlists", JSON.stringify(writes));
  await pressOnPage(prop.url, "execute");
  check("pressing Execute again sends nothing more", g.fetches().filter((f) => f.method !== "GET").length === 1);
  await g.close();

  const h = await start("hidden", { ETORO_ENABLE_WRITE: "true" });
  const hiddenText = (await call(h.client, "etoro_prepare_create_watchlist", { name: "x" })).text;
  await new Promise((resolve) => setTimeout(resolve, 300)); // let the server's log line arrive
  check(
    "by default the approval address is not given to Claude (only to the browser and the server log)",
    !/127\.0\.0\.1|\/t\//.test(hiddenText) && /127\.0\.0\.1:\d+\/t\//.test(h.stderr()),
    hiddenText.slice(0, 200),
  );
  await h.close();

  // 7. The history and the daily limits: kept in a private file, shared across restarts, shown read-only.
  const historyDb = join(work, "history.sqlite");
  const histEnv = { ETORO_ENABLE_WRITE: "true", ETORO_SHOW_APPROVAL_URL: "true", ETORO_HISTORY_DB: historyDb, ETORO_MAX_DAILY_WRITES: "2" };
  const hs = await start("history", histEnv);
  const first = await prepare(hs.client, "etoro_prepare_create_watchlist", { name: "<script>alert(1)</script>" });
  const second = await prepare(hs.client, "etoro_prepare_create_watchlist", { name: "needle-77" });
  const third = await prepare(hs.client, "etoro_prepare_create_watchlist", { name: "three" });
  for (const p of [first, second, third]) await pressOnPage(p.url, "execute");
  check("the daily write limit (2) stops the third write", hs.fetches().filter((f) => f.method !== "GET").length === 2, JSON.stringify(hs.fetches().filter((f) => f.method !== "GET").length));
  const opened = JSON.parse((await call(hs.client, "etoro_open_history", {})).text);
  const histUrl = new URL(opened.url);
  const histPage = await fetch(opened.url);
  const histHtml = await histPage.text();
  check("the history page is plain HTML: no script, hostile names escaped, CSP set", histPage.status === 200 && !histHtml.includes("<script") && histHtml.includes("&lt;script&gt;") && /default-src 'none'/.test(histPage.headers.get("content-security-policy") ?? ""));
  check("the history page shows today's usage against the daily limits", /2 of 2 writes/.test(histHtml), histHtml.slice(histHtml.indexOf("usage"), histHtml.indexOf("usage") + 200));
  check("a wrong history token is a 404", (await fetch(opened.url.replace(/\/h\/[^/]+/, `/h/${"A".repeat(43)}`))).status === 404);
  const histMethods = [];
  for (const method of ["POST", "PUT", "DELETE"]) histMethods.push((await fetch(opened.url, { method, body: method === "DELETE" ? undefined : "x" })).status);
  check("the history page is read-only: POST, PUT and DELETE are refused", histMethods.every((c) => c === 405), histMethods.join(","));
  const histRebound = await new Promise((resolve) => {
    const req = request({ host: "127.0.0.1", port: Number(histUrl.port), path: histUrl.pathname, headers: { host: `evil.example:${histUrl.port}` } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.end();
  });
  check("the history page refuses another Host (DNS rebinding)", histRebound === 403, `status ${histRebound}`);
  check("an approval address does not open the history, nor the other way round", (await fetch(`${histUrl.origin}/h/${new URL(first.url).pathname.split("/")[2]}`)).status === 404 && (await fetch(`${histUrl.origin}/t/${histUrl.pathname.split("/")[2]}`)).status === 404);
  const injection = await (await fetch(`${opened.url}?q=${encodeURIComponent("'; DROP TABLE actions; --")}&env=${encodeURIComponent("<x>")}`)).text();
  check("hostile search text is neither executed nor reflected raw", !injection.includes("<x>") && !injection.includes("<script") && /No actions match/.test(injection));
  check("searching still works after that", /needle-77/.test(await (await fetch(`${opened.url}?q=needle-77`)).text()));
  await hs.close();

  const rawDb = [historyDb, `${historyDb}-wal`, `${historyDb}-shm`].filter((f) => existsSync(f)).map((f) => readFileSync(f).toString("latin1")).join("");
  const tokens = [first, second, third].map((p) => new URL(p.url).pathname.split("/")[2]);
  check("the history file never contains the keys or the approval tokens", !rawDb.includes(API_KEY) && !rawDb.includes(USER_KEY) && tokens.every((t) => !rawDb.includes(t)));
  check("the history file is private (0600)", process.platform === "win32" || (statSync(historyDb).mode & 0o777) === 0o600, (statSync(historyDb).mode & 0o777).toString(8));

  const hs2 = await start("history-restarted", histEnv);
  const again = await prepare(hs2.client, "etoro_prepare_create_watchlist", { name: "after restart" });
  await pressOnPage(again.url, "execute");
  check("the daily limit survives a restart of the server", hs2.fetches().filter((f) => f.method !== "GET").length === 0);
  const past = JSON.parse((await call(hs2.client, "etoro_get_action_history", { query: "needle-77" })).text);
  check("Claude can search the history of an earlier session", past.total === 1 && past.actions[0].actionId === second.actionId, JSON.stringify(past).slice(0, 200));
  await hs2.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} security checks passed.`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`security-check crashed: ${err instanceof Error ? err.stack : err}`);
  process.exit(2);
});
