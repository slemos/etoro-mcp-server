# Tool reference

All tools are prefixed `etoro_`. Read tools are annotated `readOnlyHint: true`; the prepare tools `readOnlyHint: false` (they send nothing to eToro, but they register an action and open a page). Names are well under 64 characters. Responses are eToro's JSON as returned (truncated with a note above ~120k characters).

`env` below is the configured `ETORO_ENV` (`demo` or `real`). Reference pages live under <https://api-portal.etoro.com>.

## Read tools

| Tool | Method and route | Parameters |
|---|---|---|
| `etoro_check_connection` | `GET /api/v1/me` (identity and key scopes) and the environment's portfolio snapshot route (`pnlLevel=None`) | – |
| `etoro_get_portfolio` | `GET /api/v1/trading/info/aggregate-portfolio` (demo: `/info/demo/aggregate-portfolio`) | `pnlLevel` (None/Pnl/DailyPnl), `instrumentIds[]` |
| `etoro_get_portfolio_breakdown` | `GET /api/v1/trading/info/portfolio` (demo: `/info/demo/portfolio`) | `view` (`summary` default, `mirror`, `raw`), `mirrorId`, `limit` (≤200, default 50), `offset` |
| `etoro_get_pnl` | `GET /api/v1/trading/info/real/pnl` (demo: `/info/demo/pnl`) | same as the breakdown: `view`, `mirrorId`, `limit`, `offset` |
| `etoro_get_balances` | `GET /api/v1/balances` | `displayCurrency`, `includeZeroBalances`, `includeSubAccounts`, `accountTypes` |
| `etoro_get_trade_history` | `GET /api/v1/trading/info/trade/history` (demo: `/info/trade/demo/history`) | `minDate` (YYYY-MM-DD), `page`, `pageSize` |
| `etoro_get_order` | `GET /api/v2/trading/info/orders:lookup` (demo: `/info/demo/...`) | exactly one of `orderId`, `referenceId` |
| `etoro_get_instruments` | `GET /api/v2/market-data/instruments` | `symbols[]` or `instrumentIds[]`, `type`, `pageSize` |
| `etoro_get_rates` | `GET /api/v1/market-data/instruments/rates` | `instrumentIds[]` (1–100) |
| `etoro_check_eligibility` | `POST /api/v2/trading/info/eligibility` (computes only; demo: `/info/demo/eligibility`) | `instrumentIds[]` and/or `symbols[]` |
| `etoro_get_trading_costs` | `POST /api/v2/trading/info/costs` (what-if; demo: `/info/demo/costs`) | `action`, `transaction`, `symbol`/`instrumentId`, `settlementType`, `orderType`, `leverage`, `amountUsd`, `positionIds[]` |
| `etoro_search_instruments` | `GET /api/v2/market-data/instruments/search` | `query` (1-100 chars), `limit` (1-50, default 10); returns instrumentId, symbol, displayName, type, exchangeId |
| `etoro_get_candles` | `GET /api/v1/data/instruments/{instrumentId}/candles` | `instrumentId`, `interval` (1m 5m 10m 15m 30m 1h 4h 1d 1w), `from`/`to` (ISO 8601 with timezone), `limit` (1-2000, default 100), `side` (bid/ask/both), `cursor`, `summaryOnly`. The answer adds a `summary` computed from the candles returned |
| `etoro_list_watchlists` | `GET /api/v1/watchlists` | `itemsPerPage`, `includeBuiltin` |
| `etoro_get_action_status` | – (local: this session's prepared actions, then the history) | `actionId` |
| `etoro_get_action_history` | – (local: the SQLite history) | `query?`, `environment?`, `action?`, `status?`, `from?`, `to?` (YYYY-MM-DD), `limit?` (1–100, default 20), `offset?` |
| `etoro_open_history` | – (local: opens the history page in the browser) | – |

## Write tools (registered only with `ETORO_ENABLE_WRITE=true`; real needs `ETORO_ALLOW_REAL_WRITE=true`)

### Prepare-only actions: Claude proposes, the user executes

Every write tool only registers a proposal and opens an approval page (`http://127.0.0.1:<port>/t/<secret>`) in the user's browser. Pressing **Execute** there sends the request to eToro; **Reject**, or waiting past `ETORO_CONFIRM_TTL_SECONDS` (default 10 minutes), sends nothing. Each prepare tool returns an `actionId` and `approval: { status: "awaiting_user", pageOpened }`; the page's address is included only with `ETORO_SHOW_APPROVAL_URL=true`. Follow an action with `etoro_get_action_status` (read-only). Local limits (per-minute writes, session exposure, daily exposure and writes) apply when the user presses Execute; a blocked action stays pending and can be executed again.

| Tool | What it does | Route sent when the user executes |
|---|---|---|
| `etoro_prepare_open_position` | Resolves the instrument, checks eligibility and costs, enforces `ETORO_MAX_ORDER_USD`, returns an `actionId` | `POST /api/v2/trading/execution/orders` (demo: `/execution/demo/orders`) |
| `etoro_prepare_close_position` | Previews closing a position (`positionId`, `instrumentId`, optional `unitsToDeduct`; omit to close all) | `POST /api/v1/trading/execution/market-close-orders/positions/{positionId}` (demo: `/execution/demo/...`) |
| `etoro_prepare_modify_position` | Previews changing the stop loss and/or take profit of an open position (`positionId`; `stopLossRate`, `stopLossType` fixed/trailing, `clearStopLoss`, `takeProfitRate`, `clearTakeProfit`; at least one). Rates are instrument prices. The preview shows the position's direction, current price and current stop/take profit, and warns when a new rate is on the wrong side of the price or may move funds into margin | `PATCH /api/v2/trading/positions/{positionId}` (demo: `/api/v2/trading/demo/positions/{positionId}`) |
| `etoro_prepare_cancel_order` | Previews cancelling a pending order (`orderId`) | `DELETE /api/v2/trading/execution/orders/{orderId}` (demo: `/execution/demo/orders/{orderId}`) |
| `etoro_prepare_transfer` | Previews an internal account-to-account transfer. **Real only**, needs `ETORO_ALLOW_TRANSFERS=true` | `POST /api/v1/money/transfers` |

The preview checks `settlementType` against the account's eligibility for that instrument and direction (long or short) and rejects one that is not offered; it returns `settlement: { requested, offered }` (`offered` is `null` when the eligibility check was unavailable, in which case nothing is blocked). If you omit `settlementType` and only one type is offered, the summary says which one the order will use. A symbol ending in `.RTH` is the regular-trading-hours instrument and gets a warning.

`etoro_prepare_open_position` parameters: `symbol` or `instrumentId`; `side` (`buy` | `sellShort`); `settlementType` (`real` | `cfd`, optional); `orderType` (`mkt` | `mit` | `limitIOC`); `amountUsd` or `units`; `leverage` (default 1); `stopLossRate`, `stopLossType` (`fixed` | `trailing`), `takeProfitRate`, `triggerRate` (mit), `limitRate` (limitIOC).

Rules enforced before a preview is created (mirroring eToro's documented constraints): exactly one of symbol/instrumentId and one of amountUsd/units; `stopLossRate` required when leverage > 1, when short selling, or with a trailing stop; `triggerRate` for `mit`; `limitRate` for `limitIOC`; exposure (amount × leverage) at most `ETORO_MAX_ORDER_USD`.

### Watchlists (no money involved)

| Tool | Route |
|---|---|
| `etoro_prepare_create_watchlist` | `POST /api/v1/watchlists?name=&type=` |
| `etoro_prepare_add_watchlist_items` | `POST /api/v1/watchlists/{id}/items` |
| `etoro_prepare_remove_watchlist_items` | `DELETE /api/v1/watchlists/{id}/items` |
| `etoro_prepare_delete_watchlist` | `DELETE /api/v1/watchlists/{id}` |

These follow the same rule as orders: the tool only prepares, and the route above is called when the user presses Execute on the approval page (the page lists instrument names for item changes).

## Environment verification

`etoro_check_connection` reports `keyIsFor` (environments present in the key's scopes), `dataBelongsTo` (whether the portfolio's `cid` equals your `demoCid` or `realCid`), `environmentVerified`, and warnings. The same check (`KeyGuard`) runs, cached for 5 minutes, before every `etoro_prepare_open_position`, `etoro_prepare_close_position`, `etoro_prepare_cancel_order` and `etoro_prepare_transfer`, and refuses when the key has no Write scope for `ETORO_ENV`, when the data belongs to the other account, or when neither can be determined.

## Rate limits

eToro applies shared quotas (about 60 requests/60 s for most reads, 120/60 s for market data, 20/60 s for trading writes). The client retries `429` responses up to 3 attempts honoring `Retry-After`, reusing the same `x-request-id`.

## Compact portfolio views

eToro's breakdown and PnL payloads repeat ~36 fields per position and nest every copied trader's positions, so with copy trading they reach hundreds of thousands of characters. `etoro_get_portfolio_breakdown` and `etoro_get_pnl` therefore return a compact view by default:

- **`summary`** (default): your own positions, paged (`limit`/`offset`), each with `positionID`, `instrumentID` plus the instrument `symbol`/`name`, `isBuy`, `openDateTime`, `openRate`, `units`, `amount`, `leverage`, `stopLossRate`/`takeProfitRate` (`null` when none is set), `totalFees`, `settlement` (`cfd` | `real`), `settlementTypeID`, `isSettled`, `mirrorID`; plus credit, bonus credit, any non-empty pending-order lists, and one summary per copied trader (`mirrorID`, `parentUsername`, `initialInvestment`, `availableAmount`, `closedPositionsNetProfit`, `positionsCount`, ...). The PnL tool adds `unrealizedPnL` (`pnL`, `exposureInAccountCurrency`, `marginInAccountCurrency`, `closeRate`) per position and a computed `positionsUnrealizedPnL` per mirror.
- **`mirror`**: the positions of one copied trader (`mirrorId` required), paged.
- **`raw`**: eToro's full JSON. Past `ETORO_MAX_RESPONSE_CHARS`, arrays are shortened and `_truncated` lists each array's real length.

`settlementTypeID` and `isSettled` are returned as eToro sends them, and `settlement` is derived from `settlementTypeID`: `0` is `cfd`, `1` is `real`. Both ids were verified against eToro (a plain AAPL buy came back `0` / `isSettled: false`, and a request for type `1` on a CFD-only account was rejected as "settlement type: 1 is disallowed"). Any other id is returned without a `settlement` label rather than guessed.
