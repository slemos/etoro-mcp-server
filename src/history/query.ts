import type { EtoroEnv } from "../config.js";
import type { ProposalStatus } from "../approval/proposals.js";
import type { HistoryFilter } from "./db.js";
import { startOfDay } from "./time.js";

export const STATUSES: ProposalStatus[] = ["pending", "executing", "executed", "rejected", "expired", "failed"];
export const PAGE_SIZE = 25;

export interface HistoryQuery {
  q?: string;
  env?: string;
  tool?: string;
  status?: string;
  /** YYYY-MM-DD, inclusive, in the configured time zone. */
  from?: string;
  to?: string;
  offset?: number;
  limit?: number;
}

export interface ParsedQuery {
  filter: HistoryFilter;
  /** The accepted values as text, to refill the search form and to build links. */
  form: { q: string; env: string; tool: string; status: string; from: string; to: string };
  /** Parameters that were not valid and were ignored. */
  problems: string[];
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function validDay(text: string): boolean {
  if (!DAY.test(text)) return false;
  const [y, m, d] = text.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/** Turns what a person (or Claude) typed into a database filter. Anything invalid is dropped and reported, never passed on. */
export function parseHistoryQuery(input: HistoryQuery, timezone: string): ParsedQuery {
  const problems: string[] = [];
  const form = { q: "", env: "", tool: "", status: "", from: "", to: "" };
  const filter: HistoryFilter = { limit: input.limit ?? PAGE_SIZE, offset: Math.max(0, Math.trunc(input.offset ?? 0) || 0) };

  const q = (input.q ?? "").trim().slice(0, 200);
  if (q) {
    form.q = q;
    filter.q = q;
  }
  if (input.env) {
    if (input.env === "demo" || input.env === "real") {
      form.env = input.env;
      filter.env = input.env as EtoroEnv;
    } else problems.push(`Environment "${input.env.slice(0, 20)}" ignored (use demo or real).`);
  }
  if (input.tool) {
    if (/^[a-z_]{1,64}$/.test(input.tool)) {
      form.tool = input.tool;
      filter.tool = input.tool;
    } else problems.push("Action filter ignored.");
  }
  if (input.status) {
    if ((STATUSES as string[]).includes(input.status)) {
      form.status = input.status;
      filter.status = input.status as ProposalStatus;
    } else problems.push(`Status "${input.status.slice(0, 20)}" ignored.`);
  }
  if (input.from) {
    if (validDay(input.from)) {
      form.from = input.from;
      filter.from = startOfDay(input.from, timezone);
    } else problems.push(`"From" date ignored (use YYYY-MM-DD).`);
  }
  if (input.to) {
    if (validDay(input.to)) {
      form.to = input.to;
      filter.to = startOfDay(input.to, timezone, 1);
    } else problems.push(`"To" date ignored (use YYYY-MM-DD).`);
  }
  return { filter, form, problems };
}
