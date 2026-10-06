import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ConfigError, loadConfig } from "./config.js";
import { createServer, describeMode } from "./server.js";

async function main(): Promise<void> {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    // Config errors never contain key values.
    const message = err instanceof ConfigError || err instanceof Error ? err.message : String(err);
    process.stderr.write(`etoro-mcp-server: ${message}\n`);
    process.exit(1);
  }

  const { mcp } = createServer(cfg);
  await mcp.connect(new StdioServerTransport());
  // stdout carries the MCP protocol; diagnostics go to stderr.
  process.stderr.write(`${describeMode(cfg)}\n`);
}

main().catch((err) => {
  process.stderr.write(`etoro-mcp-server: fatal error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
