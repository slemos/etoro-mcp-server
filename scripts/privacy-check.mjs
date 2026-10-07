#!/usr/bin/env node
/**
 * Keeps personal data out of this public repository.
 *
 *   npm run privacy:check
 *
 * It reads every file git tracks and fails on what looks like someone's real data:
 *  - an e-mail address (except no-reply addresses and example domains);
 *  - a long number (9 digits or more) that is not obviously made up: repeated or sequential digits, powers of ten,
 *    parts of UUIDs and commit hashes are fine; any other id (an order, a position, an account) must be listed in
 *    scripts/privacy-allowlist.txt, which is a statement that the value is invented;
 *  - any line of a local `.privacy-denylist` file (one word or phrase per line, case-insensitive). That file is
 *    git-ignored on purpose: the names it holds must never be written in the repository. The check refuses to run
 *    if it is tracked. Without the file (as in CI) the first two rules still apply.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SKIP_FILES = new Set(["package-lock.json", "scripts/privacy-allowlist.txt"]);
const BINARY = /\.(png|jpe?g|gif|webp|ico|mcpb|sqlite)$/i;
const OK_EMAIL = /@(users\.noreply\.github\.com|noreply\.github\.com|anthropic\.com|example\.(com|org|net)|[a-z0-9.-]*\.example)$/i;

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const HASH = /\b[0-9a-f]{32,}\b/gi;

function obviouslyMadeUp(digits) {
  if (/^(\d)\1*$/.test(digits)) return true; // 000000000, 111111111
  if ("01234567890".includes(digits) || "9876543210987".includes(digits)) return true; // 123456789
  if (/^10+$/.test(digits)) return true; // 100000000
  return false;
}

/** Findings in one text. `allow` is a Set of invented numbers, `deny` a list of lower-case phrases. */
export function scanText(text, { allow = new Set(), deny = [] } = {}) {
  const findings = [];
  const lines = text.split("\n");
  lines.forEach((raw, i) => {
    const line = raw.replace(UUID, " ").replace(HASH, " ");
    for (const m of line.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g)) {
      if (!OK_EMAIL.test(m[0])) findings.push({ line: i + 1, rule: "email address", match: m[0] });
    }
    for (const m of line.matchAll(/(?<![\d.])\d{9,}(?![\d])/g)) {
      if (!obviouslyMadeUp(m[0]) && !allow.has(m[0])) findings.push({ line: i + 1, rule: "long number (list it in scripts/privacy-allowlist.txt only if it is invented)", match: m[0] });
    }
    const lower = raw.toLowerCase();
    for (const phrase of deny) if (lower.includes(phrase)) findings.push({ line: i + 1, rule: "local denylist", match: "(a phrase from .privacy-denylist)" });
  });
  return findings;
}

const readList = (path) =>
  existsSync(path)
    ? readFileSync(path, "utf8")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#"))
    : [];

function main() {
  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
  if (tracked.includes(".privacy-denylist")) {
    console.error("privacy-check: .privacy-denylist is tracked by git. It lists the very names that must stay out of the repository: remove it from git (git rm --cached) and keep it ignored.");
    process.exit(1);
  }
  const allow = new Set(readList(join(root, "scripts/privacy-allowlist.txt")));
  const deny = readList(join(root, ".privacy-denylist")).map((l) => l.toLowerCase());
  let bad = 0;
  for (const file of tracked) {
    if (SKIP_FILES.has(file) || BINARY.test(file)) continue;
    let text;
    try {
      text = readFileSync(join(root, file), "utf8");
    } catch {
      continue;
    }
    for (const f of scanText(text, { allow, deny })) {
      bad++;
      console.error(`${file}:${f.line}: ${f.rule}: ${f.match}`);
    }
  }
  if (bad > 0) {
    console.error(`\nprivacy-check: ${bad} possible personal data finding(s). Replace them with invented values.`);
    process.exit(1);
  }
  console.log(`privacy-check: ${tracked.length} tracked files, nothing personal found${deny.length ? ` (${deny.length} local denylist entries applied)` : " (no local denylist: only the generic rules ran)"}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
