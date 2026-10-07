# Changelog

## 0.2.0 — 2026-10-06

- Settlement awareness: `etoro_prepare_open_position` reads the eligibility answer (for the instrument and the long/short direction) and rejects a `settlementType` the account is not offered, before anything can be confirmed. eToro itself only rejects it after accepting the request (error 2011: "Requested settlement type: 1 is disallowed"), as seen when asking for `real` on an account offered only CFDs. The preview returns `settlement: { requested, offered }` and, when only one type is offered and none was requested, says which one the order will use.
- Compact portfolio views add `settlement` (`cfd` | `real`), derived from `settlementTypeID` (`0` = CFD, `1` = real; other ids are left unlabelled). `npm run demo:order` prints it for the new or closed position.
- Fixed: a watchlist id of `.` or `..` survived URL encoding and was collapsed by URL parsing, so the request went to another API path (for example `DELETE /api/v1/`) outside the route allowlist. The client now refuses any route whose path changes when normalised. Found by the new `security:check`.
- Security automation: CodeQL, `npm audit` / `npm audit signatures`, Gitleaks and Dependabot; `npm run security:check` runs the built server as a real process with the network cut off (permission switches, hostile inputs, path rewriting, secret redaction); CI runs it on every push.
- Release workflow: checks the tag against the version fields, the CHANGELOG date and `main`; runs CI and the security checks first; builds the bundle, writes an SBOM and `SHA256SUMS`, attests the build provenance, then publishes. The bundle remains unsigned (no certificate); the README explains how to verify it.
- GitHub Actions pinned to commit SHAs.
- Previews warn about `.RTH` (regular-trading-hours) instruments, which eToro lists next to the plain 24/5 instrument for some stocks.
- 12 read tools: connection check (`etoro_check_connection`), portfolio snapshot and breakdown, PnL, balances, closed-trade history, order lookup, instrument lookup, bid/ask rates, eligibility check, what-if trading costs, watchlists.
- Safer key handling: keys can come from a command (`*_CMD`, no shell: OS keychain, password managers) or a protected file (`*_FILE`, refused if group/other can read it); one source per key; least-privilege advice in `etoro_check_connection`; README section "Securing your setup".
- `ETORO_STRICT_KEY_SCOPE` (default on for real, off for demo): refuse trading with keys that can also write in the other environment; the connection check reports which account each environment's route serves.
- Environment verification: `etoro_check_connection` reads the key's scopes and compares account ids to prove demo vs real; a fail-closed guard repeats the check before any trading preview.
- Compact `summary`/`mirror` views with paging for the portfolio breakdown and PnL tools, with instrument symbols added; output over the size cap now shortens arrays and stays valid JSON.
- Order previews warn when no `settlementType` is given: a demo test showed eToro opening a plain AAPL buy as a CFD.
- `npm run demo:order -y`/`--yes` auto-confirms (loggable output); it refuses to start without a terminal unless `-y` is given.
- `npm run demo:order --close-position <id>`; order follow-up shows execution details and the new position's settlement fields; a 404 right after placing is reported as "not registered yet".
- `npm run demo:order`: guided end-to-end order on the demo environment (preview, confirmation, execution, order follow-up, optional close).
- Debugging: `ETORO_DEBUG` HTTP call log, and `scripts/smoke.mjs` options `--verbose`, `--mask`, `--tool`, `--args`, `--debug`.
- Tests: unit tests plus MCP client↔server tests against a mocked eToro API (126 tests).

## 0.1.0 — 2026-10-06

First public commit; never tagged or released.

- 11 read tools: portfolio snapshot and breakdown, PnL, balances, closed-trade history, order lookup, instrument lookup, bid/ask rates, eligibility check, what-if trading costs, watchlists.
- Opt-in write tools: open/close/cancel through preview → confirm, watchlist management, and a separately gated internal-transfer tool.
- Safety: read-only and demo by default, second opt-in for real money, route allowlist, per-order and per-session caps, writes-per-minute brake, single-use expiring confirmations, MCP elicitation for human approval, JSON-lines audit log, secret redaction.
- Packaging: stdio server, npm `bin`, and an MCPB bundle (`manifest.json`, keys in the OS keychain).
- Tests: unit tests plus MCP client↔server tests against a mocked eToro API.
