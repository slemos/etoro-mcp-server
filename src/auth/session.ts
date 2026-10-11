import { startLogin, type LoginHandle, type LoginResult } from "./login.js";
import type { OAuthHttp } from "./oauth.js";
import type { StoredTokens, TokenStore } from "./store.js";
import type { OAuthSettings } from "../config.js";

export interface SignInStatus {
  signedIn: boolean;
  scopes: string[];
  accessExpiresAt: number | null;
  /** Requested in the configuration but missing from the token. */
  missingScopes: string[];
  pending: boolean;
  lastFailure: string | null;
}

/** The sign-in as the running server sees it: one flow at a time, started from a tool, finished in the browser. */
export class SignInSession {
  private handle?: LoginHandle;
  private lastFailure: string | null = null;

  constructor(
    private readonly auth: OAuthSettings,
    private readonly store: TokenStore,
    private readonly http: OAuthHttp,
    private readonly openUrl: (url: string) => Promise<boolean>,
  ) {}

  status(): SignInStatus {
    const t = this.store.load(this.auth.clientId);
    return {
      signedIn: t !== undefined,
      scopes: t?.scopes ?? [],
      accessExpiresAt: t?.accessExpiresAt ?? null,
      missingScopes: t ? this.auth.scopes.filter((s) => !t.scopes.includes(s)) : this.auth.scopes,
      pending: this.handle !== undefined,
      lastFailure: this.lastFailure,
    };
  }

  /** Starts the browser flow, or reports the one already running. The result arrives later: see status(). */
  async begin(): Promise<{ started: boolean; opened: boolean; url: string }> {
    if (this.handle) return { started: false, opened: true, url: this.handle.url };
    this.lastFailure = null;
    const handle = await startLogin(this.auth, { http: this.http, store: this.store, openUrl: this.openUrl });
    this.handle = handle;
    handle.done
      .then((r: LoginResult) => {
        this.lastFailure = r.missingScopes.length > 0 ? `Signed in, but eToro did not grant: ${r.missingScopes.join(", ")}.` : null;
      })
      .catch((err: unknown) => {
        this.lastFailure = err instanceof Error ? err.message : String(err);
      })
      .finally(() => {
        this.handle = undefined;
      });
    return { started: true, opened: handle.opened, url: handle.url };
  }

  /** Revokes the refresh token at eToro (this also ends the access token) and forgets the tokens. */
  async signOut(): Promise<{ revoked: boolean; wasSignedIn: boolean }> {
    this.handle?.cancel();
    const tokens: StoredTokens | undefined = this.store.load(this.auth.clientId);
    if (!tokens) return { revoked: false, wasSignedIn: false };
    let revoked = true;
    try {
      await this.http.revoke(tokens.refreshToken);
    } catch {
      revoked = false;
    }
    this.store.clear();
    return { revoked, wasSignedIn: true };
  }
}
