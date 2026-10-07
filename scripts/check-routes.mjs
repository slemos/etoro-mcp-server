#!/usr/bin/env node
/**
 * Checks every eToro route this server can call against eToro's published OpenAPI specification.
 *
 *   npm run routes:check          (needs the network; run `npm run build` first)
 *
 * The spec (https://api-portal.etoro.com/api-reference/openapi.json) is the source of truth: a route that is missing
 * there, or exists under another HTTP method, is reported and the exit code is 1. It also prints the spec's version, so a
 * jump shows up. A scheduled workflow runs this weekly. The portal blocks the default user agent of curl, so the request
 * identifies itself.
 */
import { pathToFileURL } from "node:url";

const SPEC_URL = "https://api-portal.etoro.com/api-reference/openapi.json";
const METHODS = ["get", "post", "put", "patch", "delete"];

/** "/api/v1/x/{id}/y" -> a RegExp that matches "/api/v1/x/1/y" (one segment per parameter). */
export function templateToRegExp(template) {
  const escaped = template.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\{[^}]+\}/g, "[^/]+");
  return new RegExp(`^${escaped}$`);
}

/** Compares our routes with the spec's operations. Returns the routes that are not in it. */
export function findMissing(ourRoutes, specPaths) {
  const specOps = [];
  for (const [path, item] of Object.entries(specPaths)) {
    for (const m of METHODS) if (item[m]) specOps.push({ method: m.toUpperCase(), regex: templateToRegExp(path), path });
  }
  const missing = [];
  for (const r of ourRoutes) {
    if (specOps.some((op) => op.method === r.method && op.regex.test(r.path))) continue;
    const otherMethod = specOps.filter((op) => op.regex.test(r.path)).map((op) => op.method);
    missing.push({ ...r, otherMethods: otherMethod });
  }
  return missing;
}

/** Every route in `R`, for both environments, built with placeholder arguments. */
export async function ourRoutes(R) {
  const routes = new Map();
  for (const env of ["demo", "real"]) {
    for (const make of Object.values(R)) {
      let r;
      try {
        r = make.length === 0 ? make() : make.length === 1 ? (make.toString().includes("env") ? make(env) : make("x1")) : make(env, 1);
      } catch {
        continue;
      }
      if (r?.path) routes.set(`${r.method} ${r.path}`, { id: r.id, method: r.method, path: r.path });
    }
  }
  return [...routes.values()];
}

async function main() {
  const { R } = await import(new URL("../dist/endpoints.js", import.meta.url));
  const res = await fetch(SPEC_URL, { headers: { "user-agent": "etoro-mcp-server-route-check", accept: "application/json" } });
  if (!res.ok) {
    console.error(`routes:check: could not download the specification (HTTP ${res.status}).`);
    process.exit(2);
  }
  const spec = await res.json();
  const routes = await ourRoutes(R);
  const missing = findMissing(routes, spec.paths ?? {});
  console.log(`eToro API specification ${spec.info?.version ?? "?"}: ${Object.keys(spec.paths ?? {}).length} paths. This server uses ${routes.length} routes.`);
  if (missing.length === 0) {
    console.log("All routes are in the specification.");
    return;
  }
  for (const m of missing) {
    console.error(`MISSING  ${m.method} ${m.path}  (${m.id})${m.otherMethods.length ? `  — the spec has this path with ${m.otherMethods.join(", ")}` : ""}`);
  }
  console.error(`\n${missing.length} route(s) are not in eToro's specification: check them against their reference pages.`);
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
