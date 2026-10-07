/**
 * The approval page: a tiny local web server through which the user, and nobody else, executes a proposal.
 *
 * Claude can prepare an action but has no tool that executes it. The server opens this page in the user's browser; the
 * user presses Execute, and only then does the proposal store run the action. Hardening, because it is a web server:
 *  - listens on 127.0.0.1 only, on a random port, started on first use and never kept alive by itself;
 *  - one 256-bit secret in the address of each proposal, never handed to the model by default;
 *  - the Host header must be the loopback address and port (DNS rebinding), POSTs need a matching Origin and the
 *    page's anti-CSRF value (cross-site requests), and a GET never executes anything;
 *  - pages are plain HTML with every external string escaped, no JavaScript, and a CSP that forbids scripts anyway.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Config } from "../config.js";
import { parseHistoryQuery } from "../history/query.js";
import { renderAction, renderCsv, renderHistory } from "../history/render.js";
import { dayKey } from "../history/time.js";
import type { Proposal, ProposalStore } from "./proposals.js";
import { renderMessage, renderTicket } from "./render.js";

export interface TicketServerDeps {
  now?: () => number;
  /** Opens the page in the user's browser; resolves false if it cannot. */
  openUrl?: (url: string) => Promise<boolean>;
  log?: (line: string) => void;
  /** Enables the read-only history pages (limits and time zone come from here). */
  config?: Pick<Config, "env" | "timezone" | "maxDailyUsd" | "maxDailyWrites">;
}

const TICKET_PATH = /^\/t\/([A-Za-z0-9_-]{20,64})(?:\/(execute|reject))?$/;
const HISTORY_PATH = /^\/h\/([A-Za-z0-9_-]{20,64})(?:\/(export\.csv)|\/a\/([0-9a-fA-F-]{36}))?$/;
const MAX_BODY = 2048;
const HISTORY_TTL_MS = 60 * 60_000;
const MAX_HISTORY_LINKS = 5;
const EXPORT_MAX_ROWS = 10_000;

const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  // Not "no-referrer": with it browsers send "Origin: null" on the page's own form posts, which the Origin check must refuse.
  "referrer-policy": "same-origin",
  "cache-control": "no-store",
  "cross-origin-resource-policy": "same-origin",
};

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export class TicketServer {
  private server?: Server;
  private port?: number;
  private starting?: Promise<number>;
  /** Secret addresses of the history page, each valid for a while. Read-only: nothing here can change anything. */
  private readonly historyLinks = new Map<string, number>();
  private readonly now: () => number;

  constructor(
    private readonly store: ProposalStore,
    private readonly deps: TicketServerDeps = {},
  ) {
    this.now = deps.now ?? Date.now;
  }

  /** Address of a proposal's approval page. Starts the server on first use. */
  async urlFor(proposal: Proposal): Promise<string> {
    const port = await this.listen();
    return `http://127.0.0.1:${port}/t/${proposal.token}`;
  }

  /** Opens the page in the browser. The address is always logged to stderr, which never goes to the model. */
  async open(proposal: Proposal, openBrowser: boolean): Promise<boolean> {
    const url = await this.urlFor(proposal);
    this.deps.log?.(`[approval] ${proposal.tool} waiting for the user: ${url}`);
    if (!openBrowser || !this.deps.openUrl) return false;
    try {
      return await this.deps.openUrl(url);
    } catch {
      return false;
    }
  }

  /** A fresh address of the history page, valid for an hour. Starts the server on first use. */
  async historyUrl(): Promise<string> {
    const port = await this.listen();
    const t = this.now();
    for (const [token, expires] of this.historyLinks) if (expires <= t) this.historyLinks.delete(token);
    while (this.historyLinks.size >= MAX_HISTORY_LINKS) {
      const oldest = this.historyLinks.keys().next().value;
      if (oldest === undefined) break;
      this.historyLinks.delete(oldest);
    }
    const token = randomBytes(32).toString("base64url");
    this.historyLinks.set(token, t + HISTORY_TTL_MS);
    return `http://127.0.0.1:${port}/h/${token}`;
  }

  /** Opens the history page in the browser. The address is logged to stderr, never given to the model. */
  async openHistory(openBrowser: boolean): Promise<{ opened: boolean; url: string }> {
    const url = await this.historyUrl();
    this.deps.log?.(`[history] page for the user: ${url}`);
    if (!openBrowser || !this.deps.openUrl) return { opened: false, url };
    try {
      return { opened: await this.deps.openUrl(url), url };
    } catch {
      return { opened: false, url };
    }
  }

  private validHistoryToken(candidate: string): boolean {
    const t = this.now();
    let found = false;
    for (const [token, expires] of this.historyLinks) {
      if (safeEqual(candidate, token) && expires > t) found = true;
    }
    return found;
  }

  private handleHistory(req: IncomingMessage, res: ServerResponse, match: RegExpExecArray): void {
    const config = this.deps.config;
    const [, token, exportName, actionId] = match;
    if (!config || !token || !this.validHistoryToken(token)) {
      return this.send(res, 404, "text/html", renderMessage("Not found", "This history link is unknown or has expired. Ask Claude to open the history again."));
    }
    if (req.method !== "GET") return this.send(res, 405, "text/plain", "Method not allowed", { allow: "GET" });
    const db = this.store.db;
    const base = `/h/${token}`;
    const params = new URL(req.url ?? "/", "http://127.0.0.1").searchParams;
    const get = (name: string) => params.get(name) ?? undefined;

    if (actionId) {
      const action = db.get(actionId);
      if (!action) return this.send(res, 404, "text/html", renderMessage("Not found", "That action is not in the history."));
      return this.send(res, 200, "text/html", renderAction(action, db.events(actionId), { base, timezone: config.timezone }));
    }

    const parsed = parseHistoryQuery({ q: get("q"), env: get("env"), tool: get("tool"), status: get("status"), from: get("from"), to: get("to"), offset: Number(get("offset") ?? 0) }, config.timezone);
    if (exportName) {
      const { rows } = db.search({ ...parsed.filter, limit: EXPORT_MAX_ROWS, offset: 0 });
      return this.send(res, 200, "text/csv", renderCsv(rows, config.timezone), {
        "content-disposition": `attachment; filename="etoro-history-${dayKey(this.now(), config.timezone)}.csv"`,
      });
    }
    const { total, rows } = db.search(parsed.filter);
    const today = (["demo", "real"] as const).map((env) => ({ env, usage: db.usage(env, this.now(), config.timezone) }));
    return this.send(
      res,
      200,
      "text/html",
      renderHistory({
        base,
        timezone: config.timezone,
        env: config.env,
        filter: parsed.filter,
        form: parsed.form,
        total,
        rows,
        tools: db.tools(),
        today: today.filter((t) => t.env === config.env || t.usage.writes > 0),
        maxDailyUsd: config.maxDailyUsd,
        maxDailyWrites: config.maxDailyWrites,
        persistent: db.persistent,
        notice: parsed.problems.join(" ") || undefined,
      }),
    );
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.port = undefined;
    this.starting = undefined;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private listen(): Promise<number> {
    if (this.port !== undefined) return Promise.resolve(this.port);
    this.starting ??= new Promise<number>((resolve, reject) => {
      const server = createServer((req, res) => void this.handle(req, res).catch(() => this.send(res, 500, "text/plain", "Error")));
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.unref(); // never keep the MCP process alive just for this page
        this.server = server;
        this.port = (server.address() as AddressInfo).port;
        resolve(this.port);
      });
    });
    return this.starting;
  }

  private send(res: ServerResponse, status: number, type: string, body: string, extra: Record<string, string> = {}): void {
    res.writeHead(status, { "content-type": `${type}; charset=utf-8`, ...SECURITY_HEADERS, ...extra });
    res.end(body);
  }

  private async readBody(req: IncomingMessage): Promise<string | undefined> {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY) return undefined;
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const port = this.port;
    const host = req.headers.host ?? "";
    // DNS rebinding: a hostile site that resolves to 127.0.0.1 still sends its own name in Host.
    if (port === undefined || (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`)) {
      return this.send(res, 403, "text/plain", "Forbidden");
    }
    const pathname = (req.url ?? "").split("?")[0] ?? "";
    const historyMatch = HISTORY_PATH.exec(pathname);
    if (historyMatch) return this.handleHistory(req, res, historyMatch);
    const match = TICKET_PATH.exec(pathname);
    if (!match) return this.send(res, 404, "text/plain", "Not found");
    const proposal = this.store.getByToken(match[1]!);
    if (!proposal) {
      return this.send(res, 404, "text/html", renderMessage("Not found", "This approval link is unknown or has expired. Ask Claude to prepare the action again."));
    }
    const action = match[2];

    if (req.method === "GET" && !action) {
      return this.send(res, 200, "text/html", renderTicket(proposal, { now: this.now() }));
    }
    if (req.method !== "POST" || !action) {
      return this.send(res, 405, "text/plain", "Method not allowed", { allow: action ? "POST" : "GET" });
    }

    // Cross-site requests: the browser states the page that sent a form POST (and, in modern ones, how it relates to us).
    const fetchSite = req.headers["sec-fetch-site"];
    if (req.headers.origin !== `http://${host}` || (fetchSite !== undefined && fetchSite !== "same-origin")) {
      return this.send(res, 403, "text/plain", "Forbidden");
    }
    if (!(req.headers["content-type"] ?? "").startsWith("application/x-www-form-urlencoded")) {
      return this.send(res, 415, "text/plain", "Unsupported media type");
    }
    const body = await this.readBody(req);
    if (body === undefined) return this.send(res, 413, "text/plain", "Too large");
    const csrf = new URLSearchParams(body).get("csrf") ?? "";
    if (!safeEqual(csrf, proposal.csrf)) return this.send(res, 403, "text/plain", "Forbidden");

    let message: string | undefined;
    if (action === "execute") {
      const outcome = await this.store.execute(proposal.id);
      if (outcome.outcome === "blocked") message = outcome.message;
    } else {
      this.store.reject(proposal.id);
    }
    if (message) return this.send(res, 200, "text/html", renderTicket(proposal, { now: this.now(), message }));
    res.writeHead(303, { location: `/t/${proposal.token}`, ...SECURITY_HEADERS });
    res.end();
  }
}
