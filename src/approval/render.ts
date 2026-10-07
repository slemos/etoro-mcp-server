import type { Proposal } from "./proposals.js";

/** Escapes text for HTML element content and double-quoted attributes. Everything shown on the page goes through this. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const STYLE = `
  :root { color-scheme: light dark; }
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 640px; margin: 2rem auto; padding: 0 1rem; }
  .env { display: inline-block; padding: .15rem .6rem; border-radius: .4rem; font-weight: 700; color: #fff; }
  .demo { background: #1f7a4d; } .real { background: #b3261e; }
  h1 { font-size: 1.3rem; margin: .8rem 0; }
  .summary { font-weight: 600; margin: 1rem 0; }
  table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
  th { text-align: left; font-weight: 500; opacity: .7; padding: .3rem .8rem .3rem 0; vertical-align: top; width: 38%; }
  td { padding: .3rem 0; word-break: break-word; }
  .warn { border-left: 4px solid #c77700; padding: .4rem .8rem; margin: .6rem 0; }
  .note { opacity: .75; font-size: .9rem; }
  .actions { display: flex; gap: 1rem; margin-top: 1.5rem; }
  button { font: inherit; padding: .6rem 1.4rem; border-radius: .5rem; border: 1px solid #888; cursor: pointer; }
  button.go { background: #1f6feb; border-color: #1f6feb; color: #fff; font-weight: 600; }
  pre { white-space: pre-wrap; word-break: break-word; background: rgba(128,128,128,.15); padding: .8rem; border-radius: .4rem; }
`;

/** Extra styles for the history pages, which are wider than the approval page. */
const WIDE = `
  body { max-width: 1100px; }
  .small { font-size: .75rem; padding: .05rem .45rem; }
  h2 { font-size: 1.05rem; margin: 1.4rem 0 .3rem; }
  .filters { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; margin: 1rem 0; }
  .filters input, .filters select { font: inherit; padding: .35rem .5rem; }
  .filters input[type=search] { flex: 1 1 16rem; }
  table.list th { width: auto; padding: .4rem .6rem .4rem 0; border-bottom: 1px solid rgba(128,128,128,.4); }
  table.list td { padding: .45rem .6rem .45rem 0; border-bottom: 1px solid rgba(128,128,128,.2); vertical-align: top; }
  table.usage th { width: 16rem; }
  .num { text-align: right; white-space: nowrap; }
  .nw { white-space: nowrap; }
  table.list th { white-space: nowrap; }
  .paging { display: flex; gap: 1.2rem; align-items: center; margin: 1rem 0; }
  .st { font-weight: 600; } .st.executed { color: #1f7a4d; } .st.failed { color: #b3261e; } .st.rejected, .st.expired { opacity: .6; }
`;

export function page(env: string | undefined, title: string, body: string, opts: { wide?: boolean } = {}): string {
  const badge = env === undefined ? "" : `<span class="env ${env === "real" ? "real" : "demo"}">${escapeHtml(env.toUpperCase())}</span>\n`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title><style>${STYLE}${opts.wide ? WIDE : ""}</style></head>
<body>${badge}${body}
</body></html>`;
}

const LABELS: Record<Proposal["status"], string> = {
  pending: "Waiting for you",
  executing: "Executing…",
  executed: "Executed",
  rejected: "Rejected: nothing was sent to eToro",
  expired: "Expired: nothing was sent to eToro",
  failed: "Failed",
};

function resultBlock(p: Proposal): string {
  if (p.status === "executed") {
    const json = JSON.stringify(p.result ?? {}, null, 2) ?? "{}";
    return `<p>eToro accepted the request. Claude can follow it with etoro_get_action_status.</p><pre>${escapeHtml(json.slice(0, 2000))}</pre>`;
  }
  if (p.status === "failed") return `<p>eToro or the server refused it:</p><pre>${escapeHtml(p.error ?? "unknown error")}</pre>`;
  return "";
}

/** The approval page for one proposal. Plain HTML and forms, no JavaScript. */
export function renderTicket(p: Proposal, opts: { message?: string; now: number }): string {
  const rows = p.rows.map((r) => `<tr><th>${escapeHtml(r.label)}</th><td>${escapeHtml(r.value)}</td></tr>`).join("");
  const warnings = p.warnings.map((w) => `<div class="warn">${escapeHtml(w)}</div>`).join("");
  const minutes = Math.max(0, Math.ceil((p.expiresAt - opts.now) / 60_000));
  const message = opts.message ? `<div class="warn">${escapeHtml(opts.message)}</div>` : "";
  const form = (action: "execute" | "reject", label: string, cls: string) =>
    `<form method="post" action="/t/${escapeHtml(p.token)}/${action}"><input type="hidden" name="csrf" value="${escapeHtml(p.csrf)}">` +
    `<button class="${cls}" type="submit">${label}</button></form>`;
  const controls =
    p.status === "pending"
      ? `<div class="actions">${form("execute", "Execute", "go")}${form("reject", "Reject", "")}</div>
<p class="note">Claude prepared this action but cannot execute it. Nothing is sent to eToro unless you press Execute. This page expires in about ${minutes} minute${minutes === 1 ? "" : "s"}.</p>`
      : `<p><strong>${escapeHtml(LABELS[p.status])}</strong></p>${resultBlock(p)}`;
  return page(
    p.env,
    `eToro: review action (${p.env})`,
    `<h1>Review before executing</h1>
<div class="summary">${escapeHtml(p.summary)}</div>
<table>${rows}</table>${warnings}${message}${controls}`,
  );
}

export function renderMessage(title: string, text: string): string {
  return page(undefined, title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p>`);
}
