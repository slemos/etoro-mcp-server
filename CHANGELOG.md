# Changelog

## 0.2.0 — 2026-10-06

This release makes the server aware of what your account can actually do (real shares vs CFDs), verifies which eToro environment it is talking to before any trade, shortens the huge portfolio payloads, and adds automated security checks and a verifiable release pipeline. It also fixes a path-handling bug found by the new checks.

### Added
- **Settlement awareness.** `etoro_prepare_open_position` reads the eligibility answer (for the instrument and the long/short direction) and rejects a `settlementType` the account is not offered, before anything can be confirmed. eToro itself only rejects it after accepting the request (error 2011: "Requested settlement type: 1 is disallowed"), as seen when asking for `real` on an account offered only CFDs. The preview returns `settlement: { requested, offered }` and, when only one type is offered and none was requested, says which one the order will use.
- Compact portfolio views add `settlement` (`cfd` | `real`), derived from `settlementTypeID` (`0` = CFD, `1` = real; other ids are left unlabelled).
- Previews warn about `.RTH` (regular-trading-hours) instruments, which eToro lists next to the plain 24/5 instrument for some stocks, and when no `settlementType` is given.
- **Environment verification.** `etoro_check_connection` (the 12th read tool) reads the key's scopes and compares account ids to prove demo vs real; a fail-closed guard repeats the check before any trading preview. `ETORO_STRICT_KEY_SCOPE` (default on for real, off for demo) refuses trading with keys that can also write in the other environment.
- **Safer key handling.** Keys can come from a command (`*_CMD`, no shell: OS keychain, password managers) or a protected file (`*_FILE`, refused if group/other can read it); one source per key; README section "Securing your setup".
- **Compact portfolio views.** `summary` / `mirror` views with paging for the portfolio breakdown and PnL tools, with instrument symbols added; output over the size cap now shortens arrays and stays valid JSON.
- `npm run demo:order`: a guided end-to-end order on the demo environment (preview, confirmation, execution, order follow-up, optional close), with `--close-position <id>` and `-y`/`--yes` for loggable runs.
- Debugging: `ETORO_DEBUG` HTTP call log, and `scripts/smoke.mjs` options `--verbose`, `--mask`, `--tool`, `--args`, `--debug`.

### Fixed
- A watchlist id of `.` or `..` survived URL encoding and was collapsed by URL parsing, so the request went to another API path (for example `DELETE /api/v1/`) outside the route allowlist. The client now refuses any route whose path changes when normalised. Found by the new `security:check`.

### Security and release
- CodeQL, `npm audit` / `npm audit signatures`, Gitleaks and Dependabot; GitHub Actions pinned to commit SHAs.
- `npm run security:check` runs the built server as a real process with the network cut off (permission switches, hostile inputs, path rewriting, secret redaction); CI runs it on every push.
- Release workflow: checks the tag against the version fields, the CHANGELOG date and `main`; runs CI and the security checks first; builds the bundle, writes an SBOM and `SHA256SUMS`, attests the build provenance, then publishes with notes taken from this changelog. The bundle remains unsigned (no certificate); the README explains how to verify it.
- Tests: unit tests plus MCP client↔server tests against a mocked eToro API (126 tests).

## 0.1.0 — 2026-10-06

First public commit; never tagged or released.

- 11 read tools: portfolio snapshot and breakdown, PnL, balances, closed-trade history, order lookup, instrument lookup, bid/ask rates, eligibility check, what-if trading costs, watchlists.
- Opt-in write tools: open/close/cancel through preview → confirm, watchlist management, and a separately gated internal-transfer tool.
- Safety: read-only and demo by default, second opt-in for real money, route allowlist, per-order and per-session caps, writes-per-minute brake, single-use expiring confirmations, MCP elicitation for human approval, JSON-lines audit log, secret redaction.
- Packaging: stdio server, npm `bin`, and an MCPB bundle (`manifest.json`, keys in the OS keychain).
- Tests: unit tests plus MCP client↔server tests against a mocked eToro API.
