# eToro MCP Server (unofficial)

**Talk to your eToro account from Claude.** Ask about your portfolio in plain language, check prices and costs, and — only if you choose to turn it on — place orders that you approve one by one.

[![tests](https://img.shields.io/github/actions/workflow/status/slemos/etoro-mcp-server/ci.yml?branch=main&label=tests%20%C2%B7%20build%20%C2%B7%20security%20checks)](https://github.com/slemos/etoro-mcp-server/actions/workflows/ci.yml)
[![security](https://img.shields.io/github/actions/workflow/status/slemos/etoro-mcp-server/security.yml?branch=main&label=SAST%20%C2%B7%20dependencies%20%C2%B7%20secrets)](https://github.com/slemos/etoro-mcp-server/actions/workflows/security.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A520-339933)](package.json)
[![MCP](https://img.shields.io/badge/MCP-server-8A2BE2)](https://modelcontextprotocol.io)

> **Disclaimer.** This project is not affiliated with, endorsed by or supported by eToro. "eToro" is a trademark of its owner. Nothing here is financial advice. Trading — especially with leverage or CFDs — can lose money, and software that lets an AI act on a brokerage account can lose it faster. Read the [safety model](#safety-model), start on the **demo** environment, and check eToro's API terms before automating anything.

## What it does

[MCP](https://modelcontextprotocol.io) is the standard way to give Claude tools. This server gives Claude a set of tools that talk to the [eToro Public API](https://api-portal.etoro.com) with **your own keys**, so instead of opening the app and clicking around you can just ask:

| You say | What happens |
|---|---|
| *"How is my portfolio doing? What are my biggest positions?"* | Claude reads your positions, balances and profit and loss, and summarises them. |
| *"How are the traders I copy performing?"* | One compact summary per copied trader, with their positions available on request. |
| *"What would it cost to buy 50 dollars of AAPL, and can my account even do that?"* | Live price, the settlement types and leverage your account is offered, and an estimate of the fees. |
| *"Show my closed trades since January."* | Your trade history, filtered by date. |
| *"Buy 20 dollars of AAPL on my demo account."* | A **preview** (instrument, size, cost, environment) first. Nothing is sent until you approve that exact action; then Claude follows the order until it has a position. |
| *"Close that position."* / *"Cancel that pending order."* | Same two steps: preview, then your approval. |
| *"Add these instruments to my Tech watchlist."* | Creates and edits watchlists (no money involved). |

12 read tools, 8 write tools and one gated transfer tool; see [Tools](#tools).

**Safe by default.** It starts **read-only and on eToro's demo environment**. The tools that can move money are not even registered until you switch them on, real money needs a second switch, and every order goes through preview → your confirmation, with size caps, a rate limit and an audit log. Your keys stay on your machine (OS keychain, password manager or a protected file) and are never shown to Claude. Details in the [safety model](#safety-model).

## TL;DR: install in two minutes

You need an eToro **API key pair**; a **Read** key on the **Demo** environment is enough to start ([how to get one](#getting-etoro-api-keys)).

**Claude Desktop**

1. Download `etoro-mcp-server-<version>.mcpb` from the [latest release](https://github.com/slemos/etoro-mcp-server/releases/latest) (or build it: `npm ci && npm run mcpb:pack`).
2. Double-click it, or drag it into **Settings → Extensions**. Claude Desktop will say the extension is *unsigned*: that is expected, and you can [check where the file came from](#verifying-a-release).
3. Paste your API key and user key, keep the environment on `demo`, and leave **Enable write tools** off. The keys go to your OS keychain.
4. Start a chat and ask: *"Check my eToro connection."* Then try *"How is my portfolio doing?"*

**Claude Code**

```bash
git clone https://github.com/slemos/etoro-mcp-server.git && cd etoro-mcp-server && npm ci && npm run build
claude mcp add etoro -- node "$(pwd)/dist/index.js"   # reads ETORO_API_KEY / ETORO_USER_KEY from your environment
```

Other MCP clients and safer ways to hand over the keys (keychain, password manager, protected file) are in [Install](#install) and [Securing your setup](#securing-your-setup).

## Why you can trust it

An AI that can touch a brokerage account deserves more scrutiny than most code, so the project treats security as a feature, and checks it automatically on every change:

| Check | What it proves | Runs |
|---|---|---|
| **Tests** | Logic, the preview → confirm flow, caps and blocked paths, against a mocked eToro API and an in-memory MCP client | every push and pull request |
| **SAST** (CodeQL, `security-extended`) | No known vulnerability patterns in the TypeScript source | every push and pull request, weekly |
| **Dependency audit** (`npm audit`, registry signatures, Dependabot) | The few production dependencies have no known high-severity advisories | same, plus weekly |
| **Secret scan** (Gitleaks) | No keys or tokens in the repository or its history | same |
| **Dynamic security checks** (`npm run security:check`) | The *built* server, run as a real process with the network cut off, exposes only the tools each permission switch allows, refuses a non-eToro base URL, rejects hostile arguments before any request, cannot be made to call another API path, and never leaks the keys into results, logs or the audit trail | every CI run and release |
| **Build provenance + checksums + SBOM** | A release file was built by this repository's workflow from the tagged commit, after everything above passed | every release |

Details and the threat model are in [SECURITY.md](SECURITY.md).

**Where it stands (v0.2.0).** Early software. It has been exercised against a live eToro **demo** account: connection check, portfolio, positions, PnL, instrument lookup, eligibility, cost estimates, and placing, following and closing a demo order. Trade history, watchlists, balances and rates are covered by tests but not yet confirmed against a live account, and nothing has been run with real money. Start on demo.

## Safety model

| Layer | Default | What it does |
|---|---|---|
| Environment | `demo` | Keys and routes target eToro's demo environment unless you set `ETORO_ENV=real`. |
| Write tools | **off** | `ETORO_ENABLE_WRITE=true` registers the order/close/cancel/watchlist tools. A client cannot call a tool that does not exist. |
| Real-money writes | **off** | On `real`, write tools also need `ETORO_ALLOW_REAL_WRITE=true`. |
| Transfers | **off** | The internal-transfer tool needs `real` + both switches + `ETORO_ALLOW_TRANSFERS=true`. |
| Preview first | always | Orders, closes, cancels and transfers are two steps: `etoro_prepare_*` (preview) then `etoro_confirm_action`. |
| Human in the loop | on for `real` | Via MCP elicitation the client shows you the exact action. If the client cannot show it and `ETORO_REQUIRE_ELICITATION` is true (default on `real`), the action is refused. |
| Size caps | 100 USD / order, 500 USD / session | `ETORO_MAX_ORDER_USD` (exposure = amount × leverage) and `ETORO_MAX_SESSION_USD`. |
| Rate brake | 5 writes / minute | `ETORO_MAX_WRITES_PER_MINUTE`. |
| Route allowlist | fixed | The HTTP client can only call the routes in [`src/endpoints.ts`](src/endpoints.ts), only on the eToro host, and refuses write routes when writes are off. |
| Environment guard | always | Before any trading preview the server reads the key's scopes (`GET /api/v1/me`) and checks that the account answering for `ETORO_ENV` is that environment's account (`demoCid`/`realCid`). It refuses if the key lacks Write permission for the environment, if the data belongs to the other account, or if this cannot be verified. |
| Idempotency | always | Each prepared action has its own `x-request-id`, reused on retries, and a confirmation can be executed only once. |
| Tool annotations | always | Read and write tools are separate and carry MCP annotations (`readOnlyHint`, `destructiveHint`, `title`), so clients can apply sensible permission prompts. |
| Secrets | — | Never in tool inputs, results, errors or the audit log. `ETORO_BASE_URL` can only point to an `https://*.etoro.com` host. |

Also strongly recommended on the eToro side: create a **Read** key unless you need to trade, restrict it by **IP**, and set an **expiry**. Keys are separate for Demo and Real, so a demo key can never touch real money.

See [SECURITY.md](SECURITY.md) for the threat model and how to report a vulnerability.

## Install

> v0.2.0 is not published to npm yet. Build from source (below) or use the `.mcpb` bundle attached to a GitHub release.

### Claude Desktop (MCPB bundle)

1. Get `etoro-mcp-server-<version>.mcpb` from the GitHub release, or build it: `npm ci && npm run mcpb:pack`.
2. Open it with Claude Desktop (double-click, or drag it into **Settings → Extensions**).
3. Fill in the form: API key, user key, environment (`demo` to start). Keys are stored in your OS keychain.
4. Leave **Enable write tools** off until you have tried the read tools.

Claude Desktop shows an "unsigned extension" notice because the bundle is not signed with a code-signing certificate (see [Verifying a release](#verifying-a-release) for how to check where it came from). Some organisations restrict which extensions may be installed; if yours does, ask your administrator or build from source.

### Claude Code

```bash
git clone https://github.com/slemos/etoro-mcp-server.git && cd etoro-mcp-server
npm ci && npm run build
```

Export your keys in your shell profile or secret manager (do not paste them into chat or commit them), then register the server. A project-scoped `.mcp.json` can reference them without containing them:

```json
{
  "mcpServers": {
    "etoro": {
      "command": "node",
      "args": ["/absolute/path/to/etoro-mcp-server/dist/index.js"],
      "env": {
        "ETORO_API_KEY": "${ETORO_API_KEY}",
        "ETORO_USER_KEY": "${ETORO_USER_KEY}",
        "ETORO_ENV": "demo"
      }
    }
  }
}
```

Or from the CLI: `claude mcp add etoro -- node /absolute/path/to/etoro-mcp-server/dist/index.js` (the server reads `ETORO_API_KEY` / `ETORO_USER_KEY` from the environment Claude Code runs in). Check with `claude mcp list`.

### Any other MCP client

It is a standard **stdio** server: run `node dist/index.js` with the environment variables below. With `npx` once published: `npx -y etoro-mcp-server`.

## Getting eToro API keys

1. Use a verified eToro account.
2. In eToro go to **Settings → Trading → API Key Management → Create New Key**.
3. Choose the environment (**Demo** first), the permission (**Read**, or **Write** only if you want to trade) and, ideally, an IP allowlist and an expiry. SMS verification is required.
4. You get an API key (`x-api-key`) and a user key (`x-user-key`). Treat both like passwords.

Reference: [Authentication](https://api-portal.etoro.com/core/getting-started/authentication.md).

## Securing your setup

The server needs two secrets (the API key and the user key). **How you hand them over matters as much as what the server does with them.** Anyone who gets the pair can read your account, and with a Write key can trade on it.

**On the eToro side (always):** create a **Read** key unless you really need to trade; keep **Demo** and **Real** keys separate (eToro's documentation says a key serves one environment, but a key can carry scopes for both — `etoro_check_connection` shows them, and strict key scope — on by default for real, off for demo, configurable with `ETORO_STRICT_KEY_SCOPE` — makes the server refuse such keys for trading); restrict the key by **IP address**; set an **expiry**; revoke it at once if it may have leaked. `etoro_check_connection` shows the key's scopes and warns when a read-only server holds a Write key.

**On your side:** keep the secrets out of config files and shell history. Pick the first option that your client allows:

| Option | Where the secret lives | Use it with |
|---|---|---|
| **MCPB bundle** (`sensitive` fields) | OS keychain, managed by the host | Claude Desktop |
| **`ETORO_API_KEY_CMD` / `ETORO_USER_KEY_CMD`** | OS keychain or password manager; the config only holds the *command* | Any client, manual setup |
| **`ETORO_API_KEY_FILE` / `ETORO_USER_KEY_FILE`** | A file readable only by you (the server refuses it otherwise) | Any client, manual setup |
| Plain `ETORO_API_KEY` / `ETORO_USER_KEY` | Your shell or a config file in clear text | Quick local tests only |

Avoid putting the keys directly in `claude_desktop_config.json`, in `claude mcp add -e ETORO_API_KEY=...` (stored in clear text in `~/.claude.json` and in your shell history), or in a committed `.mcp.json`. Set exactly one source per key; the server refuses ambiguous setups.

`*_CMD` takes a command line that prints the secret on one line. It is split into words (quotes are honored) and run **without a shell**: no pipes, no expansion. It runs with your privileges, so treat it like the `command` of the server itself. `*_FILE` accepts `~/...` paths; on macOS and Linux the file must not be accessible to group or others (`chmod 600`).

### Recipes

**macOS Keychain** (prompts for the value without echoing it):

```bash
security add-generic-password -U -s etoro-mcp-server -a api-key -w
security add-generic-password -U -s etoro-mcp-server -a user-key -w
```

```json
"env": {
  "ETORO_API_KEY_CMD": "security find-generic-password -s etoro-mcp-server -a api-key -w",
  "ETORO_USER_KEY_CMD": "security find-generic-password -s etoro-mcp-server -a user-key -w",
  "ETORO_ENV": "demo"
}
```

When macOS asks whether `security` may read the item, prefer **Allow** over **Always Allow**: with "Always Allow", any program you run that calls `security` can read it without asking.

**Linux (libsecret):** `secret-tool store --label="eToro API key" service etoro-mcp-server key api-key` (same for `user-key`), then `ETORO_API_KEY_CMD="secret-tool lookup service etoro-mcp-server key api-key"`.

**Password managers:** any CLI that prints the secret works, for example `op read "op://Private/eToro/api-key"` (1Password, with biometric unlock), `pass show etoro/api-key`, or `bw get password etoro-api-key` (Bitwarden, needs an unlocked session).

**A protected file:**

```bash
mkdir -p ~/.config/etoro-mcp && chmod 700 ~/.config/etoro-mcp
( umask 077; printf "API key: "; read -rs v; echo; printf '%s' "$v" > ~/.config/etoro-mcp/api-key )
( umask 077; printf "User key: "; read -rs v; echo; printf '%s' "$v" > ~/.config/etoro-mcp/user-key )
# then: ETORO_API_KEY_FILE=~/.config/etoro-mcp/api-key  ETORO_USER_KEY_FILE=~/.config/etoro-mcp/user-key
```

**Windows:** use the MCPB bundle (keys go to the host's credential store), or a password manager CLI through `*_CMD`.

### What this does not protect against

The server runs as you. Another program running as your user can read what you can read, including the keychain items you allow and files with your permissions. Prompt injection is a separate risk, covered by the write-tool safeguards above. Use IP restrictions and short expiries so that a leaked key is worth little.

### Verifying what you install

Building from source is small and auditable (`npm ci` uses the committed lockfile). Release bundles are built by GitHub Actions from the tagged commit, after tests and security checks pass.

### Verifying a release

Each release attaches the bundle, a `SHA256SUMS` file and an SBOM (`*.sbom.cdx.json`, CycloneDX). The bundle is **not code-signed with a certificate**; its provenance is attested instead, which proves it was produced by this repository's release workflow:

```bash
shasum -a 256 -c SHA256SUMS --ignore-missing
gh attestation verify etoro-mcp-server-<version>.mcpb --repo slemos/etoro-mcp-server
```

If you would rather not trust a binary at all, build it yourself (`npm ci && npm run mcpb:pack`) and compare the result with the release.

## Configuration

All settings are environment variables (see [`.env.example`](.env.example)). The server does not read a `.env` file by itself: export the variables, or load a git-ignored `.env` with Node's flag, e.g. `node --env-file=.env dist/index.js` (Node 20.6+).

| Variable | Default | Description |
|---|---|---|
| `ETORO_API_KEY` | — (required) | Public API key (`x-api-key`). Alternatives: `ETORO_API_KEY_FILE` or `ETORO_API_KEY_CMD` (see [Securing your setup](#securing-your-setup)). Set exactly one. |
| `ETORO_USER_KEY` | — (required) | User key (`x-user-key`). Alternatives: `ETORO_USER_KEY_FILE` or `ETORO_USER_KEY_CMD`. Set exactly one. |
| `ETORO_ENV` | `demo` | `demo` or `real`. Must match the environment of the key pair. |
| `ETORO_ENABLE_WRITE` | `false` | Register the write tools. Needs a key with **Write** permission. |
| `ETORO_ALLOW_REAL_WRITE` | `false` | Second switch required for write tools when `ETORO_ENV=real`. |
| `ETORO_ALLOW_TRANSFERS` | `false` | Register the internal-transfer tool (real only, needs both switches above). |
| `ETORO_STRICT_KEY_SCOPE` | `true` on real, `false` on demo | Refuse trading previews when the key can also write in the *other* environment. On real it means the key must be real-only; on demo it would mean the key must not be able to trade real money. Set it explicitly to override either default. |
| `ETORO_REQUIRE_ELICITATION` | `true` on real, `false` on demo | Refuse writes unless the client can ask you to approve them. |
| `ETORO_MAX_ORDER_USD` | `100` | Max exposure (amount × leverage) or transfer amount per action. |
| `ETORO_MAX_SESSION_USD` | `500` | Max total exposure executed until the server restarts. |
| `ETORO_MAX_WRITES_PER_MINUTE` | `5` | Local brake on executed writes (eToro also rate-limits). |
| `ETORO_CONFIRM_TTL_SECONDS` | `300` | How long a preview stays confirmable. |
| `ETORO_MAX_RESPONSE_CHARS` | `120000` | Output size cap per tool result. Above it, arrays are shortened to their first N items (the result stays valid JSON and lists each array's real length). |
| `ETORO_DEBUG` | `false` | Log each HTTP call to eToro (method, path, query names, status, duration) to stderr. Never logs keys, headers or bodies. |
| `ETORO_AUDIT_LOG` | unset | Append JSON-lines audit events to this file (also logged to stderr). |
| `ETORO_BASE_URL` | `https://public-api.etoro.com` | Must be `https` on an `etoro.com` host. |

## Tools

12 **read** tools (always available) and 8 **write** tools (+1 gated transfer tool). Full parameters and the eToro routes they use are in [docs/TOOLS.md](docs/TOOLS.md).

| Tool | Kind | Purpose |
|---|---|---|
| `etoro_check_connection` | read | Verify the keys authenticate, show their scopes (demo/real, read/write), and prove which account (demo or real) the data comes from |
| `etoro_get_portfolio` | read | Aggregated portfolio snapshot |
| `etoro_get_portfolio_breakdown` | read | Open positions (ids, units), pending orders, credit |
| `etoro_get_pnl` | read | Unrealized PnL and portfolio details |
| `etoro_get_balances` | read | Balances across your eToro accounts |
| `etoro_get_trade_history` | read | Closed trades since a date |
| `etoro_get_order` | read | Status of one order |
| `etoro_get_instruments` | read | Resolve tickers / ids to instruments |
| `etoro_get_rates` | read | Bid/ask for instruments |
| `etoro_check_eligibility` | read | Settlement types, leverage, limits per instrument |
| `etoro_get_trading_costs` | read | What-if cost breakdown for an order |
| `etoro_list_watchlists` | read | Your watchlists |
| `etoro_prepare_open_position` | write (preview) | Validate + preview an order; returns `confirmationId` |
| `etoro_prepare_close_position` | write (preview) | Preview closing all/part of a position |
| `etoro_prepare_cancel_order` | write (preview) | Preview cancelling a pending order |
| `etoro_prepare_transfer` | write (preview, gated) | Preview an internal transfer (real + opt-in only) |
| `etoro_confirm_action` | write | Execute a previewed action (single use) |
| `etoro_create_watchlist` / `etoro_add_watchlist_items` / `etoro_remove_watchlist_items` / `etoro_delete_watchlist` | write | Manage watchlists (no money involved) |

### Example: a guarded order

```
You:    Buy 50 USD of CSPX.L as a CFD on my demo account.
Claude: [etoro_prepare_open_position] → preview: BUY CSPX.L (id 1234) | $50.00 | 1x | cfd | mkt | DEMO,
        eligibility, estimated costs, confirmationId 6b1c…  (nothing sent yet)
Claude: [etoro_confirm_action]        → your client asks you to approve that exact action → order sent
Claude: [etoro_get_order]             → status of the order
```

eToro answers an order with "accepted for processing", not "filled": follow the order with `etoro_get_order`.

## Trying an order on the demo environment

`npm run demo:order` runs the whole flow through the real server on eToro's **demo** (virtual money) environment: connection and environment check, instrument lookup, eligibility, preview with cost estimate, **your confirmation in the terminal**, execution, and following the order until it has a position.

```bash
npm run demo:order -- --symbol AAPL --amount 50                 # buy $50 on demo, keep the position
npm run demo:order -- --symbol AAPL --amount 50 --close         # ... and close it afterwards (asks again)
npm run demo:order -- --symbol CSPX.L --amount 20 --settlement cfd
npm run demo:order -- --close-position 123456789                # close an open demo position by id
npm run demo:order -- --symbol AAPL --amount 50 -y 2>&1 | tee demo-order.log   # no questions, output to a log
```

The script forces `ETORO_ENV=demo` whatever your environment says, stops unless the connection check proves the key reaches your demo account, and asks before sending anything. `-y` (or `--yes`) answers yes to the questions — the order and, with `--close`, the close — so you can pipe the output to a log (use `2>&1` to include the server's audit lines). Without a terminal and without `-y` it refuses to start instead of hanging. Use a key with demo **Write** permission. After a fill it prints the new position's `settlement` (`cfd` or `real`) with its `settlementTypeID` and `isSettled`. `--settlement real` on an account that is only offered CFDs is refused at the preview.

## Known limitations

- **Very large responses are shortened.** A big portfolio (many positions or copy-trading mirrors) can exceed the output cap; the server then keeps the first N items of each array and says how many there really were. Prefer narrower tools or raise `ETORO_MAX_RESPONSE_CHARS`.
- **Responses are passed through as eToro sends them.** The shapes come from eToro's reference pages and from a live demo account (see "Where it stands" above); trade history, watchlists, balances and rates have not been confirmed live yet. If a field is missing or renamed, please open an issue with the (redacted) response shape (`--verbose --mask` in the smoke script produces one that is safe to paste).
- **Some demo *read* paths are inferred** from eToro's documented demo/real naming pattern (marked `inferred` in [`src/endpoints.ts`](src/endpoints.ts)); the demo *write* paths and the demo cost endpoint are documented.
- **Instrument lookup is by exact ticker or id** (no free-text search). ETF tickers on eToro carry an exchange suffix such as `CSPX.L`.
- **Elicitation support varies by client.** Claude Code supports it (2.1.76+); support in other hosts may lag. On `real`, writes are refused when the client cannot ask you, unless you set `ETORO_REQUIRE_ELICITATION=false` and accept confirming through the conversation alone.
- Prompt injection is a real risk for any tool-using agent: do not let Claude read untrusted content (web pages, emails, documents) in the same session in which it can place real orders, and do not auto-approve `etoro_confirm_action`.
- No streaming/WebSocket data, no copy-trading actions, no OAuth (API key pair only).
- Eligibility to use the API and the instruments available depend on your account and jurisdiction. In particular, depending on jurisdiction some accounts can only open **CFDs**, not real shares: `settlementType: "real"` is then rejected by eToro (seen on a demo account that was offered only CFDs). `etoro_prepare_open_position` reads the eligibility answer first and refuses a settlement type the account is not offered, before anything can be confirmed.
- **Two instruments for some stocks.** eToro lists a regular-trading-hours instrument (symbol ending in `.RTH`) next to the 24/5 one for some stocks. The preview shows the exact symbol and instrument id, and warns on `.RTH`; pass `instrumentId` when in doubt.

## Development

```bash
npm ci
npm run typecheck
npm test                 # unit + end-to-end tests with a mocked eToro API (no network, no keys)
npm run build            # tsc → dist/
node scripts/smoke.mjs   # launch the built server over stdio and list tools (dummy keys)
npm run security:check   # runs the built server with the network cut off: permission switches, hostile inputs, secret redaction
npm run mcpb:pack        # esbuild bundle → server/index.js, then etoro-mcp-server.mcpb
```

With your own keys in a git-ignored `.env`, `npm run smoke:live` (or `node scripts/smoke.mjs --live` with the variables exported) runs `etoro_check_connection` and a few read tools and prints only the *shape* of the responses (never values), which is a safe first check. In a client, ask Claude to run `etoro_check_connection` to confirm the keys work and which mode the server is in.

Debugging options for the script (all run the real server over stdio):

| Option | Effect |
|---|---|
| `--report` | Only verify the connection and the environment (`npm run verify` with a `.env`): prints a one-line verdict and reads no account data. |
| `--verbose` | Print each tool's full output. It contains your real account data: keep it private. |
| `--verbose --mask` | Same, but every value is replaced by a placeholder (`<number>`, `<string, 12 chars>`), keeping field names, types and nesting. Safe to paste into an issue. |
| `--tool <name> --args '<json>'` | Call a single tool, e.g. `--tool etoro_get_trade_history --args '{"minDate":"2026-01-01"}'`. |
| `--debug` | Sets `ETORO_DEBUG=true` so the server logs each HTTP call. |
| `--entry <file>` | Launch another entry point, e.g. `server/index.js` (the bundle used by the `.mcpb`). |

```
src/
  config.ts      env parsing, switches, caps
  endpoints.ts   the complete route allowlist (read vs write)
  client.ts      HTTP client: auth headers, idempotency ids, 429 retry, redaction, policy checks
  safety.ts      pending confirmations, limits, human confirmation (elicitation)
  audit.ts       JSON-lines audit trail
  tools/         read.ts, write.ts, common.ts
test/            vitest, including MCP client ↔ server tests over an in-memory transport
```

## Contributing

Issues and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Security issues: see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
