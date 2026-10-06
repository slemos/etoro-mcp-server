# eToro MCP Server (unofficial)

An [MCP](https://modelcontextprotocol.io) server that lets Claude (and other MCP clients) work with **your own eToro account** through the [eToro Public API](https://api-portal.etoro.com): read your portfolio, balances and market data, and — only if you opt in — preview, place, close and cancel orders.

> **Disclaimer.** This project is not affiliated with, endorsed by or supported by eToro. "eToro" is a trademark of its owner. Nothing here is financial advice. Trading — especially with leverage or CFDs — can lose money, and software that lets an AI act on a brokerage account can lose it faster. Read the [safety model](#safety-model), start on the **demo** environment, and check eToro's API terms before automating anything.

## Highlights

- **Read-only and demo by default.** Out of the box the server exposes 11 read tools against eToro's demo environment. Write tools are not even registered until you enable them.
- **Preview → confirm for every order.** `etoro_prepare_*` tools validate the request, check eligibility, estimate costs and enforce size caps, then return a one-time `confirmationId`. Nothing is sent to eToro until `etoro_confirm_action` runs it, and — on clients that support MCP elicitation — you are asked to approve the exact action.
- **Real money needs a second opt-in**, and defaults to requiring that human prompt.
- **Hard limits in code**: per-order exposure cap, per-session cap, writes-per-minute limit, strict route allowlist, single-use and expiring confirmations, JSON audit log.
- **Keys stay local.** Credentials are read from environment variables (or your OS keychain via the `.mcpb` bundle), are never accepted as tool arguments, and are redacted from errors and logs.
- Separate read and write tools with MCP annotations (`readOnlyHint`, `destructiveHint`, `title`) so clients can apply sensible permission prompts.

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
| Idempotency | always | Each prepared action has its own `x-request-id`, reused on retries, and a confirmation can be executed only once. |
| Secrets | — | Never in tool inputs, results, errors or the audit log. `ETORO_BASE_URL` can only point to an `https://*.etoro.com` host. |

Also strongly recommended on the eToro side: create a **Read** key unless you need to trade, restrict it by **IP**, and set an **expiry**. Keys are separate for Demo and Real, so a demo key can never touch real money.

See [SECURITY.md](SECURITY.md) for the threat model and how to report a vulnerability.

## Install

> v0.1.0 is not published to npm yet. Build from source (below) or use the `.mcpb` bundle attached to a GitHub release.

### Claude Desktop (MCPB bundle)

1. Get `etoro-mcp-server-<version>.mcpb` from the GitHub release, or build it: `npm ci && npm run mcpb:pack`.
2. Open it with Claude Desktop (double-click, or drag it into **Settings → Extensions**).
3. Fill in the form: API key, user key, environment (`demo` to start). Keys are stored in your OS keychain.
4. Leave **Enable write tools** off until you have tried the read tools.

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

## Configuration

All settings are environment variables (see [`.env.example`](.env.example)).

| Variable | Default | Description |
|---|---|---|
| `ETORO_API_KEY` | — (required) | Public API key (`x-api-key`). |
| `ETORO_USER_KEY` | — (required) | User key (`x-user-key`). |
| `ETORO_ENV` | `demo` | `demo` or `real`. Must match the environment of the key pair. |
| `ETORO_ENABLE_WRITE` | `false` | Register the write tools. Needs a key with **Write** permission. |
| `ETORO_ALLOW_REAL_WRITE` | `false` | Second switch required for write tools when `ETORO_ENV=real`. |
| `ETORO_ALLOW_TRANSFERS` | `false` | Register the internal-transfer tool (real only, needs both switches above). |
| `ETORO_REQUIRE_ELICITATION` | `true` on real, `false` on demo | Refuse writes unless the client can ask you to approve them. |
| `ETORO_MAX_ORDER_USD` | `100` | Max exposure (amount × leverage) or transfer amount per action. |
| `ETORO_MAX_SESSION_USD` | `500` | Max total exposure executed until the server restarts. |
| `ETORO_MAX_WRITES_PER_MINUTE` | `5` | Local brake on executed writes (eToro also rate-limits). |
| `ETORO_CONFIRM_TTL_SECONDS` | `300` | How long a preview stays confirmable. |
| `ETORO_AUDIT_LOG` | unset | Append JSON-lines audit events to this file (also logged to stderr). |
| `ETORO_BASE_URL` | `https://public-api.etoro.com` | Must be `https` on an `etoro.com` host. |

## Tools

11 **read** tools (always available) and 8 **write** tools (+1 gated transfer tool). Full parameters and the eToro routes they use are in [docs/TOOLS.md](docs/TOOLS.md).

| Tool | Kind | Purpose |
|---|---|---|
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

## Known limitations

- **Responses are passed through as eToro sends them.** The shapes were taken from eToro's reference pages but the server could not be exercised against a live account in its first version. If a field is missing or renamed, please open an issue with the (redacted) response shape.
- **Some demo *read* paths are inferred** from eToro's documented demo/real naming pattern (marked `inferred` in [`src/endpoints.ts`](src/endpoints.ts)); the demo *write* paths and the demo cost endpoint are documented.
- **Instrument lookup is by exact ticker or id** (no free-text search). ETF tickers on eToro carry an exchange suffix such as `CSPX.L`.
- **Elicitation support varies by client.** Claude Code supports it (2.1.76+); support in other hosts may lag. On `real`, writes are refused when the client cannot ask you, unless you set `ETORO_REQUIRE_ELICITATION=false` and accept confirming through the conversation alone.
- Prompt injection is a real risk for any tool-using agent: do not let Claude read untrusted content (web pages, emails, documents) in the same session in which it can place real orders, and do not auto-approve `etoro_confirm_action`.
- No streaming/WebSocket data, no copy-trading actions, no OAuth (API key pair only).
- Eligibility to use the API and the instruments available depend on your account and jurisdiction.

## Development

```bash
npm ci
npm run typecheck
npm test                 # unit + end-to-end tests with a mocked eToro API (no network, no keys)
npm run build            # tsc → dist/
node scripts/smoke.mjs   # launch the built server over stdio and list tools (dummy keys)
npm run mcpb:pack        # esbuild bundle → server/index.js, then etoro-mcp-server.mcpb
```

With your own keys, `node scripts/smoke.mjs --live` calls two read tools and prints only the *shape* of the responses (never values), which is a safe first check.

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
