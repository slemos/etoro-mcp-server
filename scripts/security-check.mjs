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
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
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
  "etoro_prepare_cancel_order",
  "etoro_confirm_action",
  "etoro_create_watchlist",
  "etoro_add_watchlist_items",
  "etoro_remove_watchlist_items",
  "etoro_delete_watchlist",
];

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n      ${detail}`}`);
}

const baseEnv = (extra = {}) => ({
  PATH: process.env.PATH,
  HOME: work,
  ETORO_API_KEY: API_KEY,
  ETORO_USER_KEY: USER_KEY,
  NODE_OPTIONS: `--import ${preload}`,
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
  check(
    "destructive tools say so (confirm, remove, delete)",
    ["etoro_confirm_action", "etoro_remove_watchlist_items", "etoro_delete_watchlist"].every((n) => demoWrite.find((t) => t.name === n)?.annotations?.destructiveHint === true),
  );

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
  const s = await start("hostile", { ETORO_ENABLE_WRITE: "true", ETORO_AUDIT_LOG: join(work, "audit.jsonl") });
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
    ["etoro_confirm_action", { confirmationId: "not-a-uuid" }],
    ["etoro_confirm_action", { confirmationId: "00000000-0000-4000-8000-000000000000" }],
    ["etoro_create_watchlist", { name: "" }],
    ["etoro_add_watchlist_items", { watchlistId: "x", instrumentIds: [] }],
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
  const unknownConfirm = await call(s.client, "etoro_confirm_action", { confirmationId: "00000000-0000-4000-8000-000000000000" });
  check("an unknown confirmationId executes nothing", unknownConfirm.refused && /Unknown or expired/.test(unknownConfirm.text), unknownConfirm.text);

  // 4. Identifiers cannot rewrite the request path, whatever they contain.
  const before = s.fetches().length;
  const ids = ["..", ".", "../../orders", "a/b", "a?x=1", "a#frag", "%2e%2e", "x\u0000y", " ../ "];
  for (const watchlistId of ids) {
    await call(s.client, "etoro_delete_watchlist", { watchlistId });
    await call(s.client, "etoro_add_watchlist_items", { watchlistId, instrumentIds: [1] });
  }
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
    ["etoro_create_watchlist", { name: "x" }],
    ["etoro_prepare_open_position", { symbol: "AAPL", side: "buy", amountUsd: 5, settlementType: "cfd" }],
  ]) {
    const res = await call(s.client, name, args);
    if (res.text.includes(API_KEY) || res.text.includes(USER_KEY)) leaky.push(name);
  }
  const sent = s.fetches();
  check("positive control: the fake keys really were in the request headers", sent.some((f) => f.apiKey === API_KEY && f.userKey === USER_KEY));
  check("tool results never contain the keys, even when the failing request's headers are in the error", leaky.length === 0, leaky.join(", "));
  await s.close();
  check("stderr never contains the keys", !s.stderr().includes(API_KEY) && !s.stderr().includes(USER_KEY), s.stderr().slice(0, 300));
  const auditFile = join(work, "audit.jsonl");
  const audit = existsSync(auditFile) ? readFileSync(auditFile, "utf8") : "";
  check("the audit log never contains the keys", !audit.includes(API_KEY) && !audit.includes(USER_KEY));

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} security checks passed.`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`security-check crashed: ${err instanceof Error ? err.stack : err}`);
  process.exit(2);
});
