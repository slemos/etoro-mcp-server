import { z } from "zod";
import { InputError } from "../errors.js";
import { parseHistoryQuery, STATUSES } from "../history/query.js";
import { formatClock } from "../history/time.js";
import { type ToolContext, guarded, ok, READ } from "./common.js";

const iso = (ms: number) => new Date(ms).toISOString();

/** Tools over the local action history (SQLite). They read and show it; nothing here can change or delete it. */
export function registerHistoryTools(ctx: ToolContext): void {
  const { mcp, cfg, store, tickets } = ctx;
  const db = store.db;

  mcp.registerTool(
    "etoro_get_action_history",
    {
      title: "Search the history of eToro actions",
      description:
        "Searches the local history of actions this server prepared and the user executed, rejected or let expire (persisted in a SQLite file, so it survives restarts and covers other sessions). " +
        "Newest first. Free-text `query` matches the summary, the action name and ids (order, position, instrument, action). Also returns today's executed total against the daily limits. " +
        "To let the user browse and search it themselves, call etoro_open_history instead.",
      inputSchema: {
        query: z.string().max(200).optional().describe("Words to look for, for example a ticker or an order id. All words must match."),
        environment: z.enum(["demo", "real"]).optional().describe("Only this environment. Default: both."),
        action: z.string().regex(/^[a-z_]{1,64}$/).optional().describe("Action name, for example open_position, close_position, modify_position, cancel_order."),
        status: z.enum(STATUSES as [string, ...string[]]).optional(),
        from: z.string().optional().describe(`First day, YYYY-MM-DD (${cfg.timezone} time).`),
        to: z.string().optional().describe("Last day (included), YYYY-MM-DD."),
        limit: z.number().int().min(1).max(100).default(20),
        offset: z.number().int().min(0).default(0),
      },
      annotations: { ...READ("Search the history of eToro actions"), openWorldHint: false },
    },
    guarded(async (a) => {
      const parsed = parseHistoryQuery({ q: a.query, env: a.environment, tool: a.action, status: a.status, from: a.from, to: a.to, limit: a.limit, offset: a.offset }, cfg.timezone);
      if (parsed.problems.length > 0) throw new InputError(parsed.problems.join(" "));
      const { total, rows } = db.search(parsed.filter);
      const usage = db.usage(cfg.env, Date.now(), cfg.timezone);
      return ok({
        total,
        returned: rows.length,
        ...(total > a.offset + rows.length ? { nextOffset: a.offset + rows.length } : {}),
        persistent: db.persistent,
        timeZone: cfg.timezone,
        today: {
          environment: cfg.env,
          day: usage.day,
          executedUsd: Number(usage.usd.toFixed(2)),
          executedWrites: usage.writes,
          maxDailyUsd: cfg.maxDailyUsd,
          maxDailyWrites: cfg.maxDailyWrites,
        },
        actions: rows.map((r) => ({
          actionId: r.id,
          time: formatClock(r.createdAt, cfg.timezone),
          at: iso(r.createdAt),
          environment: r.env,
          action: r.tool,
          status: r.status,
          summary: r.summary,
          ...(r.exposureUsd > 0 ? { exposureUsd: r.exposureUsd } : {}),
          ...(r.orderId !== undefined ? { orderId: r.orderId } : {}),
          ...(r.positionId !== undefined ? { positionId: r.positionId } : {}),
          ...(r.instrumentId !== undefined ? { instrumentId: r.instrumentId } : {}),
          ...(r.error ? { error: r.error } : {}),
        })),
      });
    }),
  );

  mcp.registerTool(
    "etoro_open_history",
    {
      title: "Open the eToro action history in the browser",
      description:
        "Opens a local page in the user's browser where they can search and filter the history of actions (by text, date, environment, action and status), open the detail of each one, see today's usage against the daily limits and download a CSV. " +
        "The page is read-only, listens on 127.0.0.1 only and its secret address expires after an hour. It returns nothing from the history: use etoro_get_action_history to read it yourself.",
      inputSchema: {},
      annotations: { title: "Open the eToro action history", readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    guarded(async () => {
      const { opened, url } = await tickets.openHistory(cfg.openBrowser);
      return ok({
        opened,
        note: opened
          ? "The history page is open in the user's browser."
          : cfg.openBrowser
            ? "Could not open a browser. The address was written to the server's log (stderr)."
            : "ETORO_OPEN_BROWSER is off, so no browser was opened. The address was written to the server's log (stderr).",
        persistent: db.persistent,
        ...(cfg.showApprovalUrl ? { url } : {}),
      });
    }),
  );
}
