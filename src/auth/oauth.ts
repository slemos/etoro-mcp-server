import { createHash, randomBytes } from "node:crypto";

/**
 * eToro's OAuth 2.0 / OIDC endpoints. They are fixed on purpose: a client secret and tokens are sent to these
 * addresses only, and nothing in the configuration can point them elsewhere.
 */
export interface OAuthEndpoints {
  authorize: string;
  token: string;
  revoke: string;
}

export const ETORO_OAUTH: OAuthEndpoints = {
  authorize: "https://www.etoro.com/sso",
  token: "https://www.etoro.com/api/sso/v1/token",
  revoke: "https://www.etoro.com/api/sso/v1/token/revoke",
};

export const SCOPE_PREFIX = "etoro-public:";

export interface Pkce {
  verifier: string;
  challenge: string;
}

/** PKCE with the S256 method (RFC 7636): the challenge is the SHA-256 of a random verifier. */
export function createPkce(): Pkce {
  const verifier = randomBytes(48).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export const randomToken = (bytes = 16): string => randomBytes(bytes).toString("base64url");

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms. */
  accessExpiresAt: number;
  refreshExpiresAt?: number;
  scopes: string[];
}

export class OAuthError extends Error {
  override name = "OAuthError";
  constructor(
    message: string,
    /** The OAuth error code (`invalid_grant`, ...) or "network" / "response". */
    readonly code: string,
    readonly status = 0,
  ) {
    super(message);
  }
}

export interface OAuthClientConfig {
  clientId: string;
  clientSecret: string;
}

type FetchFn = typeof fetch;

/** Builds the URL the user opens to give consent. */
export function buildAuthorizeUrl(
  endpoints: OAuthEndpoints,
  client: Pick<OAuthClientConfig, "clientId">,
  p: { redirectUri: string; scopes: string[]; state: string; nonce: string; challenge: string },
): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: client.clientId,
    redirect_uri: p.redirectUri,
    scope: p.scopes.join(" "),
    state: p.state,
    nonce: p.nonce,
    code_challenge: p.challenge,
    code_challenge_method: "S256",
  });
  return `${endpoints.authorize}?${params}`;
}

/** Talks to the token and revocation endpoints. The client authenticates with HTTP Basic (client_secret_basic). */
export class OAuthHttp {
  constructor(
    private readonly client: OAuthClientConfig,
    private readonly endpoints: OAuthEndpoints = ETORO_OAUTH,
    private readonly fetchFn: FetchFn = globalThis.fetch.bind(globalThis),
    private readonly now: () => number = Date.now,
    private readonly timeoutMs = 30_000,
  ) {}

  private async post(url: string, form: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> }> {
    const basic = Buffer.from(`${encodeURIComponent(this.client.clientId)}:${encodeURIComponent(this.client.clientSecret)}`).toString("base64");
    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", authorization: `Basic ${basic}` },
        body: new URLSearchParams(form),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new OAuthError("Could not reach eToro's sign-in service.", "network");
    }
    const text = await res.text();
    let body: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
    } catch {
      // not JSON: handled by the callers through the status
    }
    return { status: res.status, body };
  }

  private fail(status: number, body: Record<string, unknown>, what: string): never {
    // Only the standard error fields are used, so nothing else from the response (or the request) reaches a message.
    const code = typeof body.error === "string" ? body.error.slice(0, 60) : "response";
    const detail = typeof body.error_description === "string" ? `: ${body.error_description.slice(0, 200)}` : "";
    throw new OAuthError(`eToro refused the ${what} (${status}, ${code})${detail}`, code, status);
  }

  private toTokens(body: Record<string, unknown>, previous?: TokenSet): TokenSet {
    const access = body.access_token;
    const refresh = typeof body.refresh_token === "string" ? body.refresh_token : previous?.refreshToken;
    const expiresIn = Number(body.expires_in);
    if (typeof access !== "string" || access === "" || !refresh || !Number.isFinite(expiresIn) || expiresIn <= 0) {
      throw new OAuthError("eToro's token response was incomplete.", "response");
    }
    const refreshIn = Number(body.refresh_token_expires_in);
    return {
      accessToken: access,
      refreshToken: refresh,
      accessExpiresAt: this.now() + expiresIn * 1000,
      refreshExpiresAt: Number.isFinite(refreshIn) && refreshIn > 0 ? this.now() + refreshIn * 1000 : previous?.refreshExpiresAt,
      scopes: typeof body.scope === "string" ? body.scope.split(/\s+/).filter(Boolean) : (previous?.scopes ?? []),
    };
  }

  async exchangeCode(code: string, redirectUri: string, verifier: string): Promise<TokenSet> {
    const { status, body } = await this.post(this.endpoints.token, {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    });
    if (status !== 200) this.fail(status, body, "sign-in");
    return this.toTokens(body);
  }

  /** eToro rotates the refresh token: the one passed in stops working once this succeeds, so the result must be saved. */
  async refresh(current: TokenSet): Promise<TokenSet> {
    const { status, body } = await this.post(this.endpoints.token, { grant_type: "refresh_token", refresh_token: current.refreshToken });
    if (status !== 200) this.fail(status, body, "token renewal");
    return this.toTokens(body, current);
  }

  /** Revoking the refresh token also ends the access token. */
  async revoke(refreshToken: string): Promise<void> {
    const { status, body } = await this.post(this.endpoints.revoke, { token: refreshToken, token_type_hint: "refresh_token" });
    if (status !== 200) this.fail(status, body, "sign-out");
  }
}
