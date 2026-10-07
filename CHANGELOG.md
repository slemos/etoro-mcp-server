# Changelog

## 0.4.0 — unreleased

Market data for natural questions: find an instrument by name and read how its price moved.

### Added
- `etoro_search_instruments`: free-text search by name or ticker (`GET /api/v2/market-data/instruments/search`), compact rows without images. `etoro_get_instruments` stays the exact lookup and now points to it.
- `etoro_get_candles`: historical candles for one instrument (`GET /api/v1/data/instruments/{id}/candles`): interval from 1m to 1w, optional `from`/`to` window (ISO 8601 with a timezone), up to 2000 per call with `cursor` paging, bid/ask/both. The answer includes a `summary` (first open, last close, high, low, percentage change, volume) computed from the candles returned, and `summaryOnly` returns just that.
- `npm run pack:dev`: a throwaway `.mcpb` versioned `<version>-dev.<n>` for trying changes in Claude Desktop, which only offers updates to higher versions, without spending release numbers.
- Tests: 160.

## 0.3.0 — 2026-10-06

**Claude proposes, you execute.** Claude's own rules keep it from executing financial transactions (it refused to call `etoro_confirm_action` even on a demo account, and said so), so the server no longer asks it to: every change is only *prepared* by Claude and executed by you, on a local approval page. This is a breaking change.

### Changed (breaking)
- **No tool executes an action any more.** `etoro_confirm_action` is gone. Every write tool is now an `etoro_prepare_*` tool that registers a proposal and opens an approval page in your browser with the exact action (environment, instrument, size, costs, warnings). Only pressing **Execute** there sends the request to eToro; **Reject** or waiting past `ETORO_CONFIRM_TTL_SECONDS` sends nothing. The prepare tools return an `actionId` (formerly `confirmationId`) and no longer expose the page's address unless `ETORO_SHOW_APPROVAL_URL=true`.
- Watchlist changes follow the same rule and were renamed: `etoro_create_watchlist`, `etoro_add_watchlist_items`, `etoro_remove_watchlist_items` and `etoro_delete_watchlist` are now `etoro_prepare_create_watchlist`, `etoro_prepare_add_watchlist_items`, `etoro_prepare_remove_watchlist_items` and `etoro_prepare_delete_watchlist`.
- MCP elicitation is no longer used, and `ETORO_REQUIRE_ELICITATION` is gone (an old value is ignored). The approval page works the same in every client, including Claude Desktop, which has no elicitation.
- `ETORO_CONFIRM_TTL_SECONDS` defaults to 600 (was 300).
- `etoro_check_connection` no longer reports `requireHumanConfirmation` or `client.supportsConfirmationPrompts`; `mode.executionByUserOnly` is always true.

### Added
- `etoro_prepare_modify_position`: change the stop loss and/or take profit of an open position (new rates, trailing or fixed stop, or removing them), through the same prepare → you-execute flow. The preview shows the direction, current price and current stop/take profit, and warns when a new rate is on the wrong side of the price (it would trigger at once) or may move funds into the position's margin. Route: `PATCH /api/v2/trading/positions/{id}` (demo: `/api/v2/trading/demo/positions/{id}`).
- `etoro_get_action_status` (read-only): where a prepared action stands (pending, executing, executed with eToro's answer, rejected, expired, failed).
- The local approval page: served on 127.0.0.1 only (random port, started on first use), with a single-use 256-bit secret in its address, `Host` / `Origin` / anti-CSRF checks, plain HTML with every external string escaped and no JavaScript, and a strict CSP. (Checked in a real browser: the page uses `Referrer-Policy: same-origin`, because `no-referrer` makes browsers send `Origin: null` on its own forms.)
- `ETORO_OPEN_BROWSER` (default true) and `ETORO_SHOW_APPROVAL_URL` (default false; meant for scripts and machines without a browser).
- A structural write gate: the HTTP client refuses every write route unless it receives the permission the proposal store issues when you press Execute; a test covers every write route and checks that only `src/approval/` mints it.
- `npm run demo:order` still asks in the terminal; your answer (or `-y`) makes the script press Execute on the approval page for you.

### Security and release
- `security:check` now also verifies that no tool executes an action, that nothing is sent to eToro before Execute, and the approval page's behaviour (escaping, CSP, wrong token, `Host`, `Origin` and anti-CSRF value refused, a GET never executes, the address is not given to Claude by default). Tests: 152.

## 0.2.1 — 2026-10-06

Polish for the Claude Desktop install, from trying the 0.2.0 bundle.

### Changed
- The bundle's settings form has a **Use the REAL environment** switch (off by default) instead of a free-text "Environment" field: extension forms cannot show a drop-down, and a typo in the text field stopped the server from starting. The server reads it from the new `ETORO_USE_REAL` variable; `ETORO_ENV` keeps working, and if both are set they must agree or the server refuses to start. Anyone who already configured 0.2.0 sets the form again.
- Shorter descriptions for the key fields, and an icon.
- README and release notes describe the real install warning in Claude Desktop (Anthropic has not verified the developer) instead of "unsigned extension".

### Security and release
- `security:check` also covers `ETORO_USE_REAL` (real still needs its second write switch; contradictory settings are refused). Tests: 127.

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
