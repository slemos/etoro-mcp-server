import { z } from "zod";
import { R } from "../endpoints.js";
import { InputError } from "../errors.js";
import { asRecord } from "../instruments.js";
import { projectBalanceHistory, summarizeBalanceHistory } from "../investors.js";
import { type ToolContext, READ, guarded, ok } from "./common.js";

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "A date as YYYY-MM-DD.");

/** Reads of the user's own money: cash movements and how the balance evolved. They change nothing. */
export function registerMoneyTools(ctx: ToolContext): void {
  const { mcp, client } = ctx;

  mcp.registerTool(
    "etoro_get_cash_transactions",
    {
      title: "Get eToro cash account transactions",
      description:
        "Movements of one of the user's eToro cash accounts (card payments, bank and internal transfers), newest first, with type, direction, status, amount and currency. " +
        "Needs the cash account's id (see etoro_get_balances, accounts of type Cash). Not environment-specific: it reports the account the key belongs to. " +
        "Follow `pagination.nextPageToken` with `pageToken` for older movements. Read-only.",
      inputSchema: {
        accountId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
        pageSize: z.number().int().min(1).max(100).default(25),
        pageToken: z.string().min(1).max(500).optional(),
      },
      annotations: READ("Get eToro cash account transactions"),
    },
    guarded(async ({ accountId, pageSize, pageToken }) => ok(await client.call(R.cashTransactions(accountId), { query: { pageSize, pageToken } }))),
  );

  mcp.registerTool(
    "etoro_get_balance_history",
    {
      title: "Get eToro balance history",
      description:
        "How the user's total eToro balance evolved day by day between two dates (cash, invested amount, profit and loss, total), in a display currency, with a summary (start, end, change, lowest, highest). " +
        "Not environment-specific: it reports the account the key belongs to. The change in total balance includes deposits and withdrawals, not only gains and losses. " +
        "Defaults to the last 30 days; eToro limits the range. Set includeAccounts for the per-account detail. Read-only.",
      inputSchema: {
        fromDate: day.optional().describe("First day, inclusive. Default: 30 days before toDate."),
        toDate: day.optional().describe("Last day, inclusive. Default: today (UTC)."),
        displayCurrency: z.string().length(3).default("USD").describe("ISO 4217 code used for the totals."),
        accountTypes: z.string().max(100).optional().describe("Comma-separated filter: Trading, Cash, Options, Crypto, MoneyFarm, Spaceship, Plaee."),
        includeSubAccounts: z.boolean().default(false),
        includeAccounts: z.boolean().default(false).describe("Keep each account's own snapshots in the answer."),
      },
      annotations: READ("Get eToro balance history"),
    },
    guarded(async ({ includeAccounts, ...query }) => {
      if (query.fromDate !== undefined && query.toDate !== undefined && query.fromDate > query.toDate) {
        throw new InputError("fromDate must not be later than toDate.");
      }
      const response = asRecord(await client.call(R.balanceHistory(), { query }));
      const points = projectBalanceHistory(response.snapshots);
      return ok({
        displayCurrency: response.displayCurrency ?? query.displayCurrency,
        fromDate: response.fromDate,
        toDate: response.toDate,
        summary: summarizeBalanceHistory(points) ?? null,
        snapshots: points,
        ...(includeAccounts ? { accounts: (Array.isArray(response.snapshots) ? response.snapshots : []).map((s) => ({ date: asRecord(s).date, accountSnapshots: asRecord(s).accountSnapshots })) } : {}),
      });
    }),
  );
}
