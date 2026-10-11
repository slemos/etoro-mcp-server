import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SCOPE_PREFIX } from "./oauth.js";

const API = "https://public-api.etoro.com";
const ICON = "https://raw.githubusercontent.com/slemos/etoro-mcp-server/main/icon.png";

export class RegisterError extends Error {
  override name = "RegisterError";
}

export interface RegisterInput {
  apiKey: string;
  userKey: string;
  name: string;
  scopes: string[];
  callbackPort: number;
  /** Where the client secret is written (mode 0600). */
  secretFile: string;
  overwrite?: boolean;
  fetchFn?: typeof fetch;
}

export interface Registered {
  clientId: string;
  secretFile: string;
  scopes: string[];
  redirectUri: string;
}

/**
 * Registers an OAuth application under the user's own eToro account, with the API key pair they pass in (it needs the
 * sso-applications:write permission). The application is restricted to the user's own account and the client secret,
 * which eToro shows once, goes straight to a file only the user can read: it is never printed.
 */
export async function registerApplication(input: RegisterInput): Promise<Registered> {
  const fetchFn = input.fetchFn ?? globalThis.fetch.bind(globalThis);
  const call = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    let res: Response;
    try {
      res = await fetchFn(`${API}${path}`, {
        method,
        headers: {
          accept: "application/json",
          "x-api-key": input.apiKey,
          "x-user-key": input.userKey,
          "x-request-id": randomUUID(),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new RegisterError("Could not reach the eToro API.");
    }
    const text = await res.text();
    let json: unknown = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      // keep {}
    }
    if (!res.ok) {
      const r = json as { title?: unknown; detail?: unknown };
      const why = [r.title, r.detail].filter((x): x is string => typeof x === "string").join(" - ").slice(0, 300);
      throw new RegisterError(`eToro answered ${res.status} on ${method} ${path}${why ? `: ${why}` : ""}${res.status === 403 || res.status === 401 ? " (does the key have the sso-applications:write permission?)" : ""}`);
    }
    return json;
  };

  if (!input.overwrite && existsSync(input.secretFile)) {
    throw new RegisterError(`${input.secretFile} already exists; it may hold the secret of an earlier application. Use another --secret-file, or --force to replace it.`);
  }

  const me = (await call("GET", "/api/v1/me")) as { gcid?: unknown; scopes?: unknown };
  const gcid = Number(me.gcid);
  if (!Number.isInteger(gcid) || gcid <= 0) throw new RegisterError("eToro did not report which account the key belongs to.");
  const have = Array.isArray(me.scopes) ? me.scopes : [];
  if (!have.includes(`${SCOPE_PREFIX}sso-applications:write`)) {
    throw new RegisterError("This key lacks the sso-applications:write permission. Create a temporary key with it in eToro (Settings > Trading > API Key Management) and run this again.");
  }

  const catalog = ((await call("GET", "/api/v1/sso/scopes")) as { scopes?: Array<{ scopeId?: number; scopeName?: string }> }).scopes ?? [];
  const ids: Array<{ scopeId: number; isMandatory: boolean }> = [];
  for (const scope of input.scopes) {
    const hit = catalog.find((c) => c.scopeName === scope);
    if (!hit || typeof hit.scopeId !== "number") {
      throw new RegisterError(`eToro has no scope called ${scope}. Known scopes: ${catalog.map((c) => c.scopeName).filter(Boolean).join(", ")}`);
    }
    ids.push({ scopeId: hit.scopeId, isMandatory: true });
  }

  const redirectUri = `http://localhost:${input.callbackPort}/callback`;
  const created = (await call("POST", "/api/v1/sso/applications", {
    applicationName: input.name,
    applicationIconUrl: ICON,
    scopes: ids,
    redirectUris: [redirectUri],
    allowedGcids: [gcid],
  })) as { application?: { clientId?: unknown }; clientSecret?: unknown };
  const clientId = created.application?.clientId;
  const secret = created.clientSecret;
  if (typeof clientId !== "string" || typeof secret !== "string") throw new RegisterError("eToro's answer did not contain the client id and secret.");

  mkdirSync(dirname(input.secretFile), { recursive: true, mode: 0o700 });
  writeFileSync(input.secretFile, `${secret}\n`, { mode: 0o600 });
  return { clientId, secretFile: input.secretFile, scopes: input.scopes, redirectUri };
}
