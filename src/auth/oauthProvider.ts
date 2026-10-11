import { randomUUID } from "node:crypto";
import { PolicyError } from "../errors.js";
import { type OAuthHttp, OAuthError, type TokenSet } from "./oauth.js";
import type { AuthProvider } from "./provider.js";
import type { StoredTokens, TokenStore } from "./store.js";

const RENEW_MARGIN_MS = 60_000;
const WAIT_FOR_OTHER_MS = 20_000;

export const NOT_SIGNED_IN =
  "Not signed in to eToro. Run `etoro-mcp-server auth login` (see the README, section Sign in with OAuth) and try again.";

/**
 * Authenticates with the OAuth tokens in the shared store. The access token lasts 30 days; it is renewed shortly before it
 * expires, or once after eToro answers 401. Renewal is serialised across processes through the store's lease.
 */
export class OAuthAuth implements AuthProvider {
  readonly mode = "oauth" as const;
  private readonly owner = randomUUID();
  private inFlight?: Promise<StoredTokens>;
  /** The access token last handed out, so a 401 can tell "this token is bad" from "someone already replaced it". */
  private lastUsed?: string;

  constructor(
    private readonly clientId: string,
    private readonly store: TokenStore,
    private readonly http: OAuthHttp,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
    private readonly log: (line: string) => void = () => {},
  ) {}

  async headers(): Promise<Record<string, string>> {
    let tokens = this.store.load(this.clientId);
    if (!tokens) throw new PolicyError(NOT_SIGNED_IN);
    if (tokens.accessExpiresAt - this.now() < RENEW_MARGIN_MS) {
      try {
        tokens = await this.renewShared(tokens.accessToken);
      } catch (err) {
        // A token that has not expired yet still works if the renewal service is briefly away.
        if (tokens.accessExpiresAt <= this.now()) throw this.asPolicy(err);
      }
    }
    this.lastUsed = tokens.accessToken;
    return { authorization: `Bearer ${tokens.accessToken}` };
  }

  async renew(): Promise<boolean> {
    const stale = this.lastUsed;
    if (stale === undefined) return false;
    try {
      await this.renewShared(stale);
      return true;
    } catch (err) {
      this.log(`[auth] could not renew the eToro token: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  secrets(): string[] {
    const t = this.store.load(this.clientId);
    return t ? [t.accessToken, t.refreshToken] : [];
  }

  private asPolicy(err: unknown): Error {
    if (err instanceof OAuthError && (err.code === "invalid_grant" || err.status === 400 || err.status === 401)) {
      return new PolicyError("The eToro sign-in is no longer valid (revoked or expired). Run `etoro-mcp-server auth login` again.");
    }
    return err instanceof Error ? err : new Error(String(err));
  }

  /** One renewal at a time inside this process; across processes the lease decides. `stale` is the access token that must be replaced. */
  private renewShared(stale: string): Promise<StoredTokens> {
    this.inFlight ??= this.doRenew(stale).finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async doRenew(stale: string): Promise<StoredTokens> {
    const deadline = this.now() + WAIT_FOR_OTHER_MS;
    for (;;) {
      const current = this.store.load(this.clientId);
      if (!current) throw new PolicyError(NOT_SIGNED_IN);
      // Another process (or an earlier call) already replaced the token we were asked to replace.
      if (current.accessToken !== stale && current.accessExpiresAt - this.now() >= RENEW_MARGIN_MS) return current;
      if (this.store.tryAcquire(this.owner)) {
        try {
          const latest = this.store.load(this.clientId);
          if (!latest) throw new PolicyError(NOT_SIGNED_IN);
          if (latest.accessToken !== stale && latest.accessExpiresAt - this.now() >= RENEW_MARGIN_MS) return latest;
          const next: TokenSet = await this.http.refresh(latest);
          this.store.save(this.clientId, next);
          return this.store.load(this.clientId) as StoredTokens;
        } finally {
          this.store.release(this.owner);
        }
      }
      if (this.now() >= deadline) throw new OAuthError("Timed out waiting for another process to renew the eToro token.", "timeout");
      await this.sleep(250);
    }
  }
}
