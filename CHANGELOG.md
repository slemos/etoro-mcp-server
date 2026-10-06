# Changelog

## 0.1.0 — unreleased

Initial version.

- 11 read tools: portfolio snapshot and breakdown, PnL, balances, closed-trade history, order lookup, instrument lookup, bid/ask rates, eligibility check, what-if trading costs, watchlists.
- Opt-in write tools: open/close/cancel through preview → confirm, watchlist management, and a separately gated internal-transfer tool.
- Safety: read-only and demo by default, second opt-in for real money, route allowlist, per-order and per-session caps, writes-per-minute brake, single-use expiring confirmations, MCP elicitation for human approval, JSON-lines audit log, secret redaction.
- Packaging: stdio server, npm `bin`, and an MCPB bundle (`manifest.json`, keys in the OS keychain).
- Tests: unit tests plus MCP client↔server tests against a mocked eToro API.
