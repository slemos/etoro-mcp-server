import type { AuthSettings } from "../config.js";
import { ETORO_OAUTH, OAuthHttp } from "./oauth.js";
import { OAuthAuth } from "./oauthProvider.js";
import { TokenStore } from "./store.js";

/**
 * How requests to eToro are authenticated. The client asks the provider for headers on every request, so a provider
 * whose credentials change over time (OAuth tokens) can renew them without the client knowing how.
 */
export interface AuthProvider {
  readonly mode: "keys" | "oauth";
  /** Credential headers for one request. eToro refuses requests that carry both kinds, so a provider returns only its own. */
  headers(): Promise<Record<string, string>>;
  /**
   * Called once after eToro answers 401. Returns true when the credentials were renewed and the request may be sent again.
   * Fixed keys cannot be renewed.
   */
  renew(): Promise<boolean>;
  /** Every secret value currently in use, so error messages and logs can be scrubbed. */
  secrets(): string[];
}

export class KeysAuth implements AuthProvider {
  readonly mode = "keys" as const;

  constructor(private readonly apiKey: string, private readonly userKey: string) {}

  async headers(): Promise<Record<string, string>> {
    return { "x-api-key": this.apiKey, "x-user-key": this.userKey };
  }

  async renew(): Promise<boolean> {
    return false;
  }

  secrets(): string[] {
    return [this.apiKey, this.userKey];
  }
}

export interface AuthDeps {
  fetchFn?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

export function createAuthProvider(auth: AuthSettings, deps: AuthDeps = {}): AuthProvider {
  if (auth.mode === "keys") return new KeysAuth(auth.apiKey, auth.userKey);
  const http = new OAuthHttp({ clientId: auth.clientId, clientSecret: auth.clientSecret }, ETORO_OAUTH, deps.fetchFn, deps.now);
  return new OAuthAuth(auth.clientId, new TokenStore(auth.tokenPath, deps.now), http, deps.now, deps.sleep, deps.log);
}

/** The secrets that come from configuration, for components that have no provider (the audit log). */
export function configuredSecrets(auth: AuthSettings): string[] {
  return auth.mode === "keys" ? [auth.apiKey, auth.userKey] : [auth.clientSecret];
}
