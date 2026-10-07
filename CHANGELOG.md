# Changelog

## 0.6.0 — unreleased

What-if questions on past prices, without placing or preparing anything.

### Added
- `etoro_simulate_position`: a long or short of an amount (with leverage, stop loss and take profit as prices) followed over a window of eToro's historical candles. It reports the entry and exit prices and times, why it ended (stop loss, take profit, margin call or end of data), the result in USD and as a percentage of the amount, and the worst and best moments on the way. A candle that reaches both stop and target counts as the stop first; a gap past a stop closes at the open; with leverage the loss is limited to the amount.
- `etoro_backtest`: `buy_and_hold` (one purchase at the start) or `dca` (the same amount every N days), unleveraged, with what was invested, units, average cost, final value, result, worst fall and, for dca, the same total invested in one go at the start for comparison.
- Both follow eToro's candle cursor to fetch the whole window (up to 20,000 candles; a bigger window is refused with advice to use a coarser interval), use bid prices and say plainly what they leave out: spread, fees, overnight costs, slippage, dividends, currency conversion and the order of high and low inside a candle. Every answer is marked `hypothetical` and carries a notice that it is not a prediction or advice. They are read-only tools.
- Tests: 220.

### Changed
- Instrument resolution (symbol or id to one instrument) moved to a shared module used by the prepare tools and the simulations.

## 0.5.1 — 2026-10-07

Closing positions with more information, and cancelling a close that has not executed yet.

### Added
- `etoro_prepare_cancel_close_order`: cancels a pending close order (a close waiting for the market to open, for example). The position stays open. It is a separate eToro endpoint from cancelling a normal order (`DELETE /api/v1/trading/execution/market-close-orders/{orderId}`, demo: `/execution/demo/market-close-orders/{orderId}`, taken from the reference pages), so `etoro_prepare_cancel_order` now points to it. eToro's answer only confirms the request arrived; the preview says to check the order afterwards.
- `npm run privacy:check` (also in CI): fails on e-mail addresses and real-looking long ids in tracked files, and on any phrase in a local, git-ignored `.privacy-denylist`. Numbers that are invented on purpose are listed in `scripts/privacy-allowlist.txt`. Tests: 205.

### Changed
- `etoro_prepare_close_position` shows the instrument, direction, settlement, current bid/ask and a rough result of the close (price move × units; a long closes at the bid, a short at the ask; before fees, overnight costs and currency conversion) and, for a partial close, what stays open. `instrumentId` is optional now: it is read from the open position, and the preview refuses a mismatching one or more units than are open. It warns about positions that belong to a copy and about `.RTH` instruments.
- The example ticker in the documentation, tests and tool descriptions is now neutral (`AAPL` or the made-up `EXMPL.L`).

## 0.5.0 — 2026-10-07

A record of what you did, and daily limits that survive restarts.

### Added
- **Persistent action history** in a local SQLite file (`ETORO_HISTORY_DB`; default: your data folder, created private, no native dependency: it uses Node's built-in `node:sqlite`). Every prepared action is stored with its summary, details, warnings, exposure, status (pending, executing, executed, rejected, expired, failed), eToro's answer, the ids it concerns (order, position, instrument) and its timeline of events. An action left waiting or executing by a server that stopped is settled the next time the history is read.
- `etoro_get_action_history`: Claude can search the history by text, ids, dates, environment, action and status, and sees today's use of the daily limits.
- `etoro_open_history`: opens a read-only page in the browser (the approval page's local server: `127.0.0.1`, secret address valid for an hour, no JavaScript) with a search box, filters, paging, the detail of each action and a CSV download. Times use `ETORO_TIMEZONE`.
- **Daily limits**, configurable: `ETORO_MAX_DAILY_USD` (default 1000) and `ETORO_MAX_DAILY_WRITES` (default 25), per environment, with the day starting at midnight in `ETORO_TIMEZONE` (default UTC). They are checked and reserved in one database transaction, so they hold across restarts and across server processes (Claude Desktop and Claude Code each run their own). A request that eToro clearly refuses (a 4xx) gives its share back; a timeout, network error or 5xx does not, because the order may exist. If the limits cannot be checked, nothing is sent. The three settings are also in the `.mcpb` form.
- `etoro_check_connection` reports the daily limits, today's use, the time zone, whether the history is persistent and the runtime (`node`, `sqlite`).
- `etoro_get_action_status` falls back to the history for actions from earlier sessions.
- Tests: 189, and 13 more dynamic security checks (49 in total).

### Changed
- **Node 22.13 or newer is required** (was 20): the history uses `node:sqlite`. Claude Desktop's bundled Node (24.x) is fine. CI now tests Node 22 and 24, so the required checks of `main` are `test (22)` and `test (24)` instead of `test (20)` and `test (22)`.
- A server that can write refuses to start when the history file cannot be opened (the daily limits live in it); set `ETORO_HISTORY_DB=off` to run with an in-memory history. A read-only server falls back to memory with a log line.

### Fixed
- `etoro_get_trade_history` on the demo environment called a route that does not exist (`/api/v1/trading/info/demo/trade/history`, answered `RouteNotFound`). The documented path is `/api/v1/trading/info/trade/demo/history`. It had been marked as inferred and was wrongly treated as confirmed in 0.4.0; the other demo routes (portfolio breakdown, PnL, order lookup, eligibility) were checked against their reference pages and are right. A test now pins every demo route.

### Security and release
- `main` is protected on GitHub: no direct pushes, force pushes or deletion, for anyone including the owner (administrators are included in the rule); changes go through pull requests that must pass `test (20)`, `test (22)`, `bundle`, `CodeQL (SAST)`, `Dependency audit` and `Secret scan`. Merged branches are deleted.
- OpenSSF Scorecard workflow (`scorecard.yml`) and README badge.

## 0.4.0 — 2026-10-06

Market data for natural questions: find an instrument by name and read how its price moved.

### Added
- `etoro_search_instruments`: free-text search by name or ticker (`GET /api/v2/market-data/instruments/search`), compact rows without images. `etoro_get_instruments` stays the exact lookup and now points to it.
- `etoro_get_candles`: historical candles for one instrument (`GET /api/v1/data/instruments/{id}/candles`): interval from 1m to 1w, optional `from`/`to` window (ISO 8601 with a timezone), up to 2000 per call with `cursor` paging, bid/ask/both. The answer includes a `summary` (first open, last close, high, low, percentage change, volume) computed from the candles returned, and `summaryOnly` returns just that.
- `npm run pack:dev`: a throwaway `.mcpb` versioned `<version>-dev.<n>` for trying changes in Claude Desktop, which only offers updates to higher versions, without spending release numbers.
- Tests: 160.

### Documentation
- "Where it stands" now lists what was tried live from Claude Desktop on a demo account: every read tool (including the new search and candles) and opening an order and changing a stop loss through the approval page.
- The demo read routes that were marked `inferred` (portfolio breakdown, PnL, trade history, order lookup, eligibility) were exercised against a live demo account, so the markers are gone.

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
