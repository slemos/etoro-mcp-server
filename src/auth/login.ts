import { timingSafeEqual } from "node:crypto";
import { type Server, createServer } from "node:http";
import type { OAuthSettings } from "../config.js";
import { ETORO_OAUTH, type OAuthEndpoints, type OAuthHttp, buildAuthorizeUrl, createPkce, randomToken } from "./oauth.js";
import type { StoredTokens, TokenStore } from "./store.js";

export interface LoginDeps {
  http: OAuthHttp;
  store: TokenStore;
  openUrl: (url: string) => Promise<boolean>;
  endpoints?: OAuthEndpoints;
  /** How long to wait for the user to finish in the browser. */
  timeoutMs?: number;
  /** Loopback hosts to listen on. "localhost" can resolve to either family, so both are tried. */
  hosts?: string[];
}

export interface LoginResult {
  tokens: StoredTokens;
  /** Requested scopes eToro did not grant (the user may have unticked them). */
  missingScopes: string[];
}

export interface LoginHandle {
  /** The consent page. */
  url: string;
  /** False when no browser could be opened: the user has to open `url` by hand. */
  opened: boolean;
  /** Resolves when the user has authorised and the tokens are stored; rejects on refusal, timeout or cancel. */
  done: Promise<LoginResult>;
  cancel(): void;
}

export class LoginError extends Error {
  override name = "LoginError";
}

const safeEqual = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

const page = (title: string, body: string): string =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:16px system-ui;max-width:32em;margin:4em auto;padding:0 1em"><h1>${title}</h1><p>${body}</p>`;

/**
 * Authorization code flow with PKCE. Listens on localhost for eToro's redirect, checks it (state, Host, path), and
 * exchanges the code for tokens. Only a request carrying the right `state` can finish or abort the flow.
 */
export async function startLogin(auth: OAuthSettings, deps: LoginDeps): Promise<LoginHandle> {
  const endpoints = deps.endpoints ?? ETORO_OAUTH;
  const redirectUri = `http://localhost:${auth.callbackPort}/callback`;
  const pkce = createPkce();
  const state = randomToken();
  const allowedHosts = new Set([`localhost:${auth.callbackPort}`, `127.0.0.1:${auth.callbackPort}`, `[::1]:${auth.callbackPort}`]);
  const servers: Server[] = [];
  let settle: { resolve(v: LoginResult): void; reject(e: Error): void };
  const done = new Promise<LoginResult>((resolve, reject) => {
    settle = { resolve, reject };
  });
  done.catch(() => {}); // the caller may only look at it later

  let finished = false;
  let timer: NodeJS.Timeout | undefined;
  const finish = (error?: Error, result?: LoginResult): void => {
    if (finished) return;
    finished = true;
    if (timer) clearTimeout(timer);
    for (const s of servers) s.close();
    if (error) settle.reject(error);
    else settle.resolve(result as LoginResult);
  };

  const handler: Parameters<typeof createServer>[1] = (req, res) => {
    const reply = (status: number, title: string, text: string): void => {
      res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" });
      res.end(page(title, text));
    };
    const url = new URL(req.url ?? "/", `http://localhost:${auth.callbackPort}`);
    if (!allowedHosts.has(req.headers.host ?? "") || req.method !== "GET" || url.pathname !== "/callback") {
      reply(404, "Not found", "This address only receives the eToro sign-in.");
      return;
    }
    const got = url.searchParams.get("state");
    if (got === null || !safeEqual(got, state)) {
      reply(400, "Sign-in not recognised", "This request does not belong to the sign-in that is running. Nothing was changed.");
      return;
    }
    const refusal = url.searchParams.get("error");
    if (refusal) {
      reply(200, "Sign-in cancelled", "eToro did not authorise the access. You can close this tab.");
      finish(new LoginError(`eToro did not authorise the access (${refusal.slice(0, 60).replace(/[^\w.-]/g, "?")}).`));
      return;
    }
    const code = url.searchParams.get("code");
    if (!code || code.length > 2000) {
      reply(400, "Sign-in incomplete", "eToro did not send an authorisation code.");
      return;
    }
    // Answer first: the browser tab should not hang on the token call.
    reply(200, "Signed in", "You can close this tab and go back to Claude.");
    void (async () => {
      try {
        const granted = await deps.http.exchangeCode(code, redirectUri, pkce.verifier);
        deps.store.save(auth.clientId, granted);
        const tokens = deps.store.load(auth.clientId) as StoredTokens;
        finish(undefined, { tokens, missingScopes: auth.scopes.filter((s) => !tokens.scopes.includes(s)) });
      } catch (err) {
        finish(err instanceof Error ? err : new LoginError(String(err)));
      }
    })();
  };

  // Listen before opening the browser so a busy port is reported at once.
  const hosts = deps.hosts ?? ["127.0.0.1", "::1"];
  for (const host of hosts) {
    const server = createServer(handler);
    server.on("error", () => {});
    const listening = await new Promise<boolean>((resolve) => {
      server.once("error", () => resolve(false));
      server.listen(auth.callbackPort, host, () => resolve(true));
    });
    if (listening) servers.push(server);
    else if (host === hosts[0]) {
      for (const s of servers) s.close();
      throw new LoginError(`Port ${auth.callbackPort} on this computer is in use. Close what uses it, or choose another port (ETORO_OAUTH_PORT) and add its redirect address to your eToro application.`);
    }
  }

  timer = setTimeout(() => finish(new LoginError("Timed out waiting for the sign-in in the browser (5 minutes).")), deps.timeoutMs ?? 300_000);
  timer.unref();

  const url = buildAuthorizeUrl(endpoints, auth, { redirectUri, scopes: auth.scopes, state, nonce: randomToken(), challenge: pkce.challenge });
  const opened = await deps.openUrl(url);
  return { url, opened, done, cancel: () => finish(new LoginError("Sign-in cancelled.")) };
}
