import { z } from "zod";
import { R } from "../endpoints.js";
import { InputError } from "../errors.js";
import { type ToolContext, READ, guarded, ok } from "./common.js";

const id = z.number().int().positive();
const DOCS = "https://api-portal.etoro.com";

/**
 * Read-only tools. They never change state (the what-if and eligibility
 * queries are POST requests at eToro but only compute and return data).
 * Responses are returned as eToro sends them.
 */
export function registerReadTools({ mcp, cfg, client }: ToolContext): void {
  const env = cfg.env;

  mcp.registerTool(
    "etoro_get_portfolio",
    {
      title: "Get eToro portfolio snapshot",
      description:
        `Aggregated snapshot of the ${env} account: account totals, open positions grouped by instrument, and copy-trading mirrors. ` +
        "For individual open positions with their position ids and pending orders use etoro_get_portfolio_breakdown. " +
        `Reference: ${DOCS}.`,
      inputSchema: {
        pnlLevel: z.enum(["None", "Pnl", "DailyPnl"]).default("Pnl").describe("Profit/loss detail to include."),
        instrumentIds: z.array(id).max(100).optional().describe("Restrict the snapshot to these instrument ids."),
      },
      annotations: READ("Get eToro portfolio snapshot"),
    },
    guarded(async ({ pnlLevel, instrumentIds }) =>
      ok(await client.call(R.portfolioSnapshot(env), { query: { pnlLevel, instrumentIds } })),
    ),
  );

  mcp.registerTool(
    "etoro_get_portfolio_breakdown",
    {
      title: "Get eToro positions and pending orders",
      description:
        `Open positions (with position ids and units), pending orders and available credit for the ${env} account. ` +
        "Position ids from here are what etoro_prepare_close_position needs.",
      inputSchema: {},
      annotations: READ("Get eToro positions and pending orders"),
    },
    guarded(async () => ok(await client.call(R.portfolioBreakdown(env)))),
  );

  mcp.registerTool(
    "etoro_get_pnl",
    {
      title: "Get eToro account PnL",
      description:
        `Unrealized profit/loss and portfolio details of the ${env} account (positions, mirrors, pending orders and orders to open/close).`,
      inputSchema: {},
      annotations: READ("Get eToro account PnL"),
    },
    guarded(async () => ok(await client.call(R.pnl(env)))),
  );

  mcp.registerTool(
    "etoro_get_balances",
    {
      title: "Get eToro balances",
      description:
        "Aggregated balances across the user's eToro accounts (trading, cash, ...), expressed in a display currency. " +
        "Not environment-specific: it reports the account the key belongs to.",
      inputSchema: {
        displayCurrency: z.string().length(3).default("USD").describe("ISO 4217 code used for totals."),
        includeZeroBalances: z.boolean().default(false),
        includeSubAccounts: z.boolean().default(false),
        accountTypes: z
          .string()
          .optional()
          .describe("Comma-separated filter: Trading, Cash, Options, Crypto, MoneyFarm, Spaceship, Plaee."),
      },
      annotations: READ("Get eToro balances"),
    },
    guarded(async (query) => ok(await client.call(R.balances(), { query }))),
  );

  mcp.registerTool(
    "etoro_get_trade_history",
    {
      title: "Get eToro closed trades",
      description:
        `Closed trades of the ${env} account since a date, with open/close rates, net profit and fees. Paginated.`,
      inputSchema: {
        minDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Start date, YYYY-MM-DD."),
        page: z.number().int().min(1).optional(),
        pageSize: z.number().int().min(1).max(500).optional(),
      },
      annotations: READ("Get eToro closed trades"),
    },
    guarded(async (query) => ok(await client.call(R.tradeHistory(env), { query }))),
  );

  mcp.registerTool(
    "etoro_get_order",
    {
      title: "Look up an eToro order",
      description:
        "Status and execution details of one order, found by orderId (returned when an order is placed) or by referenceId. Provide exactly one.",
      inputSchema: {
        orderId: id.optional(),
        referenceId: z.string().min(1).max(100).optional(),
      },
      annotations: READ("Look up an eToro order"),
    },
    guarded(async ({ orderId, referenceId }) => {
      if ((orderId === undefined) === (referenceId === undefined)) {
        throw new InputError("Provide exactly one of orderId or referenceId.");
      }
      return ok(await client.call(R.orderLookup(env), { query: { orderId, referenceId } }));
    }),
  );

  mcp.registerTool(
    "etoro_get_instruments",
    {
      title: "Find eToro instruments",
      description:
        "Look up instruments by exact ticker symbols or by instrument ids, or list by type. Returns instrumentId, symbol, displayName, type and exchangeId. " +
        "Free-text name search is not supported; ETF listings use exchange suffixes (for example CSPX.L). " +
        "Provide symbols or instrumentIds, not both.",
      inputSchema: {
        symbols: z.array(z.string().min(1).max(30)).max(50).optional().describe("Exact tickers, e.g. ['AAPL', 'CSPX.L']."),
        instrumentIds: z.array(id).max(100).optional(),
        type: z
          .enum(["Forex", "Commodity", "CFD", "Indices", "Stocks", "ETF", "Bonds", "TrustFunds", "Options", "Crypto"])
          .optional(),
        pageSize: z.number().int().min(1).max(100).default(20),
      },
      annotations: READ("Find eToro instruments"),
    },
    guarded(async ({ symbols, instrumentIds, type, pageSize }) => {
      if (symbols !== undefined && instrumentIds !== undefined) {
        throw new InputError("Provide symbols or instrumentIds, not both.");
      }
      return ok(
        await client.call(R.instruments(), { query: { symbols, instrumentsIds: instrumentIds, type, pageSize } }),
      );
    }),
  );

  mcp.registerTool(
    "etoro_get_rates",
    {
      title: "Get eToro bid/ask rates",
      description: "Current bid and ask for up to 100 instruments by id. Prices are eToro's quotes, not necessarily the underlying venue's.",
      inputSchema: { instrumentIds: z.array(id).min(1).max(100) },
      annotations: READ("Get eToro bid/ask rates"),
    },
    guarded(async ({ instrumentIds }) => ok(await client.call(R.rates(), { query: { instrumentIds } }))),
  );

  mcp.registerTool(
    "etoro_check_eligibility",
    {
      title: "Check eToro trading eligibility",
      description:
        `What the ${env} account may do with instruments: available settlement types (real/cfd), leverage values, buy/sell and partial-close permissions, ` +
        "minimum position amounts, stop-loss/take-profit limits. Computes only; places nothing. Provide instrumentIds and/or symbols (max 100 combined).",
      inputSchema: {
        instrumentIds: z.array(id).max(100).optional(),
        symbols: z.array(z.string().min(1).max(30)).max(100).optional(),
      },
      annotations: READ("Check eToro trading eligibility"),
    },
    guarded(async ({ instrumentIds, symbols }) => {
      if (!instrumentIds?.length && !symbols?.length) throw new InputError("Provide instrumentIds or symbols.");
      return ok(await client.call(R.eligibility(env), { body: { instrumentIds, symbols, currency: "USD" } }));
    }),
  );

  mcp.registerTool(
    "etoro_get_trading_costs",
    {
      title: "Estimate eToro trading costs",
      description:
        "What-if cost breakdown (markup, market spread, transaction fee, overnight and weekend fees, stamp duty) for a hypothetical order. " +
        "Computes only; places nothing. Amounts are in USD. For closing, pass the position ids.",
      inputSchema: {
        action: z.enum(["open", "close"]).default("open"),
        transaction: z.enum(["buy", "sell", "sellShort", "buyToCover"]).default("buy"),
        symbol: z.string().min(1).max(30).optional(),
        instrumentId: id.optional(),
        settlementType: z.enum(["cfd", "real", "realFutures", "marginTrade"]).optional(),
        orderType: z.enum(["mkt", "mit", "limitIOC"]).default("mkt"),
        leverage: z.number().int().min(1).max(100).default(1),
        amountUsd: z.number().positive().optional(),
        positionIds: z.array(id).max(50).optional(),
      },
      annotations: READ("Estimate eToro trading costs"),
    },
    guarded(async (a) => {
      if ((a.symbol === undefined) === (a.instrumentId === undefined)) {
        throw new InputError("Provide exactly one of symbol or instrumentId.");
      }
      return ok(
        await client.call(R.costs(env), {
          body: {
            action: a.action,
            transaction: a.transaction,
            symbol: a.symbol,
            instrumentId: a.instrumentId,
            settlementType: a.settlementType,
            orderType: a.orderType,
            leverage: a.leverage,
            amount: a.amountUsd,
            orderCurrency: "USD",
            positionIds: a.positionIds,
          },
        }),
      );
    }),
  );

  mcp.registerTool(
    "etoro_list_watchlists",
    {
      title: "List eToro watchlists",
      description: "The user's watchlists with their items (instrument ids).",
      inputSchema: {
        itemsPerPage: z.number().int().min(1).max(1000).default(100),
        includeBuiltin: z.boolean().default(true),
      },
      annotations: READ("List eToro watchlists"),
    },
    guarded(async ({ itemsPerPage, includeBuiltin }) =>
      ok(
        await client.call(R.watchlists(), {
          query: { itemsPerPageForSingle: itemsPerPage, ensureBuiltinWatchlists: includeBuiltin },
        }),
      ),
    ),
  );
}
