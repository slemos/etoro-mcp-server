import { z } from "zod";
import { transfersEnabled } from "../config.js";
import { R } from "../endpoints.js";
import { type Instrument, asRecord, toInstrument } from "../instruments.js";
import { InputError, PolicyError } from "../errors.js";
import { askHuman } from "../safety.js";
import { offeredSettlements } from "../settlement.js";
import { type ToolContext, WRITE, extractList, fail, guarded, ok, explain } from "./common.js";

const id = z.number().int().positive();

async function resolveInstrument(ctx: ToolContext, symbol?: string, instrumentId?: number): Promise<Instrument> {
  const { client } = ctx;
  if (instrumentId !== undefined) {
    const list = extractList(await client.call(R.instruments(), { query: { instrumentsIds: [instrumentId], pageSize: 5 } }));
    const hit = list.map(toInstrument).find((i) => i?.instrumentId === instrumentId);
    if (!hit) throw new InputError(`Instrument id ${instrumentId} was not found on eToro.`);
    return hit;
  }
  const wanted = (symbol ?? "").toUpperCase();
  const list = extractList(await client.call(R.instruments(), { query: { symbols: [symbol], pageSize: 20 } }));
  const matches = list.map(toInstrument).filter((i): i is Instrument => !!i && i.symbol.toUpperCase() === wanted);
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) {
    throw new InputError(`No eToro instrument has the symbol "${symbol}". Use etoro_get_instruments to find the exact ticker.`);
  }
  const options = matches.map((m) => `${m.symbol} (id ${m.instrumentId}, ${m.displayName ?? m.type ?? "?"})`).join("; ");
  throw new InputError(`Symbol "${symbol}" matches several instruments: ${options}. Pass instrumentId instead.`);
}

async function bestEffort<T>(label: string, warnings: string[], fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    warnings.push(`${label} unavailable: ${explain(err).split("\n")[0]}`);
    return undefined;
  }
}

const usd = (n: number): string => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function registerWriteTools(ctx: ToolContext): void {
  const { mcp, cfg, client, pending, audit, guard } = ctx;
  const env = cfg.env;
  const envLabel = env.toUpperCase();

  // ------------------------------------------------------------------ open
  mcp.registerTool(
    "etoro_prepare_open_position",
    {
      title: "Preview opening an eToro position",
      description:
        `Validates and previews an order to open a position in the ${envLabel} account: resolves the instrument, checks eligibility, estimates costs and ` +
        `checks the per-order cap (ETORO_MAX_ORDER_USD = ${cfg.maxOrderUsd} USD of exposure, i.e. amount x leverage). ` +
        "Sends nothing to eToro: it returns a confirmationId that etoro_confirm_action executes. " +
        "settlementType 'real' buys the actual asset, 'cfd' opens a contract for difference; the preview rejects a type the account is not offered for that instrument " +
        "(some jurisdictions only get CFDs). Some stocks have a separate regular-hours instrument (symbol ending in .RTH) next to the 24/5 one: pass the exact symbol or instrumentId. Leverage above 1, short selling and trailing stops require stopLossRate. " +
        "Order reference: https://api-portal.etoro.com/core/guides/market-orders.md.",
      inputSchema: {
        symbol: z.string().min(1).max(30).optional().describe("Exact ticker, e.g. 'CSPX.L'. Provide symbol or instrumentId."),
        instrumentId: id.optional(),
        side: z.enum(["buy", "sellShort"]).describe("'buy' opens a long position; 'sellShort' opens a short (requires stopLossRate)."),
        settlementType: z.enum(["real", "cfd"]).optional().describe("Omit to let eToro apply its default for this instrument."),
        orderType: z.enum(["mkt", "mit", "limitIOC"]).default("mkt").describe("mkt = market, mit = market-if-touched (needs triggerRate), limitIOC (needs limitRate)."),
        amountUsd: z.number().positive().optional().describe("Cash to invest in USD. Provide amountUsd or units."),
        units: z.number().positive().optional().describe("Number of units. Provide amountUsd or units."),
        leverage: z.number().int().min(1).max(100).default(1),
        stopLossRate: z.number().positive().optional(),
        stopLossType: z.enum(["fixed", "trailing"]).default("fixed"),
        takeProfitRate: z.number().positive().optional(),
        triggerRate: z.number().positive().optional().describe("Trigger price for mit orders."),
        limitRate: z.number().positive().optional().describe("Limit price for limitIOC orders (max 10% from market)."),
      },
      annotations: WRITE("Preview opening an eToro position", { destructive: false, idempotent: true }),
    },
    guarded(async (a) => {
      await guard.assertWritable();
      if ((a.symbol === undefined) === (a.instrumentId === undefined)) {
        throw new InputError("Provide exactly one of symbol or instrumentId.");
      }
      if ((a.amountUsd === undefined) === (a.units === undefined)) {
        throw new InputError("Provide exactly one of amountUsd or units.");
      }
      if ((a.leverage > 1 || a.side === "sellShort" || a.stopLossType === "trailing") && a.stopLossRate === undefined) {
        throw new InputError("stopLossRate is required when leverage > 1, side is sellShort, or stopLossType is trailing.");
      }
      if (a.orderType === "mit" && a.triggerRate === undefined) throw new InputError("triggerRate is required for mit orders.");
      if (a.orderType === "limitIOC" && a.limitRate === undefined) throw new InputError("limitRate is required for limitIOC orders.");

      const warnings: string[] = [];
      const instrument = await resolveInstrument(ctx, a.symbol, a.instrumentId);
      if (/\.RTH$/i.test(instrument.symbol)) {
        warnings.push(
          `${instrument.symbol} is the regular-trading-hours variant of the instrument; the plain ticker is the separate 24/5 instrument ` +
            `(the eToro app switches between them with its "24/5 Trading" toggle). Check that this is the one you mean.`,
        );
      }
      const rates = await bestEffort("Market rate", warnings, () =>
        client.call(R.rates(), { query: { instrumentIds: [instrument.instrumentId] } }),
      );
      const rate = asRecord(extractList(rates, ["rates"])[0]);
      const ask = Number(rate.ask);

      let cash: number;
      if (a.amountUsd !== undefined) {
        cash = a.amountUsd;
      } else if (Number.isFinite(ask) && ask > 0) {
        cash = (a.units as number) * ask;
      } else {
        throw new InputError("Could not estimate the value of a units-based order (no market rate). Use amountUsd instead.");
      }
      const exposure = cash * a.leverage;
      if (exposure > cfg.maxOrderUsd) {
        throw new PolicyError(
          `Order exposure ${usd(exposure)} (amount x leverage) exceeds the per-order cap ETORO_MAX_ORDER_USD (${usd(cfg.maxOrderUsd)}). ` +
            "Reduce the size, or raise the cap in the server configuration if that is intended.",
        );
      }

      const eligibility = await bestEffort("Eligibility check", warnings, () =>
        client.call(R.eligibility(env), { body: { instrumentIds: [instrument.instrumentId], currency: "USD" } }),
      );
      const direction = a.side === "buy" ? "long" : "short";
      const offered = offeredSettlements(eligibility, instrument.instrumentId, direction);
      if (a.settlementType !== undefined && offered.known && !offered.settlements.includes(a.settlementType)) {
        throw new InputError(
          `This ${envLabel} account does not offer settlementType '${a.settlementType}' for ${instrument.symbol} (${direction}): eToro offers ${offered.settlements.join(", ")}. ` +
            "What is offered depends on the account's jurisdiction (for example, some accounts can only trade CFDs). Nothing was sent.",
        );
      }
      const onlyOffered = offered.settlements.length === 1 ? offered.settlements[0] : undefined;
      if (a.settlementType === undefined && a.side === "buy") {
        warnings.push(
          onlyOffered
            ? `No settlementType was given. eToro offers only '${onlyOffered}' for this instrument on this account, so the order opens as ${onlyOffered === "cfd" ? "a CFD (a contract on the price, not the asset itself)" : "the real asset"}.`
            : "No settlementType was given, so eToro chooses it. It can be a CFD (a contract on the price, not the asset itself); " +
              "in a demo test a plain AAPL buy was opened as a CFD. Pass settlementType 'real' to ask for the actual asset, or 'cfd' to make the choice explicit.",
        );
      }
      const costs = await bestEffort("Cost estimate", warnings, () =>
        client.call(R.costs(env), {
          body: {
            action: "open",
            transaction: a.side,
            instrumentId: instrument.instrumentId,
            settlementType: a.settlementType,
            orderType: a.orderType,
            leverage: a.leverage,
            amount: cash,
            orderCurrency: "USD",
          },
        }),
      );

      const body: Record<string, unknown> = {
        action: "open",
        transaction: a.side,
        instrumentId: instrument.instrumentId,
        orderType: a.orderType,
        leverage: a.leverage,
      };
      if (a.settlementType) body.settlementType = a.settlementType;
      if (a.amountUsd !== undefined) {
        body.amount = a.amountUsd;
        body.orderCurrency = "usd";
      } else {
        body.units = a.units;
      }
      if (a.stopLossRate !== undefined) {
        body.stopLossRate = a.stopLossRate;
        body.stopLossType = a.stopLossType;
      }
      if (a.takeProfitRate !== undefined) body.takeProfitRate = a.takeProfitRate;
      if (a.triggerRate !== undefined) body.triggerRate = a.triggerRate;
      if (a.limitRate !== undefined) body.limitRate = a.limitRate;

      const size = a.amountUsd !== undefined ? `${usd(a.amountUsd)}` : `${a.units} units (~${usd(cash)})`;
      const summary =
        `OPEN ${a.side === "buy" ? "BUY" : "SHORT"} ${instrument.symbol} (id ${instrument.instrumentId}${instrument.displayName ? `, ${instrument.displayName}` : ""}) ` +
        `| ${size} | ${a.leverage}x | ${a.settlementType ?? (onlyOffered ? `${onlyOffered} (the only one offered)` : "default settlement")} | ${a.orderType} order` +
        `${a.stopLossRate !== undefined ? ` | stop loss ${a.stopLossRate} (${a.stopLossType})` : " | no stop loss"}` +
        `${a.takeProfitRate !== undefined ? ` | take profit ${a.takeProfitRate}` : ""}` +
        ` | environment ${envLabel}`;

      const action = pending.create({
        tool: "open_position",
        summary,
        exposureUsd: exposure,
        run: (requestId) => client.call(R.createOrder(env), { body, requestId }),
      });
      audit({ event: "prepared", tool: action.tool, confirmationId: action.id, summary, exposureUsd: exposure });

      return ok({
        confirmationId: action.id,
        expiresAt: new Date(action.expiresAt).toISOString(),
        environment: env,
        summary,
        instrument,
        estimatedExposureUsd: Number(exposure.toFixed(2)),
        settlement: { requested: a.settlementType ?? null, offered: offered.known ? offered.settlements : null },
        marketRate: Number.isFinite(ask) ? { bid: rate.bid, ask: rate.ask } : null,
        eligibility,
        estimatedCosts: costs,
        warnings,
        status: "Previewed only. Nothing has been sent to eToro until etoro_confirm_action is called with this confirmationId.",
      });
    }),
  );

  // ----------------------------------------------------------------- close
  mcp.registerTool(
    "etoro_prepare_close_position",
    {
      title: "Preview closing an eToro position",
      description:
        `Previews closing all or part of an open position in the ${envLabel} account. Get positionId and instrumentId from etoro_get_portfolio_breakdown. ` +
        "Omit unitsToDeduct to close the whole position. Sends nothing to eToro: it returns a confirmationId that etoro_confirm_action executes.",
      inputSchema: {
        positionId: id,
        instrumentId: id,
        unitsToDeduct: z.number().positive().optional().describe("Units to close. Omit to close the entire position."),
      },
      annotations: WRITE("Preview closing an eToro position", { destructive: false, idempotent: true }),
    },
    guarded(async ({ positionId, instrumentId, unitsToDeduct }) => {
      await guard.assertWritable();
      const warnings: string[] = [];
      const breakdown = await bestEffort("Position lookup", warnings, () => client.call(R.portfolioBreakdown(env)));
      const rawPositions = asRecord(asRecord(breakdown).clientPortfolio).positions;
      const positions = Array.isArray(rawPositions) ? rawPositions : [];
      const matched = positions.find((p) => Number(asRecord(p).positionID ?? asRecord(p).positionId) === positionId);
      if (breakdown && !matched) {
        warnings.push(`Position ${positionId} was not found among the open positions of the ${env} account.`);
      }

      const summary =
        `CLOSE position ${positionId} (instrument ${instrumentId}) | ${unitsToDeduct === undefined ? "ENTIRE position" : `${unitsToDeduct} units`} | environment ${envLabel}`;
      // The reference pages spell the body field InstrumentID (demo) and InstrumentId (real).
      const body: Record<string, unknown> = {
        [env === "demo" ? "InstrumentID" : "InstrumentId"]: instrumentId,
        UnitsToDeduct: unitsToDeduct ?? null,
      };
      const action = pending.create({
        tool: "close_position",
        summary,
        exposureUsd: 0,
        run: (requestId) => client.call(R.closePosition(env, positionId), { body, requestId }),
      });
      audit({ event: "prepared", tool: action.tool, confirmationId: action.id, summary });

      return ok({
        confirmationId: action.id,
        expiresAt: new Date(action.expiresAt).toISOString(),
        environment: env,
        summary,
        matchedPosition: matched ?? null,
        warnings,
        status: "Previewed only. Nothing has been sent to eToro until etoro_confirm_action is called with this confirmationId.",
      });
    }),
  );

  // ---------------------------------------------------------------- cancel
  mcp.registerTool(
    "etoro_prepare_cancel_order",
    {
      title: "Preview cancelling an eToro order",
      description:
        `Previews cancelling a pending (not yet executed) order in the ${envLabel} account. Sends nothing to eToro: it returns a confirmationId that etoro_confirm_action executes.`,
      inputSchema: { orderId: id },
      annotations: WRITE("Preview cancelling an eToro order", { destructive: false, idempotent: true }),
    },
    guarded(async ({ orderId }) => {
      await guard.assertWritable();
      const warnings: string[] = [];
      const order = await bestEffort("Order lookup", warnings, () => client.call(R.orderLookup(env), { query: { orderId } }));
      const summary = `CANCEL order ${orderId} | environment ${envLabel}`;
      const action = pending.create({
        tool: "cancel_order",
        summary,
        exposureUsd: 0,
        run: (requestId) => client.call(R.cancelOrder(env, orderId), { requestId }),
      });
      audit({ event: "prepared", tool: action.tool, confirmationId: action.id, summary });
      return ok({
        confirmationId: action.id,
        expiresAt: new Date(action.expiresAt).toISOString(),
        environment: env,
        summary,
        order: order ?? null,
        warnings,
        status: "Previewed only. Nothing has been sent to eToro until etoro_confirm_action is called with this confirmationId.",
      });
    }),
  );

  // -------------------------------------------------------------- transfer
  if (transfersEnabled(cfg)) {
    const accountType = z.enum(["trading", "options", "cash", "moneyFarm"]);
    const accountId = z.union([z.number().int().positive(), z.string().min(1).max(64)]);
    mcp.registerTool(
      "etoro_prepare_transfer",
      {
        title: "Preview an internal eToro transfer",
        description:
          "Previews moving funds between the user's own eToro accounts (for example cash to trading). It is a real money movement: the amount is limited by ETORO_MAX_ORDER_USD. " +
          "Sends nothing to eToro: it returns a confirmationId that etoro_confirm_action executes. Reference: https://api-portal.etoro.com/api-reference/transfer/execute-an-internal-account-to-account-transfer.md.",
        inputSchema: {
          sourceAccountType: accountType,
          sourceAccountId: accountId,
          destinationAccountType: accountType,
          destinationAccountId: accountId,
          amount: z.number().positive(),
          currency: z.string().length(3).optional().describe("ISO 4217 code; must match the source account currency."),
        },
        annotations: WRITE("Preview an internal eToro transfer", { destructive: false, idempotent: true }),
      },
      guarded(async (t) => {
        await guard.assertWritable();
        if (t.amount > cfg.maxOrderUsd) {
          throw new PolicyError(`Transfer amount ${usd(t.amount)} exceeds the cap ETORO_MAX_ORDER_USD (${usd(cfg.maxOrderUsd)}).`);
        }
        const summary =
          `TRANSFER ${usd(t.amount)}${t.currency ? ` ${t.currency}` : ""} from ${t.sourceAccountType} #${t.sourceAccountId} ` +
          `to ${t.destinationAccountType} #${t.destinationAccountId} | environment ${envLabel}`;
        const action = pending.create({
          tool: "transfer",
          summary,
          exposureUsd: t.amount,
          run: (requestId) =>
            client.call(R.transfer(), {
              requestId,
              body: {
                requestReferenceId: requestId,
                sourceAccount: { accountType: t.sourceAccountType, accountId: t.sourceAccountId },
                destinationAccount: { accountType: t.destinationAccountType, accountId: t.destinationAccountId },
                amount: t.amount,
                currency: t.currency,
              },
            }),
        });
        audit({ event: "prepared", tool: action.tool, confirmationId: action.id, summary, exposureUsd: t.amount });
        return ok({
          confirmationId: action.id,
          expiresAt: new Date(action.expiresAt).toISOString(),
          environment: env,
          summary,
          status: "Previewed only. Nothing has been sent to eToro until etoro_confirm_action is called with this confirmationId.",
        });
      }),
    );
  }

  // --------------------------------------------------------------- confirm
  mcp.registerTool(
    "etoro_confirm_action",
    {
      title: "Execute a previewed eToro action",
      description:
        "Executes an order, close, cancel or transfer previously previewed by an etoro_prepare_* tool, identified by its confirmationId. " +
        "Each confirmationId works once and expires (default 5 minutes). When the client supports it, the user is asked directly to approve the exact action. " +
        "eToro replies that the request was accepted for processing; use etoro_get_order to follow an order's status.",
      inputSchema: { confirmationId: z.string().uuid() },
      annotations: WRITE("Execute a previewed eToro action", { destructive: true, idempotent: false }),
    },
    guarded(async ({ confirmationId }) => {
      const action = pending.get(confirmationId);
      if (!action) return fail("Unknown or expired confirmationId. Run the etoro_prepare_* tool again.");
      if (action.executed) return ok(action.result, "This action was already executed; returning the original result.");

      pending.assertWithinLimits(action);

      const decision = await askHuman(mcp, `Confirm eToro ${envLabel} action:\n\n${action.summary}`);
      if (decision === "declined") {
        audit({ event: "declined", tool: action.tool, confirmationId });
        return fail("The user declined the action. Nothing was sent to eToro.");
      }
      if (decision === "unavailable" && cfg.requireElicitation) {
        audit({ event: "blocked_no_elicitation", tool: action.tool, confirmationId });
        return fail(
          "Human confirmation is required (ETORO_REQUIRE_ELICITATION) but this client cannot show a confirmation prompt, so nothing was sent. " +
            "Use a client with MCP elicitation support (for example Claude Code 2.1.76 or newer), or set ETORO_REQUIRE_ELICITATION=false " +
            "if you accept confirming through the conversation alone.",
        );
      }

      try {
        const result = await action.run(action.requestId);
        action.executed = true;
        action.result = result;
        pending.recordExecution(action);
        audit({ event: "executed", tool: action.tool, confirmationId, summary: action.summary, askedHuman: decision === "accepted" });
        return ok(result, `Executed on eToro (${env}): ${action.summary}`);
      } catch (err) {
        audit({ event: "failed", tool: action.tool, confirmationId, error: explain(err).split("\n")[0] });
        throw err;
      }
    }),
  );

  // ------------------------------------------------------------- watchlists
  mcp.registerTool(
    "etoro_create_watchlist",
    {
      title: "Create an eToro watchlist",
      description: "Creates a new watchlist (no money involved). Returns the new watchlist with its id.",
      inputSchema: {
        name: z.string().min(1).max(100),
        type: z.enum(["Static", "Dynamic"]).default("Static"),
      },
      annotations: WRITE("Create an eToro watchlist", { destructive: false, idempotent: false }),
    },
    guarded(async ({ name, type }) => {
      const result = await client.call(R.createWatchlist(), { query: { name, type } });
      audit({ event: "executed", tool: "create_watchlist", name });
      return ok(result);
    }),
  );

  mcp.registerTool(
    "etoro_add_watchlist_items",
    {
      title: "Add instruments to an eToro watchlist",
      description: "Adds instruments (by instrument id) to an existing watchlist. Get watchlist ids from etoro_list_watchlists.",
      inputSchema: { watchlistId: z.string().min(1).max(64), instrumentIds: z.array(id).min(1).max(100) },
      annotations: WRITE("Add instruments to an eToro watchlist", { destructive: false, idempotent: true }),
    },
    guarded(async ({ watchlistId, instrumentIds }) => {
      const body = instrumentIds.map((itemId) => ({ itemId, itemType: "Instrument" }));
      const result = await client.call(R.addWatchlistItems(watchlistId), { body });
      audit({ event: "executed", tool: "add_watchlist_items", watchlistId, count: instrumentIds.length });
      return ok(result);
    }),
  );

  mcp.registerTool(
    "etoro_remove_watchlist_items",
    {
      title: "Remove instruments from an eToro watchlist",
      description: "Removes instruments (by instrument id) from a watchlist. The user is asked to approve when the client supports it.",
      inputSchema: { watchlistId: z.string().min(1).max(64), instrumentIds: z.array(id).min(1).max(100) },
      annotations: WRITE("Remove instruments from an eToro watchlist", { destructive: true, idempotent: true }),
    },
    guarded(async ({ watchlistId, instrumentIds }) => {
      if ((await askHuman(mcp, `Remove ${instrumentIds.length} instrument(s) from watchlist ${watchlistId}?`)) === "declined") {
        return fail("The user declined. Nothing was changed.");
      }
      const body = instrumentIds.map((itemId) => ({ itemId, itemType: "Instrument" }));
      const result = await client.call(R.removeWatchlistItems(watchlistId), { body });
      audit({ event: "executed", tool: "remove_watchlist_items", watchlistId, count: instrumentIds.length });
      return ok(result);
    }),
  );

  mcp.registerTool(
    "etoro_delete_watchlist",
    {
      title: "Delete an eToro watchlist",
      description: "Deletes a watchlist and its items (no money involved, but not reversible). The user is asked to approve when the client supports it.",
      inputSchema: { watchlistId: z.string().min(1).max(64) },
      annotations: WRITE("Delete an eToro watchlist", { destructive: true, idempotent: true }),
    },
    guarded(async ({ watchlistId }) => {
      if ((await askHuman(mcp, `Delete watchlist ${watchlistId}? This cannot be undone.`)) === "declined") {
        return fail("The user declined. Nothing was changed.");
      }
      const result = await client.call(R.deleteWatchlist(watchlistId));
      audit({ event: "executed", tool: "delete_watchlist", watchlistId });
      return ok(result);
    }),
  );
}
