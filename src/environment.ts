/**
 * Which eToro environment does the key pair belong to, and which account answers?
 *
 * eToro keys are environment-specific (Demo or Real, Read or Write). `GET /api/v1/me` returns the
 * key's `scopes` plus the user's `realCid` and `demoCid`, and the portfolio snapshot returns the
 * `cid` it was computed for. Comparing them lets the server prove, instead of assume, that
 * ETORO_ENV matches the account it is touching.
 */
import type { EtoroClient } from "./client.js";
import type { Config, EtoroEnv } from "./config.js";
import { R } from "./endpoints.js";
import { PolicyError } from "./errors.js";
import { asRecord } from "./instruments.js";

export interface Identity {
  gcid?: number;
  realCid?: number;
  demoCid?: number;
  username?: string;
  scopes: string[];
}

export interface EnvScopes {
  read: boolean;
  write: boolean;
}

const num = (value: unknown): number | undefined => {
  const n = Number(value);
  return Number.isFinite(n) && value !== null && value !== "" ? n : undefined;
};

export function parseIdentity(raw: unknown): Identity {
  const r = asRecord(raw);
  return {
    gcid: num(r.gcid),
    realCid: num(r.realCid),
    demoCid: num(r.demoCid),
    username: typeof r.username === "string" ? r.username : undefined,
    scopes: Array.isArray(r.scopes) ? r.scopes.filter((s): s is string => typeof s === "string") : [],
  };
}

/** Reads the environment and permission out of scope names such as `etoro-public:demo:write` or `etoro-public:trade.real:read`. */
export function scopesByEnvironment(scopes: string[]): Record<EtoroEnv, EnvScopes> {
  const out: Record<EtoroEnv, EnvScopes> = { demo: { read: false, write: false }, real: { read: false, write: false } };
  for (const scope of scopes) {
    for (const env of ["demo", "real"] as const) {
      if (new RegExp(`(^|[:.])${env}([:.]|$)`).test(scope)) {
        if (scope.endsWith(":write")) out[env].write = true;
        if (scope.endsWith(":read")) out[env].read = true;
      }
    }
  }
  return out;
}

/** Which account does a portfolio `cid` belong to, according to /me? */
export function ownerOfCid(cid: number | undefined, identity: Identity): EtoroEnv | "unknown" {
  if (cid === undefined) return "unknown";
  if (cid === identity.demoCid) return "demo";
  if (cid === identity.realCid) return "real";
  return "unknown";
}

export async function fetchIdentity(client: EtoroClient): Promise<Identity> {
  return parseIdentity(await client.call(R.me()));
}

export async function fetchSnapshotCid(client: EtoroClient, env: EtoroEnv): Promise<number | undefined> {
  const snapshot = await client.call(R.portfolioSnapshot(env), { query: { pnlLevel: "None" } });
  return num(asRecord(snapshot).cid);
}

const CACHE_MS = 5 * 60_000;

/**
 * Fail-closed check run before any trading action is previewed: the key must be able to write in
 * the configured environment, and the account that answers must not be the other one.
 */
export class KeyGuard {
  private cached?: { at: number };

  constructor(
    private readonly client: EtoroClient,
    private readonly cfg: Config,
    private readonly now: () => number = Date.now,
  ) {}

  async assertWritable(): Promise<void> {
    if (this.cached && this.now() - this.cached.at < CACHE_MS) return;
    const env = this.cfg.env;
    const other: EtoroEnv = env === "demo" ? "real" : "demo";

    let identity: Identity;
    try {
      identity = await fetchIdentity(this.client);
    } catch {
      throw new PolicyError(
        "Could not verify which eToro environment the key belongs to (the identity call failed), so no trading action was prepared. " +
          "Run etoro_check_connection to see why.",
      );
    }

    const scoped = scopesByEnvironment(identity.scopes);
    if (identity.scopes.length > 0) {
      if (!scoped[env].write) {
        const where = scoped[other].write || scoped[other].read ? ` The key is for the ${other} environment.` : "";
        throw new PolicyError(
          `The key does not have Write permission for the ${env} environment, so no trading action was prepared.${where} ` +
            `Scopes reported by eToro: ${identity.scopes.join(", ")}. Create a Write key for ${env}, or set ETORO_ENV to match the key.`,
        );
      }
    }

    if (this.cfg.strictKeyScope && scoped[other].write) {
      throw new PolicyError(
        `ETORO_STRICT_KEY_SCOPE is on and this key can also write in the ${other} environment (scopes: ${identity.scopes.join(", ")}), so no trading action was prepared. ` +
          `Use a key limited to ${env}, or turn the setting off if you accept that risk.`,
      );
    }

    // Independent check: which account does the configured environment's route actually serve?
    let owner: EtoroEnv | "unknown" = "unknown";
    try {
      owner = ownerOfCid(await fetchSnapshotCid(this.client, env), identity);
    } catch {
      // Handled below: inconclusive.
    }
    if (owner !== "unknown" && owner !== env) {
      throw new PolicyError(
        `ETORO_ENV is ${env} but eToro answered with data from your ${owner.toUpperCase()} account, so no trading action was prepared. ` +
          "Run etoro_check_connection for details.",
      );
    }
    if (identity.scopes.length === 0 && owner === "unknown") {
      throw new PolicyError(
        "eToro did not report the key's permissions and the account could not be identified, so the environment could not be verified; no trading action was prepared.",
      );
    }
    this.cached = { at: this.now() };
  }
}
