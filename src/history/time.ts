const dayFormats = new Map<string, Intl.DateTimeFormat>();
const clockFormats = new Map<string, Intl.DateTimeFormat>();

/** The calendar day (YYYY-MM-DD) of a timestamp in an IANA time zone. Daily limits are counted per such day. */
export function dayKey(ts: number, timeZone: string): string {
  let f = dayFormats.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
    dayFormats.set(timeZone, f);
  }
  return f.format(ts);
}

/** "2026-10-06 21:14:03" in the given time zone, for the history page and CSV. */
export function formatClock(ts: number, timeZone: string): string {
  let f = clockFormats.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    clockFormats.set(timeZone, f);
  }
  const p = Object.fromEntries(f.formatToParts(ts).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

/** The instant a calendar day (YYYY-MM-DD, plus `plusDays`) starts in an IANA time zone, in ms. */
export function startOfDay(day: string, timeZone: string, plusDays = 0): number {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d + plusDays);
  const offsetAt = (t: number) => Date.parse(`${formatClock(t, timeZone).replace(" ", "T")}Z`) - t;
  // Two passes: the offset at midnight may differ from the one at the first guess when a daylight-saving change falls in between.
  const first = guess - offsetAt(guess);
  return guess - offsetAt(first);
}
