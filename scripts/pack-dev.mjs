#!/usr/bin/env node
/**
 * Builds a throwaway .mcpb for trying changes in Claude Desktop before a release:
 *
 *   npm run pack:dev          ->  etoro-mcp-server-dev.mcpb
 *
 * Claude Desktop offers an update only when the bundle's version is higher than the installed one, and a release must not be
 * burned for every experiment. So the bundle gets the version "<package version>-dev.<seconds since the epoch>": each build is
 * higher than the previous one and lower than the release it leads to. Nothing in the repository is changed.
 *
 * (A dev build is higher than any release of an earlier version, so install it over the latest release; to go back to a
 * published release of the same or an earlier number, uninstall the dev build first.)
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const run = (command, args, cwd = root) => {
  const res = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (res.status !== 0) {
    console.error(`pack-dev: "${command} ${args.join(" ")}" failed.`);
    process.exit(res.status ?? 1);
  }
};

run("npm", ["run", "bundle", "--silent"]);

const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
const version = `${manifest.version}-dev.${Math.floor(Date.now() / 1000)}`;
const stage = mkdtempSync(join(tmpdir(), "etoro-mcpb-dev-"));
mkdirSync(join(stage, "server"));
cpSync(join(root, "server/index.js"), join(stage, "server/index.js"));
for (const file of ["icon.png", "README.md", "LICENSE", "SECURITY.md"]) {
  if (existsSync(join(root, file))) cpSync(join(root, file), join(stage, file));
}
writeFileSync(join(stage, "manifest.json"), `${JSON.stringify({ ...manifest, version }, null, 2)}\n`);

const out = join(root, "etoro-mcp-server-dev.mcpb");
run("npx", ["--yes", "@anthropic-ai/mcpb", "pack", stage, out]);
console.log(`\nDev bundle ${version}\n  ${out}`);
