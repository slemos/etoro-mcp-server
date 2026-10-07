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
import { timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Proposal, ProposalStore } from "./proposals.js";
import { renderMessage, renderTicket } from "./render.js";

export interface TicketServerDeps {
  now?: () => number;
  /** Opens the page in the user's browser; resolves false if it cannot. */
  openUrl?: (url: string) => Promise<boolean>;
  log?: (line: string) => void;
}

const TICKET_PATH = /^\/t\/([A-Za-z0-9_-]{20,64})(?:\/(execute|reject))?$/;
const MAX_BODY = 2048;

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
    const match = TICKET_PATH.exec((req.url ?? "").split("?")[0] ?? "");
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
