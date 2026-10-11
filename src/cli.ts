import { createAuthProvider } from "./auth/provider.js";
import { startLogin } from "./auth/login.js";
import { ETORO_OAUTH, OAuthHttp } from "./auth/oauth.js";
import { TokenStore } from "./auth/store.js";
import { defaultOpenUrl } from "./approval/opener.js";
import { EtoroClient } from "./client.js";
import { ConfigError, type OAuthSettings, defaultDataDir, loadConfig } from "./config.js";
import { join } from "node:path";
import { RegisterError, registerApplication } from "./auth/register.js";
import { fetchIdentity } from "./environment.js";

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
  env: NodeJS.ProcessEnv;
  openUrl: (url: string) => Promise<boolean>;
  fetchFn?: typeof fetch;
  now?: () => number;
  loginTimeoutMs?: number;
}

export const USAGE = `Usage: etoro-mcp-server auth <command>

  register Create your own eToro OAuth application (one time). Needs a temporary API key pair with the
           sso-applications:write permission in ETORO_API_KEY / ETORO_USER_KEY (or their _FILE / _CMD forms).
           The client secret is written to a private file, never printed. Options: --name "..." --secret-file PATH --force
  login    Sign in to eToro in your browser (OAuth). Needs ETORO_OAUTH_CLIENT_ID and ETORO_OAUTH_CLIENT_SECRET.
  status   Show whether you are signed in, until when, and with which permissions. Add --check to ask eToro.
  logout   Revoke the tokens at eToro and delete them from this computer.
`;

const date = (ms: number): string => new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";

function oauthSettings(env: NodeJS.ProcessEnv): OAuthSettings {
  const cfg = loadConfig({ ...env, ETORO_AUTH: "oauth" });
  return cfg.auth as OAuthSettings;
}

/** `etoro-mcp-server auth ...`. Returns the process exit code. */
export async function runCli(args: string[], io: CliIo): Promise<number> {
  const [command, ...flags] = args;
  if (!command || !["login", "status", "logout", "register"].includes(command)) {
    io.err(USAGE);
    return command ? 2 : 0;
  }
  if (command === "register") return register(flags, io);
  let auth: OAuthSettings;
  try {
    auth = oauthSettings(io.env);
  } catch (err) {
    io.err(`etoro-mcp-server: ${err instanceof ConfigError ? err.message : String(err)}`);
    return 1;
  }
  const store = new TokenStore(auth.tokenPath, io.now);
  const http = new OAuthHttp({ clientId: auth.clientId, clientSecret: auth.clientSecret }, ETORO_OAUTH, io.fetchFn, io.now);
  try {
    if (command === "login") return await login(auth, store, http, io);
    if (command === "logout") return await logout(auth, store, http, io);
    return await status(auth, store, io, flags.includes("--check"));
  } finally {
    store.close();
  }
}

function flagValue(flags: string[], name: string): string | undefined {
  const i = flags.indexOf(name);
  return i >= 0 ? flags[i + 1] : undefined;
}

async function register(flags: string[], io: CliIo): Promise<number> {
  try {
    // The scopes and the port come from the same settings the server will use; the client id and secret do not exist yet.
    const oauth = loadConfig({ ...io.env, ETORO_AUTH: "oauth", ETORO_USE_OAUTH: "", ETORO_OAUTH_CLIENT_ID: "pending", ETORO_OAUTH_CLIENT_SECRET: "pending-secret", ETORO_OAUTH_CLIENT_SECRET_FILE: "", ETORO_OAUTH_CLIENT_SECRET_CMD: "" }).auth as OAuthSettings;
    const keys = loadConfig({ ...io.env, ETORO_AUTH: "keys", ETORO_USE_OAUTH: "" }).auth;
    if (keys.mode !== "keys") throw new ConfigError("API keys are required to register an application.");
    const done = await registerApplication({
      apiKey: keys.apiKey,
      userKey: keys.userKey,
      name: flagValue(flags, "--name") ?? "eToro MCP server",
      scopes: oauth.scopes,
      callbackPort: oauth.callbackPort,
      secretFile: flagValue(flags, "--secret-file") ?? join(defaultDataDir(), "oauth-client-secret"),
      overwrite: flags.includes("--force"),
      fetchFn: io.fetchFn,
    });
    io.out(`Application created under your eToro account (only your account can use it).
  Permissions it can ask for: ${done.scopes.join(", ")}
  Redirect address: ${done.redirectUri}

The client secret was saved to ${done.secretFile} (readable only by you) and not printed. Configure the server with:

  ETORO_AUTH=oauth
  ETORO_OAUTH_CLIENT_ID=${done.clientId}
  ETORO_OAUTH_CLIENT_SECRET_FILE=${done.secretFile}

Then sign in (ask Claude to call etoro_sign_in, or run: etoro-mcp-server auth login).
Now delete the temporary API key in eToro (Settings > Trading > API Key Management): the server does not need it.`);
    return 0;
  } catch (err) {
    io.err(`Registration failed: ${err instanceof ConfigError || err instanceof RegisterError || err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

async function login(auth: OAuthSettings, store: TokenStore, http: OAuthHttp, io: CliIo): Promise<number> {
  try {
    const handle = await startLogin(auth, { http, store, openUrl: io.openUrl, timeoutMs: io.loginTimeoutMs });
    io.out(handle.opened ? "Opening eToro in your browser to ask for your permission..." : "Could not open a browser. Open this address yourself:");
    if (!handle.opened) io.out(handle.url);
    else io.out("(If nothing opened, copy this address into your browser:)\n" + handle.url);
    const { tokens, missingScopes } = await handle.done;
    io.out(`Signed in. Access until ${date(tokens.accessExpiresAt)}.`);
    io.out(`Permissions granted: ${tokens.scopes.join(", ") || "(none reported)"}`);
    if (missingScopes.length > 0) io.err(`Not granted (the server may lack features): ${missingScopes.join(", ")}`);
    return 0;
  } catch (err) {
    io.err(`Sign-in failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

async function logout(auth: OAuthSettings, store: TokenStore, http: OAuthHttp, io: CliIo): Promise<number> {
  const tokens = store.load(auth.clientId);
  if (!tokens) {
    io.out("Not signed in; nothing to do.");
    return 0;
  }
  let revoked = true;
  try {
    await http.revoke(tokens.refreshToken);
  } catch (err) {
    revoked = false;
    io.err(`Could not revoke the token at eToro (${err instanceof Error ? err.message : String(err)}). It is being deleted from this computer anyway; revoke the application's access in eToro to be sure.`);
  }
  store.clear();
  io.out(revoked ? "Signed out: the token was revoked at eToro and deleted from this computer." : "Signed out locally.");
  return revoked ? 0 : 1;
}

async function status(auth: OAuthSettings, store: TokenStore, io: CliIo, check: boolean): Promise<number> {
  const now = (io.now ?? Date.now)();
  const tokens = store.load(auth.clientId);
  if (!tokens) {
    io.out("Not signed in. Run: etoro-mcp-server auth login");
    return 1;
  }
  io.out(`Signed in (application ${auth.clientId}).`);
  io.out(`Access token ${tokens.accessExpiresAt > now ? "valid until" : "expired on"} ${date(tokens.accessExpiresAt)} (it is renewed automatically).`);
  if (tokens.refreshExpiresAt) io.out(`Sign-in itself lasts until ${date(tokens.refreshExpiresAt)}.`);
  io.out(`Permissions: ${tokens.scopes.join(", ") || "(none reported)"}`);
  if (!check) return 0;
  try {
    const cfg = loadConfig({ ...io.env, ETORO_AUTH: "oauth" });
    const provider = createAuthProvider(cfg.auth, { fetchFn: io.fetchFn, now: io.now });
    const me = await fetchIdentity(new EtoroClient(cfg, io.fetchFn, undefined, () => {}, provider));
    io.out(`eToro accepts the token: user ${me.username ?? "(unknown)"}, scopes ${me.scopes.join(", ") || "(none)"}.`);
    return 0;
  } catch (err) {
    io.err(`eToro did not accept the token: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

export const defaultCliIo = (): CliIo => ({
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  env: process.env,
  openUrl: defaultOpenUrl,
});
