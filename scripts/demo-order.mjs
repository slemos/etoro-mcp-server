#!/usr/bin/env node
/**
 * End-to-end test of placing an order on eToro's DEMO environment (virtual money),
 * going through the real MCP server over stdio:
 *
 *   connection check -> instrument lookup -> eligibility -> preview -> your confirmation in the terminal
 *   -> execute (the script presses Execute on the approval page for you) -> follow the order -> (optional) close
 *
 *   npm run demo:order -- --symbol AAPL --amount 50
 *
 * Options:
 *   --symbol <ticker>       exact eToro ticker (default AAPL; ETFs carry a suffix, e.g. CSPX.L)
 *   --amount <usd>          cash to invest in USD (default 50; the server caps it at ETORO_MAX_ORDER_USD, default 100)
 *   --settlement <real|cfd> force real asset or CFD (default: let eToro decide)
 *   --close-position <id>   instead of opening, close that open DEMO position (previews, asks, executes, verifies)
 *   --close                 afterwards, preview and close the position it opened (asks you again)
 *   -y, --yes               answer yes to the confirmation questions (order and, with --close, the close), so the output can be
 *                           piped to a log:  npm run demo:order -- --symbol AAPL --amount 50 -y 2>&1 | tee demo-order.log
 *   --entry <file>          server entry point (default dist/index.js)
 *
 * How it executes: the server only prepares actions; a person executes them on a local approval page. Here that person is
 * you, answering in the terminal (or -y): the script then does what the page's Execute button does. It starts the server
 * with ETORO_SHOW_APPROVAL_URL=true so it can read the page's address, and without opening a browser.
 *
 * Safety: this script FORCES ETORO_ENV=demo (whatever your environment says), refuses to continue
 * unless the connection check proves the key reaches your DEMO account, and never offers real money.
 */
import { createInterface } from "node:readline/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { verdictOf } from "./smoke.mjs";

const parse = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};
/** Tool results may start with a one-line note followed by the JSON. */
const parseAfterNote = (text) => parse(text) ?? parse(text.slice(text.indexOf("\n") + 1));
const shorten = (text, max = 1500) => (text.length > max ? `${text.slice(0, max)} ... [${text.length - max} more chars]` : text);
const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function findPositionId(order) {
  const first = order?.positionExecutions?.[0];
  if (!first || typeof first !== "object") return undefined;
  for (const key of ["positionId", "positionID", "PositionId", "PositionID", "id"]) {
    const n = Number(first[key]);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return undefined;
}

/** Presses Execute on an approval page, the way the browser's form post does. Resolves the HTTP status of the answer. */
export async function pressExecute(url, fetchFn = fetch) {
  const page = await (await fetchFn(url)).text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(page)?.[1];
  if (!csrf) throw new Error("the approval page did not contain an Execute form (already decided or expired?)");
  const res = await fetchFn(`${url}/execute`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: new URL(url).origin },
    body: `csrf=${encodeURIComponent(csrf)}`,
    redirect: "manual",
  });
  return res.status;
}

/**
 * Executes a prepared action as the user, then waits for etoro_get_action_status to say how it ended.
 * Returns { isError, text } like a tool call: the text is eToro's answer when it worked, the error otherwise.
 */
async function executeAction(deps, prepared, o) {
  const url = prepared?.approval?.url;
  if (!url) return { isError: true, text: "The server did not return the approval page address (it needs ETORO_SHOW_APPROVAL_URL=true)." };
  let status;
  try {
    status = await deps.approve(url);
  } catch (err) {
    return { isError: true, text: `Could not press Execute: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (status !== 303 && status !== 200) return { isError: true, text: `The approval page answered HTTP ${status}.` };
  const sleep = deps.sleep ?? sleepMs;
  for (let attempt = 1; attempt <= (o?.statusAttempts ?? 10); attempt++) {
    const res = await deps.call("etoro_get_action_status", { actionId: prepared.actionId });
    const s = parse(res.text);
    if (s?.status === "executed") return { isError: false, text: JSON.stringify(s.result ?? {}) };
    if (s?.status === "failed") return { isError: true, text: String(s.error ?? "failed") };
    if (s && s.status !== "executing" && s.status !== "pending") return { isError: true, text: `The action ended as ${s.status}.` };
    if (s?.status === "pending" && attempt >= 2) return { isError: true, text: "The server did not execute the action (a local limit may have blocked it; see the server log)." };
    await sleep(o?.statusPollMs ?? 300);
  }
  return { isError: true, text: "Timed out waiting for the action to finish." };
}

/**
 * The whole flow, with its collaborators injected so it can be tested without a terminal or network.
 *   deps.call(name, args) -> { isError, text }   deps.confirm(question) -> boolean   deps.approve(url) -> HTTP status of pressing Execute
 */
export async function runDemoOrder(deps, opts) {
  const log = deps.log ?? console.log;
  const sleep = deps.sleep ?? sleepMs;
  const { call, confirm } = deps;
  const o = { side: "buy", amountUsd: 50, pollAttempts: 8, pollMs: 1500, ...opts };
  const stop = (stage, message) => {
    log(`\nX ${stage}: ${message}`);
    return { ok: false, stage };
  };

  log(`DEMO ORDER TEST: ${o.side.toUpperCase()} $${o.amountUsd} of ${o.symbol} on the DEMO environment (virtual money)\n`);

  // 1. Prove the environment before anything else.
  const conn = await call("etoro_check_connection", {});
  const c = parse(conn.text);
  if (conn.isError || !c) return stop("connection", conn.text);
  const verdict = verdictOf(c);
  log(`1. Connection [${verdict.level}]: ${verdict.text}`);
  if (!c.connected || c.environment !== "demo" || !c.environmentVerified) {
    return stop("connection", "the DEMO environment could not be verified, so no order was prepared.");
  }

  // 2. Instrument.
  const inst = await call("etoro_get_instruments", { symbols: [o.symbol], pageSize: 5 });
  if (inst.isError) return stop("instrument", inst.text);
  log(`2. Instrument lookup: ${shorten(inst.text, 600)}`);

  // 3. Eligibility.
  const elig = await call("etoro_check_eligibility", { symbols: [o.symbol] });
  log(`3. Eligibility: ${elig.isError ? `unavailable (${shorten(elig.text, 200)})` : shorten(elig.text, 1200)}`);

  // 4. Preview (sends nothing).
  const prepArgs = { symbol: o.symbol, side: o.side, amountUsd: o.amountUsd, ...(o.settlementType ? { settlementType: o.settlementType } : {}) };
  const prep = await call("etoro_prepare_open_position", prepArgs);
  if (prep.isError) return stop("preview", prep.text);
  const p = parse(prep.text);
  log(`4. Preview (nothing sent yet): ${p.summary}`);
  if (p.estimatedCosts) log(`   estimated costs: ${shorten(JSON.stringify(p.estimatedCosts), 600)}`);
  for (const w of p.warnings ?? []) log(`   warning: ${w}`);

  // 5. Human confirmation, then execute.
  if (!opts.yes && !(await confirm("Execute this DEMO order now?"))) {
    log("\nCancelled by you. Nothing was sent to eToro.");
    return { ok: false, stage: "declined" };
  }
  const exec = await executeAction(deps, p, o);
  if (exec.isError) return stop("execute", exec.text);
  const accepted = parseAfterNote(exec.text);
  log(`5. eToro accepted the request: ${shorten(JSON.stringify(accepted), 400)}`);
  const orderId = Number(accepted?.orderId);
  if (!Number.isInteger(orderId)) return stop("execute", "eToro's reply had no orderId, so the order cannot be followed.");

  // 6. Follow the order.
  let order;
  let lastStatus = "";
  for (let attempt = 1; attempt <= o.pollAttempts; attempt++) {
    const res = await call("etoro_get_order", { orderId });
    order = res.isError ? null : parseAfterNote(res.text);
    const notYet = res.isError && /404|not found/i.test(res.text);
    const status = notYet
      ? "not registered yet (normal in the first seconds after placing an order)"
      : JSON.stringify(order?.status ?? res.text.slice(0, 120));
    if (status !== lastStatus) log(`6. Order ${orderId} status (check ${attempt}): ${status}`);
    lastStatus = status;
    if ((order?.positionExecutions?.length ?? 0) > 0) break;
    if (order?.status?.errorCode || /reject|fail|cancel/i.test(String(order?.status?.name ?? ""))) break;
    if (attempt < o.pollAttempts) await sleep(o.pollMs);
  }
  const positionId = findPositionId(order);
  if (positionId === undefined) {
    log(`   No position id yet. Check later with: node scripts/smoke.mjs --tool etoro_get_order --args '{"orderId":${orderId}}' --verbose`);
    return { ok: true, stage: "executed", orderId };
  }
  log(`   Position opened: id ${positionId}`);
  log(`   Execution details: ${shorten(JSON.stringify(order.positionExecutions[0]), 500)}`);
  const details = await call("etoro_get_portfolio_breakdown", { limit: 200 });
  const mine = parse(details.text)?.positions?.items?.find((x) => Number(x.positionID) === positionId);
  if (mine) {
    log(
      `   In your portfolio: ${mine.symbol ?? "?"} | units ${mine.units} | open rate ${mine.openRate} | amount ${mine.amount} | leverage ${mine.leverage} | ` +
        `settlement ${mine.settlement ?? "unknown"} (settlementTypeID ${mine.settlementTypeID} | isSettled ${mine.isSettled})`,
    );
  }

  // 7. Optional close.
  if (!o.close) {
    log(`\nDone. The demo position ${positionId} stays open; re-run with --close to open and close in one go.`);
    return { ok: true, stage: "executed", orderId, positionId };
  }
  const instrumentId = Number(p.instrument?.instrumentId);
  const closePrep = await call("etoro_prepare_close_position", { positionId, instrumentId });
  if (closePrep.isError) return stop("close preview", closePrep.text);
  const cp = parse(closePrep.text);
  log(`7. Close preview: ${cp.summary}`);
  if (!opts.yes && !(await confirm("Close this DEMO position now?"))) {
    log("\nNot closed. The demo position stays open.");
    return { ok: true, stage: "executed", orderId, positionId };
  }
  const closed = await executeAction(deps, cp, o);
  if (closed.isError) return stop("close", closed.text);
  log(`   Close request accepted: ${shorten(JSON.stringify(parseAfterNote(closed.text)), 400)}`);
  log("\nDone: opened and closed a demo position through the MCP server.");
  return { ok: true, stage: "closed", orderId, positionId };
}

/** Verifies the key reaches the DEMO account; returns the connection result or undefined (after logging why). */
async function verifyDemo(call, log) {
  const conn = await call("etoro_check_connection", {});
  const c = parse(conn.text);
  if (conn.isError || !c) {
    log(`\nX connection: ${conn.text}`);
    return undefined;
  }
  const verdict = verdictOf(c);
  log(`1. Connection [${verdict.level}]: ${verdict.text}`);
  if (!c.connected || c.environment !== "demo" || !c.environmentVerified) {
    log("\nX connection: the DEMO environment could not be verified, so nothing was prepared.");
    return undefined;
  }
  return c;
}

/**
 * Closes one open DEMO position by id: previews, asks, executes and checks the position is gone.
 *   opts: { positionId, yes?, pollAttempts?, pollMs? }
 */
export async function runDemoClose(deps, opts) {
  const log = deps.log ?? console.log;
  const sleep = deps.sleep ?? sleepMs;
  const { call, confirm } = deps;
  const o = { pollAttempts: 8, pollMs: 1500, ...opts };
  const stop = (stage, message) => {
    log(`\nX ${stage}: ${message}`);
    return { ok: false, stage };
  };

  log(`DEMO CLOSE: position ${o.positionId} on the DEMO environment (virtual money)\n`);
  if (!(await verifyDemo(call, log))) return { ok: false, stage: "connection" };

  const open = await call("etoro_get_portfolio_breakdown", { limit: 200 });
  if (open.isError) return stop("positions", open.text);
  const position = parse(open.text)?.positions?.items?.find((x) => Number(x.positionID) === o.positionId);
  if (!position) return stop("position", `no open DEMO position with id ${o.positionId}.`);
  log(`2. Found: ${position.symbol ?? "instrument " + position.instrumentID} | units ${position.units} | open rate ${position.openRate} | settlement ${position.settlement ?? "unknown"} (settlementTypeID ${position.settlementTypeID} | isSettled ${position.isSettled})`);

  const prep = await call("etoro_prepare_close_position", { positionId: o.positionId, instrumentId: Number(position.instrumentID) });
  if (prep.isError) return stop("preview", prep.text);
  const p = parse(prep.text);
  log(`3. Preview (nothing sent yet): ${p.summary}`);
  for (const w of p.warnings ?? []) log(`   warning: ${w}`);

  if (!o.yes && !(await confirm("Close this DEMO position now?"))) {
    log("\nCancelled by you. The demo position stays open.");
    return { ok: false, stage: "declined" };
  }
  const exec = await executeAction(deps, p, o);
  if (exec.isError) return stop("close", exec.text);
  log(`4. eToro accepted the close request: ${shorten(JSON.stringify(parseAfterNote(exec.text)), 400)}`);

  for (let attempt = 1; attempt <= o.pollAttempts; attempt++) {
    const res = await call("etoro_get_portfolio_breakdown", { limit: 200 });
    const stillOpen = parse(res.text)?.positions?.items?.some((x) => Number(x.positionID) === o.positionId);
    if (!res.isError && !stillOpen) {
      log(`5. Position ${o.positionId} is no longer open (check ${attempt}).`);
      return { ok: true, stage: "closed", positionId: o.positionId };
    }
    if (attempt < o.pollAttempts) await sleep(o.pollMs);
  }
  log(`5. The position is still listed after ${o.pollAttempts} checks (it may be waiting for the market). Check later: npm run demo:order -- --close-position ${o.positionId}`);
  return { ok: true, stage: "closing", positionId: o.positionId };
}

/** Tiny argv helper: `--name value`, `--flag`, and short aliases such as `-y` for `--yes`. */
export function parseCli(argv) {
  const value = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i > -1 ? argv[i + 1] : undefined;
  };
  const flag = (name, short) => argv.includes(`--${name}`) || (short !== undefined && argv.includes(`-${short}`));
  return { value, flag, yes: flag("yes", "y") };
}

async function main() {
  const { value, flag, yes } = parseCli(process.argv.slice(2));

  const hasKey = (n) => Boolean(process.env[n] || process.env[`${n}_FILE`] || process.env[`${n}_CMD`]);
  if (!(hasKey("ETORO_API_KEY") && hasKey("ETORO_USER_KEY"))) {
    console.error("This needs your eToro keys in the environment (see .env.example). Use a DEMO key.");
    process.exit(1);
  }
  const closePosition = value("close-position");
  const amountUsd = Number(value("amount") ?? 50);
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
    console.error("--amount must be a positive number of USD.");
    process.exit(1);
  }
  const settlementType = value("settlement");
  if (settlementType && !["real", "cfd"].includes(settlementType)) {
    console.error("--settlement must be real or cfd.");
    process.exit(1);
  }

  if (!yes && !process.stdin.isTTY) {
    console.error("There is no terminal to ask for confirmation. Re-run with -y (or --yes) to confirm automatically (demo only).");
    process.exit(1);
  }

  // Forced settings: demo only, writes on. The script plays the person who executes: it reads the approval page's address
  // from the tool result (ETORO_SHOW_APPROVAL_URL) instead of opening a browser.
  const env = {
    ...process.env,
    ETORO_ENV: "demo",
    ETORO_USE_REAL: "",
    ETORO_ENABLE_WRITE: "true",
    ETORO_SHOW_APPROVAL_URL: "true",
    ETORO_OPEN_BROWSER: "false",
    ETORO_STRICT_KEY_SCOPE: "false",
  };
  if ((process.env.ETORO_ENV ?? "demo").toLowerCase() !== "demo") {
    console.log(`Note: ETORO_ENV is "${process.env.ETORO_ENV}" in your environment; this script forces demo.\n`);
  }

  const transport = new StdioClientTransport({ command: "node", args: [value("entry") ?? "dist/index.js"], env, stderr: "inherit" });
  const client = new Client({ name: "demo-order", version: "0.0.0" });
  await client.connect(transport);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const deps = {
    call: async (name, args) => {
      const res = await client.callTool({ name, arguments: args });
      return { isError: Boolean(res.isError), text: res.content?.[0]?.text ?? "" };
    },
    confirm: async (question) => /^y(es)?$/i.test((await rl.question(`\n${question} [y/N] `)).trim()),
    approve: (url) => pressExecute(url),
  };

  try {
    if (closePosition !== undefined) {
      const positionId = Number(closePosition);
      if (!Number.isInteger(positionId) || positionId <= 0) {
        console.error("--close-position needs a position id.");
        process.exitCode = 1;
        return;
      }
      const closed = await runDemoClose(deps, { positionId, yes });
      process.exitCode = closed.ok ? 0 : 1;
      return;
    }
    const result = await runDemoOrder(deps, {
      symbol: value("symbol") ?? "AAPL",
      amountUsd,
      settlementType,
      close: flag("close"),
      yes,
    });
    process.exitCode = result.ok ? 0 : 1;
  } finally {
    rl.close();
    await client.close();
  }
}

if (process.argv[1]?.endsWith("demo-order.mjs")) {
  await main();
}
