#!/usr/bin/env node
/**
 * Smoke test that launches the built server over stdio, like an MCP client would.
 *
 *   node scripts/smoke.mjs                      list tools using dummy keys (no network call to eToro)
 *   node scripts/smoke.mjs --report             ONLY verify the connection and environment: prints a verdict, reads no account data
 *   node scripts/smoke.mjs --live               also check the connection and call a few read tools
 *                                               with YOUR keys from the environment (prints response SHAPES only)
 *
 * Options (with --live or --tool):
 *   --verbose               print each tool's full output (contains YOUR account data, keep it private)
 *   --mask                  with --verbose: replace every value by a placeholder, keeping field names,
 *                           types and nesting (arrays show 3 samples). Safe to paste into an issue or chat.
 *   --tool <name>           call one tool instead of the default set (implies --live)
 *   --args '<json>'         arguments for --tool, e.g. --args '{"minDate":"2026-01-01"}'
 *   --debug                 make the server log each HTTP call (method, path, status, time) to stderr
 *   --entry <file>          server entry point to launch (default dist/index.js; use server/index.js for the bundle)
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i > -1 ? argv[i + 1] : undefined;
};

const toolName = value("tool");
const report = flag("report");
const live = flag("live") || report || toolName !== undefined;
const verbose = flag("verbose");
const mask = flag("mask");
const entry = value("entry") ?? "dist/index.js";

// A key can come from the variable itself, <NAME>_FILE or <NAME>_CMD (see README, "Securing your setup").
const hasKey = (name) => Boolean(process.env[name] || process.env[`${name}_FILE`] || process.env[`${name}_CMD`]);
if (live && !(hasKey("ETORO_API_KEY") && hasKey("ETORO_USER_KEY"))) {
  console.error("This needs the eToro keys in the environment (ETORO_API_KEY / ETORO_USER_KEY, or their _FILE / _CMD forms; see .env.example).");
  process.exit(1);
}
let toolArgs = {};
if (value("args")) {
  try {
    toolArgs = JSON.parse(value("args"));
  } catch {
    console.error("--args must be valid JSON.");
    process.exit(1);
  }
}

const env = {
  ...process.env,
  ...(hasKey("ETORO_API_KEY") ? {} : { ETORO_API_KEY: "dummy-api-key-for-smoke-test" }),
  ...(hasKey("ETORO_USER_KEY") ? {} : { ETORO_USER_KEY: "dummy-user-key-for-smoke-test" }),
  ...(flag("debug") ? { ETORO_DEBUG: "true" } : {}),
};

/** Replace values by placeholders, keeping names, types and nesting. */
export function maskValue(v) {
  if (Array.isArray(v)) {
    const sample = v.slice(0, 3).map(maskValue);
    return v.length > 3 ? [...sample, `... (${v.length - 3} more items)`] : sample;
  }
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, maskValue(x)]));
  if (typeof v === "number") return "<number>";
  if (typeof v === "string") return `<string, ${v.length} chars>`;
  return v; // booleans and null carry no account data
}

/** Describes a tool result's structure (key names, sizes) without printing any values. */
export function describeText(text) {
  const truncated = text.includes("[truncated");
  let kind;
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) kind = `array(${parsed.length})`;
    else if (parsed && typeof parsed === "object") {
      const parts = Object.entries(parsed).map(
        ([k, v]) => `${k}: ${Array.isArray(v) ? `array(${v.length})` : v === null ? "null" : typeof v}`,
      );
      kind = `object { ${parts.join(", ")} }`;
    } else kind = `JSON ${typeof parsed}${typeof parsed === "string" ? ` (length ${parsed.length})` : ""}`;
  } catch {
    kind = "text that is not valid JSON";
  }
  return `${kind}; ${text.length} chars${truncated ? "; TRUNCATED by the server size cap" : ""}`;
}

/** One-line, plain-language conclusion from an etoro_check_connection result. */
export function verdictOf(c) {
  if (!c.connected) return { level: "FAIL", text: "eToro did not accept the keys." };
  const env = c.environment;
  const other = env === "demo" ? "real" : "demo";
  const owner = c.dataBelongsTo;
  if (owner !== "unknown" && owner !== env) {
    return { level: "MISMATCH", text: `ETORO_ENV is ${env} but the data belongs to your ${String(owner).toUpperCase()} account.` };
  }
  if (c.otherEnvironmentRoute?.sameAccountAsConfigured) {
    return { level: "INCONCLUSIVE", text: `The ${env} and ${other} routes return the same account; the environment cannot be told apart through the API.` };
  }
  if (c.keyIsFor.length > 0 && !c.keyIsFor.includes(env)) {
    return { level: "MISMATCH", text: `ETORO_ENV is ${env} but the key is for: ${c.keyIsFor.join(", ")}.` };
  }
  if (c.environmentVerified) {
    const crossed = c.otherEnvironmentRoute?.belongsTo;
    const proof = crossed && crossed !== "unknown" ? ` The ${other} route serves your ${crossed.toUpperCase()} account, so the two environments are separate.` : "";
    const canTradeOther = (c.advice ?? []).some((a) => a.includes("ALSO place orders"));
    const risk = canTradeOther ? ` WARNING: this key can also place orders with ${other.toUpperCase()} money.` : "";
    return { level: "OK", text: `Confirmed ${env.toUpperCase()}: the ${env} route serves your ${String(owner).toUpperCase()} account.${proof}${risk}` };
  }
  const blocker = (c.warnings ?? []).find((w) => !w.startsWith("eToro did not report"));
  return { level: "INCONCLUSIVE", text: blocker ?? "Not enough information to verify the environment." };
}

function printFull(text) {
  if (!mask) return console.log(text);
  try {
    console.log(JSON.stringify(maskValue(JSON.parse(text)), null, 2));
  } catch {
    // Not JSON (for example cut by the size cap): never print the content, only its makeup.
    const letters = (text.match(/[A-Za-z]/g) ?? []).length;
    const digits = (text.match(/\d/g) ?? []).length;
    console.log(
      `<not JSON: ${text.length} chars (${letters} letters, ${digits} digits, ${text.length - letters - digits} other); ` +
        `first character ${JSON.stringify(text[0] ?? "")}>`,
    );
  }
}

async function main() {
  const transport = new StdioClientTransport({ command: "node", args: [entry], env, stderr: "inherit" });
  const client = new Client({ name: "smoke-test", version: "0.0.0" });
  await client.connect(transport);

  const { tools } = await client.listTools();
  console.log(`Server exposes ${tools.length} tools:`);
  for (const t of tools) {
    const kind = t.annotations?.readOnlyHint ? "read " : "WRITE";
    console.log(`  [${kind}] ${t.name}`);
  }

  async function run(name, args = {}) {
    const res = await client.callTool({ name, arguments: args });
    const text = res.content?.[0]?.text ?? "";
    if (res.isError) {
      console.log(`\n${name}: ERROR`);
      console.log(verbose ? text : `  ${text.split("\n")[0]}`);
      return;
    }
    console.log(`\n${name}: ok, ${describeText(text)}`);
    if (verbose) printFull(text);
  }

  if (verbose && !mask && live) {
    console.log("\n!! --verbose prints your real account data. Do not paste it publicly; add --mask to hide values.");
  }

  if (toolName) {
    await run(toolName, toolArgs);
  } else if (live) {
    const check = await client.callTool({ name: "etoro_check_connection", arguments: {} });
    const checkText = check.content?.[0]?.text ?? "";
    try {
      const c = JSON.parse(checkText);
      console.log(`\nConnection: ${c.connected ? "CONNECTED" : "NOT CONNECTED"} | configured environment: ${c.environment}`);
      if (c.account) console.log(`  account: ${c.account.username ?? "?"} (gcid ${c.account.gcid}, demoCid ${c.account.demoCid}, realCid ${c.account.realCid})`);
      console.log(`  key scopes: ${c.keyScopes.join(", ") || "(none reported)"}`);
      console.log(`  key is for: ${c.keyIsFor.join(", ") || "unknown"} | data returned belongs to: ${String(c.dataBelongsTo).toUpperCase()} | environment verified: ${c.environmentVerified}`);
      if (c.otherEnvironmentRoute) {
        const o = c.otherEnvironmentRoute;
        console.log(`  cross-check: the ${o.environment} route ${o.answered ? "ANSWERED" : "was rejected"}${o.sameAccountAsConfigured === true ? " with the SAME account" : o.belongsTo && o.belongsTo !== "unknown" ? ` with your ${o.belongsTo.toUpperCase()} account` : o.sameAccountAsConfigured === false ? " with a different account" : ""}`);
      }
      for (const w of c.warnings) console.log(`  !! ${w}`);
      for (const a of c.advice ?? []) console.log(`  -> ${a}`);
      for (const k of c.checks) console.log(`  [${k.ok ? "ok  " : "FAIL"}] ${k.name}${k.ms !== undefined ? ` (${k.ms} ms)` : ""}: ${k.detail}`);
      console.log(`  mode: write tools ${c.mode.writeToolsRegistered ? "ON" : "off"} | client can show confirmation prompts: ${c.client.supportsConfirmationPrompts}`);
      const v = verdictOf(c);
      console.log(`\nVERDICT [${v.level}]: ${v.text}`);
    } catch {
      console.log(`etoro_check_connection: ${describeText(checkText)}`);
    }
    if (!report) {
      for (const name of ["etoro_get_balances", "etoro_get_portfolio_breakdown", "etoro_get_pnl"]) {
        await run(name);
      }
    }
  }

  await client.close();
}

// Run only when executed directly (lets the tests import the helpers).
if (process.argv[1]?.endsWith("smoke.mjs")) {
  await main();
}
