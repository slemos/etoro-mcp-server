// Adds a Node shebang to the compiled entry point so `npx etoro-mcp-server` works.
import { readFileSync, writeFileSync, chmodSync } from "node:fs";

const file = new URL("../dist/index.js", import.meta.url);
const src = readFileSync(file, "utf8");
if (!src.startsWith("#!")) {
  writeFileSync(file, `#!/usr/bin/env node\n${src}`);
}
chmodSync(file, 0o755);
