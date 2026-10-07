import { randomUUID } from "node:crypto";
import { type Config, transfersEnabled, writeEnabled } from "./config.js";
import type { RouteSpec } from "./endpoints.js";
import { EtoroApiError, PolicyError } from "./errors.js";
import { redact } from "./redact.js";

export interface CallOptions {
  query?: Record<string, unknown>;
  body?: unknown;
  /** Idempotency key. A fresh UUID is generated when omitted. */
  requestId?: string;
}

type FetchFn = typeof fetch;
type Sleep = (ms: number) => Promise<void>;

const MAX_ATTEMPTS = 3;
const MAX_RETRY_WAIT_MS = 15_000;

export class EtoroClient {
  constructor(
    private readonly cfg: Config,
    private readonly fetchFn: FetchFn = globalThis.fetch.bind(globalThis),
    private readonly sleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    private readonly log: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
  ) {}

  private get secrets(): string[] {
    return [this.cfg.apiKey, this.cfg.userKey];
  }

  /** Enforces the allowlist and write policy before any network call. */
  private assertAllowed(route: RouteSpec): void {
    if (!route.path.startsWith("/api/")) {
      throw new PolicyError(`Refusing to call a non-API path: ${route.path}`);
    }
    if (route.method === "GET" && route.kind !== "read") {
      throw new PolicyError("GET routes must be read routes.");
    }
    if (route.method === "DELETE" && route.kind !== "write") {
      throw new PolicyError("DELETE routes must be write routes.");
    }
    if (route.kind === "write") {
      if (!writeEnabled(this.cfg)) {
        throw new PolicyError(
          "Write operations are disabled. Set ETORO_ENABLE_WRITE=true (and ETORO_ALLOW_REAL_WRITE=true for the real environment).",
        );
      }
      if (route.id === "transfer" && !transfersEnabled(this.cfg)) {
        throw new PolicyError("Internal transfers are disabled. Set ETORO_ALLOW_TRANSFERS=true (real environment only).");
      }
    }
  }

  async call<T = unknown>(route: RouteSpec, opts: CallOptions = {}): Promise<T> {
    this.assertAllowed(route);

    const url = new URL(this.cfg.baseUrl + route.path);
    // An id of "." or ".." survives percent-encoding, and URL parsing then collapses it ("/watchlists/.." becomes
    // "/api/v1/"), which would send the request to a route that was never allowlisted. Require the path to survive parsing.
    if (url.pathname !== route.path) {
      throw new PolicyError(`Refusing route ${route.id}: its path changes when normalised, so an identifier contains a dot segment.`);
    }
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value === undefined || value === null) continue;
      url.searchParams.set(key, Array.isArray(value) ? value.join(",") : String(value));
    }

    const requestId = opts.requestId ?? randomUUID();
    const headers: Record<string, string> = {
      accept: "application/json",
      "x-request-id": requestId,
      "x-api-key": this.cfg.apiKey,
      "x-user-key": this.cfg.userKey,
    };
    if (opts.body !== undefined) headers["content-type"] = "application/json";

    for (let attempt = 1; ; attempt++) {
      const startedAt = Date.now();
      let response: Response;
      try {
        response = await this.fetchFn(url, {
          method: route.method,
          headers,
          body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
          signal: AbortSignal.timeout(this.cfg.requestTimeoutMs),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (this.cfg.debug) this.log(`[http] ${route.method} ${route.path} -> network error after ${Date.now() - startedAt}ms`);
        throw new EtoroApiError(`Network error calling eToro (${route.id}): ${redact(message, this.secrets)}`, 0);
      }

      if (this.cfg.debug) {
        const queryKeys = [...url.searchParams.keys()];
        this.log(
          `[http] ${route.method} ${route.path}${queryKeys.length ? ` (query: ${queryKeys.join(",")})` : ""} -> ${response.status} ` +
            `in ${Date.now() - startedAt}ms${attempt > 1 ? ` (attempt ${attempt})` : ""}`,
        );
      }

      // The same x-request-id is reused on retry, so a retried write stays idempotent.
      if (response.status === 429 && attempt < MAX_ATTEMPTS) {
        const retryAfter = Number(response.headers.get("retry-after"));
        const waitMs = Math.min(
          Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2000 * attempt,
          MAX_RETRY_WAIT_MS,
        );
        await this.sleep(waitMs);
        continue;
      }

      const text = await response.text();
      const parsed = parseBody(text);

      if (!response.ok) {
        const retryAfterSec = Number(response.headers.get("retry-after"));
        throw new EtoroApiError(
          `eToro API ${response.status} on ${route.id}: ${redact(describe(parsed), this.secrets)}`,
          response.status,
          Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? retryAfterSec : undefined,
        );
      }
      return parsed as T;
    }
  }
}

function parseBody(text: string): unknown {
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 2000) };
  }
}

/** Short human-readable summary of an error body (ProblemDetails or arbitrary JSON). */
function describe(body: unknown): string {
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    const parts = [b.title, b.detail, b.message, b.error].filter((p): p is string => typeof p === "string");
    if (parts.length > 0) return parts.join(" - ").slice(0, 500);
    return JSON.stringify(body).slice(0, 500);
  }
  return String(body).slice(0, 500);
}
