// ET calendar helpers. Dates are "YYYY-MM-DD" strings in America/New_York, so
// week boundaries follow the ET wall clock across DST switches.
import { etDate, etOffset } from "./normalize/util";

const DAY_MS = 86_400_000;
const parseDay = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));

/** Calendar arithmetic on ET dates. */
export function addDays(date: string, n: number): string {
  return new Date(parseDay(date) + n * DAY_MS).toISOString().slice(0, 10);
}

/** Whole calendar days from `a` to `b` (b − a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((parseDay(b) - parseDay(a)) / DAY_MS);
}

/** 0 = Sunday … 6 = Saturday. */
export function dayOfWeek(date: string): number {
  return new Date(parseDay(date)).getUTCDay();
}

/** First ET date of the week containing `date`. */
export function weekStart(date: string, startsOn: "monday" | "sunday" = "monday"): string {
  const dow = dayOfWeek(date);
  return addDays(date, -(startsOn === "monday" ? (dow + 6) % 7 : dow));
}

/** The instant of an ET wall-clock time on an ET date. */
export function etInstant(date: string, time = "00:00:00"): number {
  return Date.parse(`${date}T${time}${etOffset(date, time)}`);
}

const ET_TIME = new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit" });

/** HH:MM in ET. */
export function etTime(iso: string): string {
  return ET_TIME.format(new Date(iso));
}

const isWeekday = (date: string) => dayOfWeek(date) % 6 !== 0;

/**
 * Number of complete regular sessions (weekdays 09:30–16:00 ET) that both
 * started after `from` and ended at or before `to`. Market holidays are not
 * modeled, so a holiday counts as a session (errs toward calling a quote stale).
 */
export function sessionsBetween(from: string, to: string): number {
  const start = Date.parse(from);
  const end = Date.parse(to);
  let n = 0;
  for (let d = etDate(from); d <= etDate(to); d = addDays(d, 1)) {
    if (!isWeekday(d)) continue;
    if (etInstant(d, "09:30:00") > start && etInstant(d, "16:00:00") <= end) n++;
  }
  return n;
}
