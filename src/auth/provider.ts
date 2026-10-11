import type { AuthSettings } from "../config.js";

/**
 * How requests to eToro are authenticated. The client asks the provider for headers on every request, so a provider
 * whose credentials change over time (OAuth tokens) can renew them without the client knowing how.
 */
export interface AuthProvider {
  readonly mode: AuthSettings["mode"];
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

export function createAuthProvider(auth: AuthSettings): AuthProvider {
  return new KeysAuth(auth.apiKey, auth.userKey);
}

/** The secrets that come from configuration, for components that have no provider (the audit log). */
export function configuredSecrets(auth: AuthSettings): string[] {
  return [auth.apiKey, auth.userKey];
}
