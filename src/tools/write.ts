import { z } from "zod";
import type { Proposal, ProposalRow } from "../approval/proposals.js";
import { transfersEnabled } from "../config.js";
import { R } from "../endpoints.js";
import { asRecord, lookupInstruments, resolveInstrument } from "../instruments.js";
import { InputError, PolicyError } from "../errors.js";
import { estimateClose } from "../closeEstimate.js";
import { offeredSettlements, requiresW8Ben, settlementOf } from "../settlement.js";
import { type ToolContext, WRITE, extractList, guarded, ok, explain } from "./common.js";

const id = z.number().int().positive();

async function bestEffort<T>(label: string, warnings: string[], fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    warnings.push(`${label} unavailable: ${explain(err).split("\n")[0]}`);
    return undefined;
  }
}

const usd = (n: number): string => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** "markup: 0 USD; marketSpread: 0.02 USD" from eToro's what-if cost answer, or undefined when it has another shape. */
function costsLine(costs: unknown): string | undefined {
  const list = asRecord(costs).costs;
  if (!Array.isArray(list) || list.length === 0) return undefined;
  return list
    .map((c) => {
      const r = asRecord(c);
      return `${String(r.costType ?? "cost")}: ${String(r.value ?? r.amount ?? "?")} ${String(r.currency ?? "")}`.trim();
    })
    .join("; ");
}

const APPROVAL_NOTE =
  "Previewed only: nothing has been sent to eToro. You cannot execute this action: the user must press Execute on the approval page " +
  "(opened in their browser when possible). Follow the outcome with etoro_get_action_status.";

/** Registers the approval page for a proposal, opens it, and builds the part of the tool result every prepare tool shares. */
async function announce(ctx: ToolContext, proposal: Proposal): Promise<Record<string, unknown>> {
  const pageOpened = await ctx.tickets.open(proposal, ctx.cfg.openBrowser);
  const url = ctx.cfg.showApprovalUrl ? await ctx.tickets.urlFor(proposal) : undefined;
  const reachable = pageOpened || url !== undefined;
  return {
    actionId: proposal.id,
    expiresAt: new Date(proposal.expiresAt).toISOString(),
    environment: proposal.env,
    summary: proposal.summary,
    approval: { status: "awaiting_user", pageOpened, ...(url ? { url } : {}) },
    note: reachable
      ? APPROVAL_NOTE
      : `${APPROVAL_NOTE} The page could not be opened automatically: its address is in the server's log (stderr). ETORO_SHOW_APPROVAL_URL=true puts it in this result, which also lets the model see it.`,
  };
}

const row = (label: string, value: string): ProposalRow => ({ label, value });

export function registerWriteTools(ctx: ToolContext): void {
  const { mcp, cfg, client, store, guard } = ctx;
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
        "Sends nothing to eToro: it registers the action and opens an approval page where the user, and only the user, can execute it; it returns an actionId. " +
        "settlementType 'real' buys the actual asset, 'cfd' opens a contract for difference; the preview rejects a type the account is not offered for that instrument " +
        "(some jurisdictions only get CFDs). Some stocks have a separate regular-hours instrument (symbol ending in .RTH) next to the 24/5 one: pass the exact symbol or instrumentId. Leverage above 1, short selling and trailing stops require stopLossRate. " +
        "Order reference: https://api-portal.etoro.com/core/guides/market-orders.md.",
      inputSchema: {
        symbol: z.string().min(1).max(30).optional().describe("Exact ticker, e.g. 'EXMPL.L'. Provide symbol or instrumentId."),
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
      const instrument = await resolveInstrument(ctx.client, a.symbol, a.instrumentId);
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
      if (requiresW8Ben(eligibility, instrument.instrumentId) === true) {
        warnings.push(
          "eToro says a W-8BEN tax form is required to trade this instrument. If it is not on file or has expired, the order can be rejected. This is eToro's own flag: it is not tax advice.",
        );
      }
      if (a.leverage >= 5) {
        warnings.push(
          `Leverage ${a.leverage}x: a move of about ${(100 / a.leverage).toFixed(1)}% against the position uses up the whole amount, so the loss can reach 100% of what you put in (eToro may close it earlier).`,
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
      const settlementText = a.settlementType ?? (onlyOffered ? `${onlyOffered} (the only one offered)` : "default settlement");
      const summary =
        `OPEN ${a.side === "buy" ? "BUY" : "SHORT"} ${instrument.symbol} (id ${instrument.instrumentId}${instrument.displayName ? `, ${instrument.displayName}` : ""}) ` +
        `| ${size} | ${a.leverage}x | ${settlementText} | ${a.orderType} order` +
        `${a.stopLossRate !== undefined ? ` | stop loss ${a.stopLossRate} (${a.stopLossType})` : " | no stop loss"}` +
        `${a.takeProfitRate !== undefined ? ` | take profit ${a.takeProfitRate}` : ""}` +
        ` | environment ${envLabel}`;
      const rows = [
        row("Action", a.side === "buy" ? "Buy (open a long position)" : "Sell short (open a short position)"),
        row("Instrument", `${instrument.symbol} (id ${instrument.instrumentId})${instrument.displayName ? `, ${instrument.displayName}` : ""}`),
        row("Size", size),
        row("Leverage", `${a.leverage}x`),
        row("Settlement", settlementText),
        row("Order type", a.orderType),
        ...(a.triggerRate !== undefined ? [row("Trigger rate", String(a.triggerRate))] : []),
        ...(a.limitRate !== undefined ? [row("Limit rate", String(a.limitRate))] : []),
        row("Stop loss", a.stopLossRate !== undefined ? `${a.stopLossRate} (${a.stopLossType})` : "none"),
        row("Take profit", a.takeProfitRate !== undefined ? String(a.takeProfitRate) : "none"),
        row("Exposure", `${usd(exposure)} (amount x leverage)`),
        ...(Number.isFinite(ask) ? [row("Ask price", String(rate.ask))] : []),
        ...(costsLine(costs) ? [row("Estimated costs", costsLine(costs)!)] : []),
      ];

      const proposal = store.create({
        tool: "open_position",
        summary,
        rows,
        warnings,
        exposureUsd: exposure,
        refs: { instrumentId: instrument.instrumentId },
        run: ({ requestId, grant }) => client.call(R.createOrder(env), { body, requestId, grant }),
      });

      return ok({
        ...(await announce(ctx, proposal)),
        instrument,
        estimatedExposureUsd: Number(exposure.toFixed(2)),
        marketRate: Number.isFinite(ask) ? { bid: rate.bid, ask: rate.ask } : null,
        settlement: { requested: a.settlementType ?? null, offered: offered.known ? offered.settlements : null },
        eligibility,
        estimatedCosts: costs,
        warnings,
      });
    }),
  );

  // ----------------------------------------------------------------- close
  mcp.registerTool(
    "etoro_prepare_close_position",
    {
      title: "Preview closing an eToro position",
      description:
        `Previews closing all or part of an open position in the ${envLabel} account. Get positionId from etoro_get_portfolio_breakdown; instrumentId is taken from the open position when omitted. ` +
        "Omit unitsToDeduct to close the whole position. The preview shows the instrument, direction, current price and a rough estimate of the profit or loss at that price, and refuses to close more units than are open. " +
        "Sends nothing to eToro: it registers the action and opens an approval page where the user, and only the user, can execute it; it returns an actionId.",
      inputSchema: {
        positionId: id,
        instrumentId: id.optional().describe("Optional: read from the open position. If given, it must match the position's instrument."),
        unitsToDeduct: z.number().positive().optional().describe("Units to close. Omit to close the entire position."),
      },
      annotations: WRITE("Preview closing an eToro position", { destructive: false, idempotent: true }),
    },
    guarded(async ({ positionId, instrumentId: givenInstrumentId, unitsToDeduct }) => {
      await guard.assertWritable();
      const warnings: string[] = [];
      const breakdown = await bestEffort("Position lookup", warnings, () => client.call(R.portfolioBreakdown(env)));
      const rawPositions = asRecord(asRecord(breakdown).clientPortfolio).positions;
      const positions = Array.isArray(rawPositions) ? rawPositions : [];
      const matched = positions.find((p) => Number(asRecord(p).positionID ?? asRecord(p).positionId) === positionId);
      const open = asRecord(matched);
      if (breakdown && !matched) {
        warnings.push(`Position ${positionId} was not found among the open positions of the ${env} account.`);
      }

      const positionInstrument = Number(open.instrumentID ?? open.instrumentId);
      const instrumentId = givenInstrumentId ?? (Number.isInteger(positionInstrument) && positionInstrument > 0 ? positionInstrument : undefined);
      if (instrumentId === undefined) {
        throw new InputError("Could not read the position's instrument. Pass instrumentId (see etoro_get_portfolio_breakdown).");
      }
      if (matched && Number.isInteger(positionInstrument) && positionInstrument > 0 && givenInstrumentId !== undefined && givenInstrumentId !== positionInstrument) {
        throw new InputError(`Position ${positionId} is on instrument ${positionInstrument}, not ${givenInstrumentId}. Nothing was prepared.`);
      }
      const openUnits = Number(open.units);
      if (matched && Number.isFinite(openUnits) && unitsToDeduct !== undefined && unitsToDeduct > openUnits * (1 + 1e-9)) {
        throw new InputError(`Position ${positionId} has ${openUnits} units open; ${unitsToDeduct} cannot be closed. Omit unitsToDeduct to close it all.`);
      }

      const instrument = (await bestEffort("Instrument lookup", warnings, () => lookupInstruments(client, [instrumentId])))?.get(instrumentId);
      const rates = await bestEffort("Market rate", warnings, () => client.call(R.rates(), { query: { instrumentIds: [instrumentId] } }));
      const rate = asRecord(extractList(rates, ["rates"])[0]);
      const bid = Number(rate.bid);
      const ask = Number(rate.ask);
      const isBuy = typeof open.isBuy === "boolean" ? open.isBuy : undefined;
      const estimate =
        matched && isBuy !== undefined
          ? estimateClose({ isBuy, units: openUnits, openRate: Number(open.openRate), closeUnits: unitsToDeduct, bid, ask, amount: Number(open.amount) })
          : undefined;
      const settlement = settlementOf(open.settlementTypeID);
      const mirrorId = Number(open.mirrorID);
      if (Number.isFinite(mirrorId) && mirrorId > 0) {
        warnings.push(`This position belongs to a copy trade (mirror ${mirrorId}). Closing it by hand is a separate action from the copy, and eToro may refuse it.`);
      }
      if (instrument?.symbol.toUpperCase().endsWith(".RTH")) {
        warnings.push("This is a regular-trading-hours instrument (.RTH): outside those hours the close waits for the market to open.");
      }
      if (estimate && estimate.remainingUnits > 0) {
        warnings.push(`A partial close: ${estimate.remainingUnits} units stay open (stop loss and take profit are kept by eToro).`);
      }

      const label = instrument ? `${instrument.symbol}, id ${instrument.instrumentId}` : `instrument ${instrumentId}`;
      const closing = unitsToDeduct === undefined ? "ENTIRE position" : `${unitsToDeduct} units`;
      const money = (n: number) => `${n < 0 ? "-" : ""}${usd(Math.abs(n))}`;
      const summary =
        `CLOSE position ${positionId} (${label}) | ${closing}` +
        `${estimate ? ` | est. ${estimate.pnl >= 0 ? "gain" : "loss"} ${money(estimate.pnl)}` : ""} | environment ${envLabel}`;
      // The reference pages spell the body field InstrumentID (demo) and InstrumentId (real).
      const body: Record<string, unknown> = {
        [env === "demo" ? "InstrumentID" : "InstrumentId"]: instrumentId,
        UnitsToDeduct: unitsToDeduct ?? null,
      };
      const rows = [
        row("Action", "Close a position"),
        row("Position id", String(positionId)),
        row("Instrument", instrument ? `${instrument.symbol}${instrument.displayName ? `, ${instrument.displayName}` : ""} (id ${instrument.instrumentId})` : `id ${instrumentId}`),
        ...(isBuy !== undefined ? [row("Direction", isBuy ? "Long (buy)" : "Short (sell)")] : []),
        ...(settlement ? [row("Settlement", settlement === "cfd" ? "CFD (a contract on the price)" : "Real asset")] : []),
        row("Close", unitsToDeduct === undefined ? "The entire position" : `${unitsToDeduct} units`),
        ...(matched
          ? [
              row("Open position", `${String(open.units ?? "?")} units, opened at ${String(open.openRate ?? "?")}, amount ${String(open.amount ?? "?")}, leverage ${String(open.leverage ?? "?")}x`),
            ]
          : []),
        ...(Number.isFinite(bid) && Number.isFinite(ask) ? [row("Current price", `bid ${bid} / ask ${ask}`)] : []),
        ...(estimate
          ? [
              row("Closing price (estimate)", `${estimate.closeRate} (a ${isBuy ? "long closes at the bid" : "short closes at the ask"})`),
              row("Estimated result", `${money(estimate.pnl)}${estimate.pnlPercent !== undefined ? ` (${estimate.pnlPercent >= 0 ? "+" : ""}${estimate.pnlPercent.toFixed(2)}% of the amount closed)` : ""}: price move × units, before fees, overnight costs and currency conversion`),
              ...(estimate.remainingUnits > 0 ? [row("Left open afterwards", `${estimate.remainingUnits} units`)] : []),
            ]
          : []),
      ];
      const proposal = store.create({
        tool: "close_position",
        summary,
        rows,
        warnings,
        exposureUsd: 0,
        refs: { positionId, instrumentId },
        run: ({ requestId, grant }) => client.call(R.closePosition(env, positionId), { body, requestId, grant }),
      });
      return ok({
        ...(await announce(ctx, proposal)),
        instrument: instrument ?? null,
        estimate: estimate ?? null,
        matchedPosition: matched ?? null,
        warnings,
      });
    }),
  );

  // ---------------------------------------------------------------- modify
  mcp.registerTool(
    "etoro_prepare_modify_position",
    {
      title: "Preview changing the stop loss or take profit of an eToro position",
      description:
        `Previews changing the stop loss and/or take profit of an open position in the ${envLabel} account: new rates, trailing or fixed stop, or removing either. ` +
        "Get positionId from etoro_get_portfolio_breakdown. Rates are prices of the instrument, not percentages. The preview compares them with the position's direction and the current price. " +
        "eToro may move funds from the balance into the position's margin when a stop loss is deeper than its allowed maximum. " +
        "Sends nothing to eToro: it registers the action and opens an approval page where the user, and only the user, can execute it; it returns an actionId.",
      inputSchema: {
        positionId: id,
        stopLossRate: z.number().positive().optional().describe("New stop loss price."),
        stopLossType: z.enum(["fixed", "trailing"]).optional().describe("'trailing' makes the stop follow the price up (long positions)."),
        clearStopLoss: z.boolean().optional().describe("Remove the stop loss, where eToro allows it (not for leveraged positions)."),
        takeProfitRate: z.number().positive().optional().describe("New take profit price."),
        clearTakeProfit: z.boolean().optional().describe("Remove the take profit."),
      },
      annotations: WRITE("Preview changing the stop loss or take profit of an eToro position", { destructive: false, idempotent: true }),
    },
    guarded(async (a) => {
      await guard.assertWritable();
      if (a.stopLossRate === undefined && a.takeProfitRate === undefined && a.stopLossType === undefined && !a.clearStopLoss && !a.clearTakeProfit) {
        throw new InputError("Provide at least one of stopLossRate, takeProfitRate, stopLossType, clearStopLoss or clearTakeProfit.");
      }
      if (a.clearStopLoss && (a.stopLossRate !== undefined || a.stopLossType !== undefined)) {
        throw new InputError("clearStopLoss cannot be combined with stopLossRate or stopLossType.");
      }
      if (a.clearTakeProfit && a.takeProfitRate !== undefined) {
        throw new InputError("clearTakeProfit cannot be combined with takeProfitRate.");
      }

      const warnings: string[] = [];
      const breakdown = await bestEffort("Position lookup", warnings, () => client.call(R.portfolioBreakdown(env)));
      const rawPositions = asRecord(asRecord(breakdown).clientPortfolio).positions;
      const matched = (Array.isArray(rawPositions) ? rawPositions : []).find(
        (p) => Number(asRecord(p).positionID ?? asRecord(p).positionId) === a.positionId,
      );
      if (breakdown && !matched) {
        throw new InputError(`Position ${a.positionId} was not found among the open positions of the ${env} account. Check the id with etoro_get_portfolio_breakdown.`);
      }
      const pos = asRecord(matched);
      const isBuy = typeof pos.isBuy === "boolean" ? pos.isBuy : undefined;
      const instrumentId = Number(pos.instrumentID ?? pos.instrumentId);
      const instrument = Number.isInteger(instrumentId) ? (await lookupInstruments(client, [instrumentId])).get(instrumentId) : undefined;
      const rates = Number.isInteger(instrumentId)
        ? await bestEffort("Market rate", warnings, () => client.call(R.rates(), { query: { instrumentIds: [instrumentId] } }))
        : undefined;
      const rate = asRecord(extractList(rates, ["rates"])[0]);
      const bid = Number(rate.bid);
      const ask = Number(rate.ask);

      // A stop on the wrong side of the market would trigger at once; say so (eToro's own validation still applies).
      if (isBuy !== undefined && Number.isFinite(bid) && Number.isFinite(ask)) {
        if (a.stopLossRate !== undefined && (isBuy ? a.stopLossRate >= bid : a.stopLossRate <= ask)) {
          warnings.push(`The new stop loss ${a.stopLossRate} is on the wrong side of the current price (bid ${bid}, ask ${ask}) for a ${isBuy ? "long" : "short"} position, so it would trigger immediately.`);
        }
        if (a.takeProfitRate !== undefined && (isBuy ? a.takeProfitRate <= bid : a.takeProfitRate >= ask)) {
          warnings.push(`The new take profit ${a.takeProfitRate} is on the wrong side of the current price (bid ${bid}, ask ${ask}) for a ${isBuy ? "long" : "short"} position, so it would trigger immediately.`);
        }
      }
      if (a.stopLossRate !== undefined) {
        warnings.push("If this stop loss is deeper than eToro's allowed maximum, eToro moves funds from your balance into the position's margin.");
      }

      const body: Record<string, unknown> = {};
      if (a.stopLossRate !== undefined) body.stopLossRate = a.stopLossRate;
      if (a.stopLossType !== undefined) body.stopLossType = a.stopLossType;
      if (a.clearStopLoss) body.clearStopLoss = true;
      if (a.takeProfitRate !== undefined) body.takeProfitRate = a.takeProfitRate;
      if (a.clearTakeProfit) body.clearTakeProfit = true;

      const stopText = a.clearStopLoss
        ? "remove"
        : a.stopLossRate !== undefined
          ? `${a.stopLossRate}${a.stopLossType ? ` (${a.stopLossType})` : ""}`
          : a.stopLossType !== undefined
            ? `keep the rate, make it ${a.stopLossType}`
            : "unchanged";
      const profitText = a.clearTakeProfit ? "remove" : a.takeProfitRate !== undefined ? String(a.takeProfitRate) : "unchanged";
      const label = instrument ? `${instrument.symbol} (id ${instrument.instrumentId})` : Number.isInteger(instrumentId) ? `instrument ${instrumentId}` : "unknown instrument";
      const summary = `MODIFY position ${a.positionId} (${label}) | stop loss: ${stopText} | take profit: ${profitText} | environment ${envLabel}`;
      const current = (rateName: string, flag: string) => (pos[flag] === true ? "none" : pos[rateName] !== undefined ? String(pos[rateName]) : "unknown");
      const rows = [
        row("Action", "Change the stop loss / take profit of an open position"),
        row("Position id", String(a.positionId)),
        row("Instrument", label + (instrument?.displayName ? `, ${instrument.displayName}` : "")),
        ...(isBuy !== undefined ? [row("Direction", isBuy ? "Long (buy)" : "Short (sell)")] : []),
        ...(matched ? [row("Open position", `${String(pos.units ?? "?")} units, opened at ${String(pos.openRate ?? "?")}, leverage ${String(pos.leverage ?? "?")}x`)] : []),
        ...(Number.isFinite(bid) && Number.isFinite(ask) ? [row("Current price", `bid ${bid} / ask ${ask}`)] : []),
        ...(matched ? [row("Current stop loss", current("stopLossRate", "isNoStopLoss")), row("Current take profit", current("takeProfitRate", "isNoTakeProfit"))] : []),
        row("New stop loss", stopText),
        row("New take profit", profitText),
      ];
      const proposal = store.create({
        tool: "modify_position",
        summary,
        rows,
        warnings,
        exposureUsd: 0,
        refs: { positionId: a.positionId, ...(Number.isInteger(instrumentId) ? { instrumentId } : {}) },
        run: ({ requestId, grant }) => client.call(R.modifyPosition(env, a.positionId), { body, requestId, grant }),
      });
      return ok({ ...(await announce(ctx, proposal)), matchedPosition: matched ?? null, request: body, warnings });
    }),
  );

  // ---------------------------------------------------------------- cancel
  mcp.registerTool(
    "etoro_prepare_cancel_order",
    {
      title: "Preview cancelling an eToro order",
      description:
        `Previews cancelling a pending (not yet executed) order in the ${envLabel} account. To cancel a pending CLOSE order, use etoro_prepare_cancel_close_order. Sends nothing to eToro: it registers the action and opens an approval page where the user, and only the user, can execute it; it returns an actionId.`,
      inputSchema: { orderId: id },
      annotations: WRITE("Preview cancelling an eToro order", { destructive: false, idempotent: true }),
    },
    guarded(async ({ orderId }) => {
      await guard.assertWritable();
      const warnings: string[] = [];
      const order = await bestEffort("Order lookup", warnings, () => client.call(R.orderLookup(env), { query: { orderId } }));
      const summary = `CANCEL order ${orderId} | environment ${envLabel}`;
      const status = asRecord(asRecord(order).status);
      const proposal = store.create({
        tool: "cancel_order",
        summary,
        rows: [row("Action", "Cancel a pending order"), row("Order id", String(orderId)), ...(status.name ? [row("Current status", String(status.name))] : [])],
        warnings,
        exposureUsd: 0,
        refs: { orderId },
        run: ({ requestId, grant }) => client.call(R.cancelOrder(env, orderId), { requestId, grant }),
      });
      return ok({ ...(await announce(ctx, proposal)), order: order ?? null, warnings });
    }),
  );

  // ---------------------------------------------------------- cancel close
  mcp.registerTool(
    "etoro_prepare_cancel_close_order",
    {
      title: "Preview cancelling a pending close order",
      description:
        `Previews cancelling a pending close order (a request to close a position that has not executed yet, for example one waiting for the market to open) in the ${envLabel} account. ` +
        "The position stays open. Use the orderId that came back when the close was executed (see etoro_get_action_status); for other pending orders use etoro_prepare_cancel_order. " +
        "Sends nothing to eToro: it registers the action and opens an approval page where the user, and only the user, can execute it; it returns an actionId. eToro's 200 only confirms the request was received: check the order afterwards with etoro_get_order.",
      inputSchema: { orderId: id },
      annotations: WRITE("Preview cancelling a pending close order", { destructive: false, idempotent: true }),
    },
    guarded(async ({ orderId }) => {
      await guard.assertWritable();
      const warnings: string[] = [];
      const order = await bestEffort("Order lookup", warnings, () => client.call(R.orderLookup(env), { query: { orderId } }));
      const status = asRecord(asRecord(order).status);
      if (typeof status.name === "string" && /filled|cancel|reject/i.test(status.name)) {
        warnings.push(`The order's current status is ${status.name}: there may be nothing left to cancel.`);
      }
      const summary = `CANCEL CLOSE order ${orderId} | the position stays open | environment ${envLabel}`;
      const proposal = store.create({
        tool: "cancel_close_order",
        summary,
        rows: [row("Action", "Cancel a pending close order"), row("Order id", String(orderId)), ...(status.name ? [row("Current status", String(status.name))] : []), row("Effect", "The position stays open")],
        warnings,
        exposureUsd: 0,
        refs: { orderId },
        run: ({ requestId, grant }) => client.call(R.cancelCloseOrder(env, orderId), { requestId, grant }),
      });
      return ok({ ...(await announce(ctx, proposal)), order: order ?? null, warnings });
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
          "Sends nothing to eToro: it registers the action and opens an approval page where the user, and only the user, can execute it; it returns an actionId. Reference: https://api-portal.etoro.com/api-reference/transfer/execute-an-internal-account-to-account-transfer.md.",
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
        const proposal = store.create({
          tool: "transfer",
          summary,
          rows: [
            row("Action", "Move funds between your own eToro accounts"),
            row("From", `${t.sourceAccountType} #${t.sourceAccountId}`),
            row("To", `${t.destinationAccountType} #${t.destinationAccountId}`),
            row("Amount", `${usd(t.amount)}${t.currency ? ` ${t.currency}` : ""}`),
          ],
          exposureUsd: t.amount,
          run: ({ requestId, grant }) =>
            client.call(R.transfer(), {
              requestId,
              grant,
              body: {
                requestReferenceId: requestId,
                sourceAccount: { accountType: t.sourceAccountType, accountId: t.sourceAccountId },
                destinationAccount: { accountType: t.destinationAccountType, accountId: t.destinationAccountId },
                amount: t.amount,
                currency: t.currency,
              },
            }),
        });
        return ok(await announce(ctx, proposal));
      }),
    );
  }

  // ------------------------------------------------------------- watchlists
  // No money moves, but they change the account, so they follow the same rule: Claude proposes, the user executes.
  const names = async (instrumentIds: number[]): Promise<string> => {
    const found = await lookupInstruments(client, instrumentIds);
    return instrumentIds.map((n) => (found.get(n) ? `${found.get(n)!.symbol} (id ${n})` : `id ${n}`)).join(", ");
  };

  mcp.registerTool(
    "etoro_prepare_create_watchlist",
    {
      title: "Preview creating an eToro watchlist",
      description:
        "Previews creating a watchlist (no money involved). Sends nothing to eToro: it registers the action and opens an approval page where the user, and only the user, can execute it; it returns an actionId.",
      inputSchema: {
        name: z.string().min(1).max(100),
        type: z.enum(["Static", "Dynamic"]).default("Static"),
      },
      annotations: WRITE("Preview creating an eToro watchlist", { destructive: false, idempotent: true }),
    },
    guarded(async ({ name, type }) => {
      const proposal = store.create({
        tool: "create_watchlist",
        summary: `CREATE watchlist "${name}" (${type}) | environment ${envLabel}`,
        rows: [row("Action", "Create a watchlist"), row("Name", name), row("Type", type)],
        exposureUsd: 0,
        run: ({ requestId, grant }) => client.call(R.createWatchlist(), { query: { name, type }, requestId, grant }),
      });
      return ok(await announce(ctx, proposal));
    }),
  );

  mcp.registerTool(
    "etoro_prepare_add_watchlist_items",
    {
      title: "Preview adding instruments to an eToro watchlist",
      description:
        "Previews adding instruments (by instrument id) to an existing watchlist. Get watchlist ids from etoro_list_watchlists. Sends nothing to eToro: it registers the action and opens an approval page where the user, and only the user, can execute it; it returns an actionId.",
      inputSchema: { watchlistId: z.string().min(1).max(64), instrumentIds: z.array(id).min(1).max(100) },
      annotations: WRITE("Preview adding instruments to an eToro watchlist", { destructive: false, idempotent: true }),
    },
    guarded(async ({ watchlistId, instrumentIds }) => {
      const body = instrumentIds.map((itemId) => ({ itemId, itemType: "Instrument" }));
      const proposal = store.create({
        tool: "add_watchlist_items",
        summary: `ADD ${instrumentIds.length} instrument(s) to watchlist ${watchlistId} | environment ${envLabel}`,
        rows: [row("Action", "Add instruments to a watchlist"), row("Watchlist id", watchlistId), row("Instruments", await names(instrumentIds))],
        exposureUsd: 0,
        run: ({ requestId, grant }) => client.call(R.addWatchlistItems(watchlistId), { body, requestId, grant }),
      });
      return ok(await announce(ctx, proposal));
    }),
  );

  mcp.registerTool(
    "etoro_prepare_remove_watchlist_items",
    {
      title: "Preview removing instruments from an eToro watchlist",
      description:
        "Previews removing instruments (by instrument id) from a watchlist. Sends nothing to eToro: it registers the action and opens an approval page where the user, and only the user, can execute it; it returns an actionId.",
      inputSchema: { watchlistId: z.string().min(1).max(64), instrumentIds: z.array(id).min(1).max(100) },
      annotations: WRITE("Preview removing instruments from an eToro watchlist", { destructive: false, idempotent: true }),
    },
    guarded(async ({ watchlistId, instrumentIds }) => {
      const body = instrumentIds.map((itemId) => ({ itemId, itemType: "Instrument" }));
      const proposal = store.create({
        tool: "remove_watchlist_items",
        summary: `REMOVE ${instrumentIds.length} instrument(s) from watchlist ${watchlistId} | environment ${envLabel}`,
        rows: [row("Action", "Remove instruments from a watchlist"), row("Watchlist id", watchlistId), row("Instruments", await names(instrumentIds))],
        exposureUsd: 0,
        run: ({ requestId, grant }) => client.call(R.removeWatchlistItems(watchlistId), { body, requestId, grant }),
      });
      return ok(await announce(ctx, proposal));
    }),
  );

  mcp.registerTool(
    "etoro_prepare_delete_watchlist",
    {
      title: "Preview deleting an eToro watchlist",
      description:
        "Previews deleting a watchlist and its items (no money involved, but not reversible). Sends nothing to eToro: it registers the action and opens an approval page where the user, and only the user, can execute it; it returns an actionId.",
      inputSchema: { watchlistId: z.string().min(1).max(64) },
      annotations: WRITE("Preview deleting an eToro watchlist", { destructive: false, idempotent: true }),
    },
    guarded(async ({ watchlistId }) => {
      const proposal = store.create({
        tool: "delete_watchlist",
        summary: `DELETE watchlist ${watchlistId} | environment ${envLabel}`,
        rows: [row("Action", "Delete a watchlist and its items (cannot be undone)"), row("Watchlist id", watchlistId)],
        exposureUsd: 0,
        run: ({ requestId, grant }) => client.call(R.deleteWatchlist(watchlistId), { requestId, grant }),
      });
      return ok(await announce(ctx, proposal));
    }),
  );
}
