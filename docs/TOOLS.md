# Tool reference

All tools are prefixed `etoro_`. Read tools are annotated `readOnlyHint: true`; write tools `readOnlyHint: false` (with `destructiveHint` set where the action is irreversible). Names are well under 64 characters. Responses are eToro's JSON as returned (truncated with a note above ~120k characters).

`env` below is the configured `ETORO_ENV` (`demo` or `real`). Reference pages live under <https://api-portal.etoro.com>.

## Read tools

| Tool | Method and route | Parameters |
|---|---|---|
| `etoro_check_connection` | `GET /api/v1/me` (identity and key scopes) and the environment's portfolio snapshot route (`pnlLevel=None`) | – |
| `etoro_get_portfolio` | `GET /api/v1/trading/info/aggregate-portfolio` (demo: `/info/demo/aggregate-portfolio`) | `pnlLevel` (None/Pnl/DailyPnl), `instrumentIds[]` |
| `etoro_get_portfolio_breakdown` | `GET /api/v1/trading/info/portfolio` (demo: `/info/demo/portfolio`, inferred) | `view` (`summary` default, `mirror`, `raw`), `mirrorId`, `limit` (≤200, default 50), `offset` |
| `etoro_get_pnl` | `GET /api/v1/trading/info/real/pnl` (demo: `/info/demo/pnl`, inferred) | same as the breakdown: `view`, `mirrorId`, `limit`, `offset` |
| `etoro_get_balances` | `GET /api/v1/balances` | `displayCurrency`, `includeZeroBalances`, `includeSubAccounts`, `accountTypes` |
| `etoro_get_trade_history` | `GET /api/v1/trading/info/trade/history` (demo inferred) | `minDate` (YYYY-MM-DD), `page`, `pageSize` |
| `etoro_get_order` | `GET /api/v2/trading/info/orders:lookup` (demo inferred) | exactly one of `orderId`, `referenceId` |
| `etoro_get_instruments` | `GET /api/v2/market-data/instruments` | `symbols[]` or `instrumentIds[]`, `type`, `pageSize` |
| `etoro_get_rates` | `GET /api/v1/market-data/instruments/rates` | `instrumentIds[]` (1–100) |
| `etoro_check_eligibility` | `POST /api/v2/trading/info/eligibility` (computes only; demo inferred) | `instrumentIds[]` and/or `symbols[]` |
| `etoro_get_trading_costs` | `POST /api/v2/trading/info/costs` (what-if; demo: `/info/demo/costs`) | `action`, `transaction`, `symbol`/`instrumentId`, `settlementType`, `orderType`, `leverage`, `amountUsd`, `positionIds[]` |
| `etoro_list_watchlists` | `GET /api/v1/watchlists` | `itemsPerPage`, `includeBuiltin` |

## Write tools (registered only with `ETORO_ENABLE_WRITE=true`; real needs `ETORO_ALLOW_REAL_WRITE=true`)

### Two-step trading actions

| Tool | What it does | Executed route (on confirm) |
|---|---|---|
| `etoro_prepare_open_position` | Resolves the instrument, checks eligibility and costs, enforces `ETORO_MAX_ORDER_USD`, returns a `confirmationId` | `POST /api/v2/trading/execution/orders` (demo: `/execution/demo/orders`) |
| `etoro_prepare_close_position` | Previews closing a position (`positionId`, `instrumentId`, optional `unitsToDeduct`; omit to close all) | `POST /api/v1/trading/execution/market-close-orders/positions/{positionId}` (demo: `/execution/demo/...`) |
| `etoro_prepare_cancel_order` | Previews cancelling a pending order (`orderId`) | `DELETE /api/v2/trading/execution/orders/{orderId}` (demo: `/execution/demo/orders/{orderId}`) |
| `etoro_prepare_transfer` | Previews an internal account-to-account transfer. **Real only**, needs `ETORO_ALLOW_TRANSFERS=true` | `POST /api/v1/money/transfers` |
| `etoro_confirm_action` | Executes a previewed action by `confirmationId`: single use, expires after `ETORO_CONFIRM_TTL_SECONDS`, subject to the write rate limit and session cap, and asks the user via elicitation when the client supports it | – |

The preview checks `settlementType` against the account's eligibility for that instrument and direction (long or short) and rejects one that is not offered; it returns `settlement: { requested, offered }` (`offered` is `null` when the eligibility check was unavailable, in which case nothing is blocked). If you omit `settlementType` and only one type is offered, the summary says which one the order will use. A symbol ending in `.RTH` is the regular-trading-hours instrument and gets a warning.

`etoro_prepare_open_position` parameters: `symbol` or `instrumentId`; `side` (`buy` | `sellShort`); `settlementType` (`real` | `cfd`, optional); `orderType` (`mkt` | `mit` | `limitIOC`); `amountUsd` or `units`; `leverage` (default 1); `stopLossRate`, `stopLossType` (`fixed` | `trailing`), `takeProfitRate`, `triggerRate` (mit), `limitRate` (limitIOC).

Rules enforced before a preview is created (mirroring eToro's documented constraints): exactly one of symbol/instrumentId and one of amountUsd/units; `stopLossRate` required when leverage > 1, when short selling, or with a trailing stop; `triggerRate` for `mit`; `limitRate` for `limitIOC`; exposure (amount × leverage) at most `ETORO_MAX_ORDER_USD`.

### Watchlists (no money involved)

| Tool | Route |
|---|---|
| `etoro_create_watchlist` | `POST /api/v1/watchlists?name=&type=` |
| `etoro_add_watchlist_items` | `POST /api/v1/watchlists/{id}/items` |
| `etoro_remove_watchlist_items` | `DELETE /api/v1/watchlists/{id}/items` (asks for approval when the client supports it) |
| `etoro_delete_watchlist` | `DELETE /api/v1/watchlists/{id}` (asks for approval when the client supports it) |

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
