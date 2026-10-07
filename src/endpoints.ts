/**
 * The complete allowlist of eToro API routes this server can call.
 * The HTTP client refuses anything that is not described here.
 *
 * Source: https://api-portal.etoro.com (llms.txt index and API reference pages).
 * The demo routes do not all follow one naming pattern (trade history is
 * `/info/trade/demo/history`, not `/info/demo/trade/history`): copy each path from its
 * own reference page, and mark a route `inferred` if you could not.
 */
import type { EtoroEnv } from "./config.js";

export type RouteKind = "read" | "write";
export type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";

export interface RouteSpec {
  id: string;
  /** "read" routes never change state (including POST what-if/eligibility queries). */
  kind: RouteKind;
  method: HttpMethod;
  path: string;
}

const id = (value: number | string): string => encodeURIComponent(String(value));

function route(idName: string, kind: RouteKind, method: HttpMethod, path: string): RouteSpec {
  return { id: idName, kind, method, path };
}

export const R = {
  // ---- Read: trading info -------------------------------------------------
  portfolioSnapshot: (env: EtoroEnv) =>
    route(
      "portfolioSnapshot",
      "read",
      "GET",
      env === "demo" ? "/api/v1/trading/info/demo/aggregate-portfolio" : "/api/v1/trading/info/aggregate-portfolio",
    ),
  portfolioBreakdown: (env: EtoroEnv) =>
    route(
      "portfolioBreakdown",
      "read",
      "GET",
      env === "demo" ? "/api/v1/trading/info/demo/portfolio" : "/api/v1/trading/info/portfolio",
    ),
  pnl: (env: EtoroEnv) =>
    route("pnl", "read", "GET", env === "demo" ? "/api/v1/trading/info/demo/pnl" : "/api/v1/trading/info/real/pnl"),
  tradeHistory: (env: EtoroEnv) =>
    route(
      "tradeHistory",
      "read",
      "GET",
      env === "demo" ? "/api/v1/trading/info/trade/demo/history" : "/api/v1/trading/info/trade/history",
    ),
  orderLookup: (env: EtoroEnv) =>
    route(
      "orderLookup",
      "read",
      "GET",
      env === "demo" ? "/api/v2/trading/info/demo/orders:lookup" : "/api/v2/trading/info/orders:lookup",
    ),
  eligibility: (env: EtoroEnv) =>
    route(
      "eligibility",
      "read",
      "POST",
      env === "demo" ? "/api/v2/trading/info/demo/eligibility" : "/api/v2/trading/info/eligibility",
    ),
  costs: (env: EtoroEnv) =>
    route("costs", "read", "POST", env === "demo" ? "/api/v2/trading/info/demo/costs" : "/api/v2/trading/info/costs"),

  // ---- Read: identity ----------------------------------------------------
  me: () => route("me", "read", "GET", "/api/v1/me"),

  // ---- Read: balances, market data, watchlists ----------------------------
  balances: () => route("balances", "read", "GET", "/api/v1/balances"),
  instruments: () => route("instruments", "read", "GET", "/api/v2/market-data/instruments"),
  rates: () => route("rates", "read", "GET", "/api/v1/market-data/instruments/rates"),
  instrumentSearch: () => route("instrumentSearch", "read", "GET", "/api/v2/market-data/instruments/search"),
  candles: (instrumentId: number) => route("candles", "read", "GET", `/api/v1/data/instruments/${id(instrumentId)}/candles`),
  watchlists: () => route("watchlists", "read", "GET", "/api/v1/watchlists"),

  // ---- Write: trading -----------------------------------------------------
  createOrder: (env: EtoroEnv) =>
    route(
      "createOrder",
      "write",
      "POST",
      env === "demo" ? "/api/v2/trading/execution/demo/orders" : "/api/v2/trading/execution/orders",
    ),
  cancelOrder: (env: EtoroEnv, orderId: number) =>
    route(
      "cancelOrder",
      "write",
      "DELETE",
      env === "demo"
        ? `/api/v2/trading/execution/demo/orders/${id(orderId)}`
        : `/api/v2/trading/execution/orders/${id(orderId)}`,
    ),
  closePosition: (env: EtoroEnv, positionId: number) =>
    route(
      "closePosition",
      "write",
      "POST",
      env === "demo"
        ? `/api/v1/trading/execution/demo/market-close-orders/positions/${id(positionId)}`
        : `/api/v1/trading/execution/market-close-orders/positions/${id(positionId)}`,
    ),
  /** Cancels a pending market-close order (a close request that has not executed yet); the position stays open. */
  cancelCloseOrder: (env: EtoroEnv, orderId: number) =>
    route(
      "cancelCloseOrder",
      "write",
      "DELETE",
      env === "demo"
        ? `/api/v1/trading/execution/demo/market-close-orders/${id(orderId)}`
        : `/api/v1/trading/execution/market-close-orders/${id(orderId)}`,
    ),
  modifyPosition: (env: EtoroEnv, positionId: number) =>
    route(
      "modifyPosition",
      "write",
      "PATCH",
      env === "demo" ? `/api/v2/trading/demo/positions/${id(positionId)}` : `/api/v2/trading/positions/${id(positionId)}`,
    ),

  // ---- Write: watchlists (no money involved) ------------------------------
  createWatchlist: () => route("createWatchlist", "write", "POST", "/api/v1/watchlists"),
  addWatchlistItems: (watchlistId: string) =>
    route("addWatchlistItems", "write", "POST", `/api/v1/watchlists/${id(watchlistId)}/items`),
  removeWatchlistItems: (watchlistId: string) =>
    route("removeWatchlistItems", "write", "DELETE", `/api/v1/watchlists/${id(watchlistId)}/items`),
  deleteWatchlist: (watchlistId: string) =>
    route("deleteWatchlist", "write", "DELETE", `/api/v1/watchlists/${id(watchlistId)}`),

  // ---- Write: money movement (extra opt-in) -------------------------------
  transfer: () => route("transfer", "write", "POST", "/api/v1/money/transfers"),
} as const;
