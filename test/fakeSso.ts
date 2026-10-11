import { ETORO_OAUTH, type OAuthEndpoints } from "../src/auth/oauth.js";

export const ENDPOINTS: OAuthEndpoints = { authorize: "https://sso.example.test/sso", token: "https://sso.example.test/token", revoke: "https://sso.example.test/revoke" };
export const CLIENT = { clientId: "client-id-1", clientSecret: "client-secret-value-1" };

/** A fake sign-in service: hands out numbered tokens and rotates the refresh token like eToro does. */
export function fakeSso(clock: { t: number }) {
  let n = 0;
  const valid = new Set<string>();
  const calls: { grant: string; auth: string; form: URLSearchParams }[] = [];
  const issue = () => {
    n++;
    valid.add(`refresh-${n}`);
    return { access_token: `access-${n}`, refresh_token: `refresh-${n}`, token_type: "Bearer", expires_in: 30 * 86400, refresh_token_expires_in: 30 * 86400, scope: "etoro-public:market-data:read etoro-public:trade.demo:read" };
  };
  const fn = (async (input: URL | string, init?: RequestInit) => {
    const url = input.toString();
    const form = new URLSearchParams(init?.body as URLSearchParams);
    const auth = (init?.headers as Record<string, string>).authorization ?? "";
    calls.push({ grant: form.get("grant_type") ?? url, auth, form });
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
    if (url === ENDPOINTS.token && form.get("grant_type") === "authorization_code") return form.get("code") === "good-code" ? json(200, issue()) : json(400, { error: "invalid_grant", error_description: "bad code" });
    if (url === ENDPOINTS.token && form.get("grant_type") === "refresh_token") {
      const rt = form.get("refresh_token") ?? "";
      if (!valid.has(rt)) return json(400, { error: "invalid_grant" });
      valid.delete(rt); // rotation: the old refresh token dies
      return json(200, issue());
    }
    if (url === ENDPOINTS.revoke) {
      valid.delete(form.get("token") ?? "");
      return json(200, {});
    }
    return json(404, {});
  }) as typeof fetch;
  return { fn, calls, valid, issued: () => n, clock };
}

/** Lets code that talks to eToro's real sign-in addresses reach the fake service instead. */
export function asEtoroSso(fn: typeof fetch): typeof fetch {
  return (async (input: URL | string, init?: RequestInit) => {
    const url = input.toString().replace(ETORO_OAUTH.revoke, ENDPOINTS.revoke).replace(ETORO_OAUTH.token, ENDPOINTS.token);
    return fn(url, init);
  }) as typeof fetch;
}
