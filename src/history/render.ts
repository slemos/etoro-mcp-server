import type { EtoroEnv } from "../config.js";
import { escapeHtml, page } from "../approval/render.js";
import type { ActionRecord, ActionSummary, EventRecord, HistoryFilter, Usage } from "./db.js";
import { PAGE_SIZE, STATUSES } from "./query.js";
import { formatClock } from "./time.js";


export interface HistoryView {
  /** Address prefix of this page, e.g. /h/<token>. */
  base: string;
  timezone: string;
  env: EtoroEnv;
  filter: HistoryFilter;
  /** The filter as the user typed it, to refill the form (dates as YYYY-MM-DD). */
  form: { q: string; env: string; tool: string; status: string; from: string; to: string };
  total: number;
  rows: ActionSummary[];
  tools: string[];
  today: Array<{ env: EtoroEnv; usage: Usage }>;
  maxDailyUsd: number;
  maxDailyWrites: number;
  persistent: boolean;
  /** Set when a query parameter was ignored because it was not valid. */
  notice?: string;
}

const usd = (n: number) => `$${n.toFixed(2)}`;

function ids(a: ActionSummary): string {
  return [a.orderId !== undefined ? `order ${a.orderId}` : "", a.positionId !== undefined ? `position ${a.positionId}` : "", a.instrumentId !== undefined ? `instrument ${a.instrumentId}` : ""]
    .filter(Boolean)
    .join(", ");
}

function options(values: string[], selected: string, any: string): string {
  return [`<option value="">${escapeHtml(any)}</option>`, ...values.map((v) => `<option value="${escapeHtml(v)}"${v === selected ? " selected" : ""}>${escapeHtml(v)}</option>`)].join("");
}

/** Query string of the current filter (without paging), for the paging and export links. */
export function filterQuery(form: HistoryView["form"]): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(form)) if (v) p.set(k, v);
  return p.toString();
}

export function renderHistory(v: HistoryView): string {
  const offset = Math.max(v.filter.offset ?? 0, 0);
  const qs = filterQuery(v.form);
  const link = (extra: string) => `${escapeHtml(v.base)}?${escapeHtml([qs, extra].filter(Boolean).join("&"))}`;
  const usage = v.today
    .map(
      ({ env, usage: u }) =>
        `<tr><th>${escapeHtml(env)} today (${escapeHtml(u.day)})</th><td>${usd(u.usd)} of ${usd(v.maxDailyUsd)} · ${u.writes} of ${v.maxDailyWrites} writes</td></tr>`,
    )
    .join("");
  const body = v.rows
    .map(
      (a) =>
        `<tr><td class="nw">${escapeHtml(formatClock(a.createdAt, v.timezone))}</td><td class="nw"><span class="env ${a.env === "real" ? "real" : "demo"} small">${escapeHtml(a.env)}</span></td>` +
        `<td class="nw">${escapeHtml(a.tool)}</td><td><a href="${escapeHtml(v.base)}/a/${escapeHtml(a.id)}">${escapeHtml(a.summary)}</a><div class="note">${escapeHtml(ids(a))}</div></td>` +
        `<td class="num">${a.exposureUsd > 0 ? usd(a.exposureUsd) : ""}</td><td class="nw"><span class="st ${escapeHtml(a.status)}">${escapeHtml(a.status)}</span></td></tr>`,
    )
    .join("");
  const from = v.total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + v.rows.length, v.total);
  const prev = offset > 0 ? `<a href="${link(`offset=${Math.max(offset - PAGE_SIZE, 0)}`)}">&larr; Newer</a>` : "";
  const next = offset + PAGE_SIZE < v.total ? `<a href="${link(`offset=${offset + PAGE_SIZE}`)}">Older &rarr;</a>` : "";
  return page(
    v.env,
    "eToro: action history",
    `<h1>Action history</h1>
<p class="note">What Claude prepared and what you executed through this server. Times are in ${escapeHtml(v.timezone)}.${v.persistent ? "" : " <strong>Persistence is off (ETORO_HISTORY_DB=off): this history is lost when the server stops.</strong>"}</p>
<table class="usage">${usage}</table>
<form method="get" action="${escapeHtml(v.base)}" class="filters">
<input type="search" name="q" value="${escapeHtml(v.form.q)}" placeholder="Search: AAPL, order id, position id…" aria-label="Search">
<select name="env" aria-label="Environment">${options(["demo", "real"], v.form.env, "Any environment")}</select>
<select name="tool" aria-label="Action">${options(v.tools, v.form.tool, "Any action")}</select>
<select name="status" aria-label="Status">${options(STATUSES, v.form.status, "Any status")}</select>
<label>From <input type="date" name="from" value="${escapeHtml(v.form.from)}"></label>
<label>To <input type="date" name="to" value="${escapeHtml(v.form.to)}"></label>
<button type="submit">Search</button>
</form>
${v.notice ? `<div class="warn">${escapeHtml(v.notice)}</div>` : ""}
<table class="list"><thead><tr><th>Time</th><th>Env</th><th>Action</th><th>Summary</th><th>Exposure</th><th>Status</th></tr></thead>
<tbody>${body || '<tr><td colspan="6">No actions match.</td></tr>'}</tbody></table>
<div class="paging"><span>${from}–${to} of ${v.total}</span> ${prev} ${next} <a href="${escapeHtml(v.base)}/export.csv${qs ? `?${escapeHtml(qs)}` : ""}">Download CSV</a></div>`,
    { wide: true },
  );
}

export function renderAction(a: ActionRecord, events: EventRecord[], opts: { base: string; timezone: string }): string {
  const rows = a.rows.map((r) => `<tr><th>${escapeHtml(r.label)}</th><td>${escapeHtml(r.value)}</td></tr>`).join("");
  const warnings = a.warnings.map((w) => `<div class="warn">${escapeHtml(w)}</div>`).join("");
  const json = a.result === undefined ? "" : (JSON.stringify(a.result, null, 2) ?? "").slice(0, 4000);
  const timeline = events
    .map((e) => {
      const detail = Object.entries(e.detail)
        .filter(([k]) => k !== "summary")
        .map(([k, val]) => `${k}: ${typeof val === "string" ? val : JSON.stringify(val)}`)
        .join(" · ");
      return `<tr><th>${escapeHtml(formatClock(e.ts, opts.timezone))}</th><td>${escapeHtml(e.event)}${detail ? `<div class="note">${escapeHtml(detail)}</div>` : ""}</td></tr>`;
    })
    .join("");
  return page(
    a.env,
    "eToro: action detail",
    `<p><a href="${escapeHtml(opts.base)}">&larr; Back to the history</a></p>
<h1>${escapeHtml(a.tool)}</h1>
<div class="summary">${escapeHtml(a.summary)}</div>
<table><tr><th>Status</th><td><span class="st ${escapeHtml(a.status)}">${escapeHtml(a.status)}</span></td></tr>
<tr><th>Prepared</th><td>${escapeHtml(formatClock(a.createdAt, opts.timezone))}</td></tr>
${a.decidedAt !== undefined ? `<tr><th>Decided</th><td>${escapeHtml(formatClock(a.decidedAt, opts.timezone))}</td></tr>` : ""}
${a.exposureUsd > 0 ? `<tr><th>Exposure</th><td>${usd(a.exposureUsd)}</td></tr>` : ""}
${ids(a) ? `<tr><th>Ids</th><td>${escapeHtml(ids(a))}</td></tr>` : ""}
<tr><th>Action id</th><td>${escapeHtml(a.id)}</td></tr></table>
<h2>Details</h2><table>${rows}</table>${warnings}
${a.error ? `<h2>Error</h2><pre>${escapeHtml(a.error)}</pre>` : ""}
${json ? `<h2>eToro's answer</h2><pre>${escapeHtml(json)}</pre>` : ""}
${timeline ? `<h2>Timeline</h2><table>${timeline}</table>` : ""}`,
    { wide: true },
  );
}

/** A CSV cell. Cells that a spreadsheet would read as a formula are neutralized with a leading apostrophe. */
function cell(value: unknown): string {
  let text = value === undefined || value === null ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function renderCsv(rows: ActionSummary[], timezone: string): string {
  const header = ["time", "environment", "action", "status", "summary", "exposure_usd", "order_id", "position_id", "instrument_id", "error", "action_id"];
  const lines = rows.map((a) =>
    [formatClock(a.createdAt, timezone), a.env, a.tool, a.status, a.summary, a.exposureUsd, a.orderId, a.positionId, a.instrumentId, a.error, a.id].map(cell).join(","),
  );
  return `${[header.join(","), ...lines].join("\r\n")}\r\n`;
}
