import { z } from "zod";
import { transfersEnabled, writeEnabled } from "../config.js";
import { R } from "../endpoints.js";
import { fetchIdentity, fetchSnapshotCid, ownerOfCid, scopesByEnvironment, type Identity } from "../environment.js";
import { summarizeCandles } from "../candles.js";
import { asRecord, lookupInstruments } from "../instruments.js";
import { type View, compactPortfolio } from "../portfolio.js";
import { InputError } from "../errors.js";
import { projectAlerts } from "../alerts.js";
import { probeRuntime } from "../runtime.js";
import { SERVER_NAME, VERSION } from "../version.js";
import { type ToolContext, READ, explain, extractList, fail, guarded, ok } from "./common.js";

const id = z.number().int().positive();
const DOCS = "https://api-portal.etoro.com";

/**
 * Read-only tools. They never change state (the what-if and eligibility
 * queries are POST requests at eToro but only compute and return data).
 * Responses are returned as eToro sends them.
 */
export function registerReadTools({ mcp, cfg, client, store }: ToolContext): void {
  const env = cfg.env;

  mcp.registerTool(
    "etoro_check_connection",
    {
      title: "Check eToro connection",
      description:
        "Verifies that the configured API keys authenticate, which environments (demo/real) and permissions (read/write) the key has, " +
        "and whether the account that answers for the configured environment really is that environment's account. " +
        "Returns a result per check (never key values), a masked account reference, the server's mode (read-only or write-enabled, with its caps) " +
        "and whether the MCP client can show confirmation prompts. Makes two small read requests and places nothing.",
      inputSchema: {},
      annotations: READ("Check eToro connection"),
    },
    guarded(async () => {
      type Outcome<T> = { ok: true; value: T; ms: number } | { ok: false; error: unknown; ms: number };
      const timed = async <T>(fn: () => Promise<T>): Promise<Outcome<T>> => {
        const t0 = Date.now();
        try {
          return { ok: true, value: await fn(), ms: Date.now() - t0 };
        } catch (error) {
          return { ok: false, error, ms: Date.now() - t0 };
        }
      };
      const oneLine = (err: unknown): string => explain(err).replace(/\s*\n\s*/g, " ");
      const mask = (n: number | undefined): string | null => (n === undefined ? null : `***${String(n).slice(-3)}`);

      const checks: Array<{ name: string; ok: boolean; detail: string; ms?: number }> = [];
      const warnings: string[] = [];

      const me = await timed(() => fetchIdentity(client));
      let identity: Identity | undefined;
      if (me.ok) {
        identity = me.value;
        checks.push({ name: "authentication", ok: true, ms: me.ms, detail: "eToro accepted the keys and identified the account." });
      } else {
        checks.push({ name: "authentication", ok: false, ms: me.ms, detail: oneLine(me.error) });
      }

      let cid: number | undefined;
      if (identity) {
        const route = await timed(() => fetchSnapshotCid(client, env));
        if (route.ok) {
          cid = route.value;
          checks.push({ name: `${env} environment route`, ok: true, ms: route.ms, detail: `The ${env} portfolio endpoint answered.` });
        } else {
          checks.push({
            name: `${env} environment route`,
            ok: false,
            ms: route.ms,
            detail: `${oneLine(route.error)} The keys authenticated, so this usually means the key pair was created for the other environment (ETORO_ENV is ${env}) or lacks Read permission.`,
          });
        }
      } else {
        checks.push({ name: `${env} environment route`, ok: false, detail: "Skipped because authentication failed." });
      }

      // Cross-check: does the OTHER environment's route also answer with this key, and with which account?
      const otherEnv = env === "demo" ? "real" : "demo";
      const otherProbe = identity ? await timed(() => fetchSnapshotCid(client, otherEnv)) : undefined;

      const scoped = identity ? scopesByEnvironment(identity.scopes) : undefined;
      const keyIsFor = scoped ? (["demo", "real"] as const).filter((e) => scoped[e].read || scoped[e].write) : [];
      const dataBelongsTo = identity ? ownerOfCid(cid, identity) : "unknown";

      if (identity) {
        if (identity.scopes.length === 0) {
          warnings.push("eToro did not report the key's scopes, so the key's environment cannot be read from it; rely on dataBelongsTo.");
        } else if (!keyIsFor.includes(env)) {
          warnings.push(`ETORO_ENV is ${env} but the key's scopes are for: ${keyIsFor.join(", ") || "neither environment"}.`);
        }
        if (dataBelongsTo !== "unknown" && dataBelongsTo !== env) {
          warnings.push(`ETORO_ENV is ${env} but the data returned belongs to your ${dataBelongsTo.toUpperCase()} account. Do not enable write tools until this is resolved.`);
        }
      }
      let otherEnvironmentRoute: { environment: string; answered: boolean; sameAccountAsConfigured: boolean | null; belongsTo: string | null } | null = null;
      if (otherProbe && identity) {
        const same = otherProbe.ok && cid !== undefined && otherProbe.value !== undefined ? otherProbe.value === cid : null;
        otherEnvironmentRoute = {
          environment: otherEnv,
          answered: otherProbe.ok,
          sameAccountAsConfigured: same,
          belongsTo: otherProbe.ok ? ownerOfCid(otherProbe.value, identity) : null,
        };
        if (same) {
          warnings.push(`The ${env} and ${otherEnv} routes returned the same account, so the environment cannot be told apart through the API.`);
        } else if (otherProbe.ok && identity.scopes.length > 0 && scoped && !scoped[otherEnv].read && !scoped[otherEnv].write) {
          warnings.push(`The ${otherEnv} route answered although the key's scopes are not for ${otherEnv}; scope enforcement could not be confirmed.`);
        }
      }

      const advice: string[] = [];
      if (scoped && scoped[otherEnv].write) {
        advice.push(
          cfg.strictKeyScope
            ? `This key can ALSO place orders in the ${otherEnv.toUpperCase()} environment (its scopes include trade.${otherEnv}:write). Strict key scope is ON (the default for ${env === "real" ? "real" : "an explicit setting"}), so trading previews will be refused with this key. Use a key limited to ${env}.`
            : `This key can ALSO place orders in the ${otherEnv.toUpperCase()} environment (its scopes include trade.${otherEnv}:write). ETORO_ENV=${env} keeps this server on ${env} routes, ` +
                `but a leaked key could trade ${otherEnv}. Strict key scope is off (the default for demo); set ETORO_STRICT_KEY_SCOPE=true to make the server refuse such keys for trading.`,
        );
      }
      if (scoped && scoped[env].write && !writeEnabled(cfg)) {
        advice.push(`This server is read-only but the key has Write permission for ${env}. A Read-only key limits the damage if the key ever leaks.`);
      }
      if (identity) advice.push("Restrict the key by IP address and set an expiry in eToro (Settings > Trading > API Key Management); neither can be checked through the API.");
      const environmentVerified =
        !!identity && warnings.every((w) => w.startsWith("eToro did not report")) && (dataBelongsTo === env || (dataBelongsTo === "unknown" && keyIsFor.includes(env)));

      return ok({
        connected: me.ok,
        environment: env,
        environmentVerified,
        dataBelongsTo,
        otherEnvironmentRoute,
        keyIsFor,
        account: identity ? { username: identity.username ?? null, gcid: mask(identity.gcid), demoCid: mask(identity.demoCid), realCid: mask(identity.realCid) } : null,
        keyScopes: identity?.scopes ?? [],
        warnings,
        advice,
        checks,
        mode: {
          writeToolsRegistered: writeEnabled(cfg),
          realMoneyWritesAllowed: cfg.env === "real" && writeEnabled(cfg),
          transfersAllowed: transfersEnabled(cfg),
          executionByUserOnly: true,
          strictKeyScope: cfg.strictKeyScope,
          maxOrderUsd: cfg.maxOrderUsd,
          maxSessionUsd: cfg.maxSessionUsd,
          maxWritesPerMinute: cfg.maxWritesPerMinute,
          maxDailyUsd: cfg.maxDailyUsd,
          maxDailyWrites: cfg.maxDailyWrites,
          timeZone: cfg.timezone,
        },
        today: (() => {
          const u = store.db.usage(cfg.env, Date.now(), cfg.timezone);
          return { day: u.day, executedUsd: Number(u.usd.toFixed(2)), executedWrites: u.writes };
        })(),
        history: { persistent: store.db.persistent, ...(store.db.persistent ? { path: store.db.path } : {}) },
        server: { name: SERVER_NAME, version: VERSION },
        runtime: await probeRuntime(),
      });
    }),
  );

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

  const viewSchema = {
    view: z
      .enum(["summary", "mirror", "raw"])
      .default("summary")
      .describe(
        "summary: compact own positions plus a summary of each copied trader (no copied positions). " +
          "mirror: the positions of one copied trader (needs mirrorId). raw: eToro's full JSON (very large with copy trading; arrays are shortened to fit).",
      ),
    mirrorId: id.optional().describe("Copy-trading relationship to open when view is 'mirror'. Listed in the summary view."),
    limit: z.number().int().min(1).max(200).default(50).describe("Positions per page."),
    offset: z.number().int().min(0).default(0).describe("Positions to skip, for paging."),
  };

  /** Fetch, compact and add instrument symbols to the positions shown. */
  async function portfolioView(route: ReturnType<typeof R.portfolioBreakdown>, args: { view: View; mirrorId?: number; limit: number; offset: number }, withPnl: boolean) {
    if (args.view === "mirror" && args.mirrorId === undefined) throw new InputError("view 'mirror' needs a mirrorId.");
    const response = await client.call(route);
    if (args.view === "raw") return ok(response);

    const compact = compactPortfolio(response, { ...args, withPnl }) as Record<string, any>;
    const shown: Array<Record<string, unknown>> = compact.positions?.items ?? [];
    const names = await lookupInstruments(client, shown.map((p) => Number(p.instrumentID)));
    for (const position of shown) {
      const instrument = names.get(Number(position.instrumentID));
      if (instrument) Object.assign(position, { symbol: instrument.symbol, name: instrument.displayName });
    }
    return ok(compact);
  }

  mcp.registerTool(
    "etoro_get_portfolio_breakdown",
    {
      title: "Get eToro positions and pending orders",
      description:
        `Open positions (with position ids, instrument symbol, units, open rate, stop loss and take profit), pending orders and available credit for the ${env} account. ` +
        "The default view is compact; copied traders' positions are in the 'mirror' view, paged with limit and offset. " +
        "Position ids from here are what etoro_prepare_close_position needs. For current profit/loss per position use etoro_get_pnl; for an account overview use etoro_get_portfolio.",
      inputSchema: viewSchema,
      annotations: READ("Get eToro positions and pending orders"),
    },
    guarded(async (args) => portfolioView(R.portfolioBreakdown(env), args, false)),
  );

  mcp.registerTool(
    "etoro_get_pnl",
    {
      title: "Get eToro account PnL",
      description:
        `Unrealized profit/loss of the ${env} account: the total, and for each position its profit/loss, exposure, margin and current rate. ` +
        "Same views and paging as etoro_get_portfolio_breakdown; the default view is compact and copied traders' positions are in the 'mirror' view.",
      inputSchema: viewSchema,
      annotations: READ("Get eToro account PnL"),
    },
    guarded(async (args) => portfolioView(R.pnl(env), args, true)),
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
        "Status and execution details of one order, found by orderId (returned when an order is placed) or by referenceId. Provide exactly one. " +
        "Observed statuses include WaitingForMarket and Filled. A just-placed order can answer 404 for a few seconds before eToro registers it.",
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
        "This is an exact lookup; for a name or partial text (for example 'apple') use etoro_search_instruments. ETF listings use exchange suffixes (for example EXMPL.L). " +
        "Provide symbols or instrumentIds, not both.",
      inputSchema: {
        symbols: z.array(z.string().min(1).max(30)).max(50).optional().describe("Exact tickers, e.g. ['AAPL', 'EXMPL.L']."),
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
    "etoro_search_instruments",
    {
      title: "Search eToro instruments by text",
      description:
        "Free-text search of instruments by name or ticker (for example 'apple', 'S&P 500', 'EXMPL'). Returns up to `limit` matches with instrumentId, symbol, displayName, type and exchangeId, without images. " +
        "Some stocks appear twice: the plain ticker is the 24/5 instrument and a symbol ending in .RTH is the regular-trading-hours one. " +
        "Use the instrumentId or the exact symbol with the other tools.",
      inputSchema: {
        query: z.string().min(1).max(100).describe("Text to search for."),
        limit: z.number().int().min(1).max(50).default(10),
      },
      annotations: READ("Search eToro instruments by text"),
    },
    guarded(async ({ query, limit }) => {
      const response = await client.call(R.instrumentSearch(), { query: { query, limit } });
      const results = extractList(response, ["results", "items", "instruments", "data"]).map((raw) => {
        const r = asRecord(raw);
        return { instrumentId: r.instrumentId, symbol: r.symbol, displayName: r.displayName, type: r.type, exchangeId: r.exchangeId };
      });
      return ok({ query, count: results.length, results });
    }),
  );

  mcp.registerTool(
    "etoro_get_candles",
    {
      title: "Get eToro price candles",
      description:
        "Historical price candles (open, high, low, close, volume) for one instrument, from eToro's market data. Choose the interval (1m to 1w) and optionally a window with from and to (ISO 8601 with a timezone); " +
        "without them eToro returns the latest `limit` candles. The result includes a `summary` (first open, last close, high, low, percentage change, volume) computed from the candles returned, " +
        "so a long series does not need to be read row by row; set summaryOnly to return just that. A window can be longer than `limit`: when `pagination.hasNext` is true, call again with its nextCursor. " +
        "Prices are eToro's quotes (bid by default), not necessarily the underlying venue's. Past performance is not a forecast.",
      inputSchema: {
        instrumentId: id,
        interval: z.enum(["1m", "5m", "10m", "15m", "30m", "1h", "4h", "1d", "1w"]).default("1d"),
        from: z.string().datetime({ offset: true }).optional().describe("Inclusive start, ISO 8601 with timezone, e.g. 2026-01-01T00:00:00Z."),
        to: z.string().datetime({ offset: true }).optional().describe("Exclusive end, ISO 8601 with timezone."),
        limit: z.number().int().min(1).max(2000).default(100),
        side: z.enum(["bid", "ask", "both"]).default("bid"),
        cursor: z.string().min(1).max(500).optional().describe("The nextCursor of a previous answer."),
        summaryOnly: z.boolean().default(false).describe("Return only the summary and the pagination, without the candles."),
      },
      annotations: READ("Get eToro price candles"),
    },
    guarded(async ({ instrumentId, interval, from, to, limit, side, cursor, summaryOnly }) => {
      if (from !== undefined && to !== undefined && Date.parse(from) >= Date.parse(to)) {
        throw new InputError("from must be earlier than to.");
      }
      const response = asRecord(await client.call(R.candles(instrumentId), { query: { interval, from, to, limit, side, cursor } }));
      const results = Array.isArray(response.results) ? response.results : [];
      return ok({
        instrumentId: response.instrumentId ?? instrumentId,
        symbol: response.symbol,
        interval: response.interval ?? interval,
        side: response.side ?? side,
        window: response.window,
        pagination: response.pagination,
        summary: summarizeCandles(results) ?? null,
        ...(summaryOnly ? {} : { results }),
      });
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
    "etoro_list_price_alerts",
    {
      title: "List eToro price alerts",
      description:
        "The user's active price alerts: instrument, target price, the bid when the alert was set, which way the price has to move to reach the target and how far it is, in percent. " +
        "Alerts belong to the account, not to demo or real. Needs the key's price-alerts Read permission. Read-only.",
      inputSchema: {},
      annotations: READ("List eToro price alerts"),
    },
    guarded(async () => {
      const alerts = projectAlerts(await client.call(R.priceAlerts()));
      return ok({ count: alerts.length, alerts });
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
  mcp.registerTool(
    "etoro_get_action_status",
    {
      title: "Get the status of a prepared eToro action",
      description:
        "Where an action prepared by an etoro_prepare_* tool stands: pending (waiting for the user on the approval page), executing, executed (with eToro's answer, such as an order id), " +
        "rejected, expired or failed. Only the user can execute an action. Also finds actions from earlier sessions in the local history.",
      inputSchema: { actionId: z.string().uuid() },
      annotations: READ("Get the status of a prepared eToro action"),
    },
    guarded(async ({ actionId }) => {
      const proposal = store.get(actionId);
      if (!proposal) {
        const past = store.db.get(actionId);
        if (!past) return fail("Unknown actionId: it is not in this session or in the history.");
        return ok({
          actionId: past.id,
          tool: past.tool,
          environment: past.env,
          status: past.status,
          summary: past.summary,
          createdAt: new Date(past.createdAt).toISOString(),
          ...(past.decidedAt !== undefined ? { decidedAt: new Date(past.decidedAt).toISOString() } : {}),
          ...(past.status === "executed" ? { result: past.result } : {}),
          ...(past.status === "failed" ? { error: past.error } : {}),
          fromHistory: true,
        });
      }
      return ok(store.view(proposal));
    }),
  );
}
