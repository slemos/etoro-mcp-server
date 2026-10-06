#!/usr/bin/env node
/**
 * Smoke test that launches the built server over stdio, like an MCP client would.
 *
 *   node scripts/smoke.mjs          # lists tools using dummy keys (no network call to eToro)
 *   node scripts/smoke.mjs --live   # also calls read-only tools with YOUR keys from the environment
 *   node scripts/smoke.mjs --entry server/index.js   # test the bundled build used by the .mcpb
 *
 * In --live mode only the SHAPE of each response is printed (top-level keys and
 * array lengths), never balances, positions or any other values.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const live = process.argv.includes("--live");
const entryFlag = process.argv.indexOf("--entry");
const entry = entryFlag > -1 ? process.argv[entryFlag + 1] : "dist/index.js";
if (live && !(process.env.ETORO_API_KEY && process.env.ETORO_USER_KEY)) {
  console.error("--live needs ETORO_API_KEY and ETORO_USER_KEY in the environment (see .env.example).");
  process.exit(1);
}

const env = {
  ...process.env,
  ETORO_API_KEY: process.env.ETORO_API_KEY ?? "dummy-api-key-for-smoke-test",
  ETORO_USER_KEY: process.env.ETORO_USER_KEY ?? "dummy-user-key-for-smoke-test",
};

const transport = new StdioClientTransport({ command: "node", args: [entry], env, stderr: "inherit" });
const client = new Client({ name: "smoke-test", version: "0.0.0" });
await client.connect(transport);

const { tools } = await client.listTools();
console.log(`Server exposes ${tools.length} tools:`);
for (const t of tools) {
  const kind = t.annotations?.readOnlyHint ? "read " : "WRITE";
  console.log(`  [${kind}] ${t.name}`);
}

function shape(value, depth = 0) {
  if (Array.isArray(value)) return `array(${value.length})`;
  if (value && typeof value === "object") {
    if (depth >= 1) return "object";
    return `{ ${Object.entries(value).map(([k, v]) => `${k}: ${shape(v, depth + 1)}`).join(", ")} }`;
  }
  return typeof value;
}

if (live) {
  for (const name of ["etoro_get_balances", "etoro_get_portfolio_breakdown"]) {
    const res = await client.callTool({ name, arguments: {} });
    const text = res.content?.[0]?.text ?? "";
    if (res.isError) {
      console.log(`${name}: ERROR -> ${text.split("\n")[0]}`);
    } else {
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text.slice(0, 40);
      }
      console.log(`${name}: ok, shape ${shape(parsed)}`);
    }
  }
}

await client.close();
