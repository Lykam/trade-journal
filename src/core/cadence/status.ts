// The calendar's REVIEW view (SPEC §6.7i, Q89): which days, weeks and months
// are reviewed, missed or still open, and the streak.
import { addDays } from "../calendar";
import { dailyTotals } from "../journal/calendar-view";
import { nextMonth } from "../journal/filter";
import type { Trade } from "../types";
import { dayStatus, mondayOf, written, type Entries } from "./entries";

export type DayMark = "done" | "morning" | "missed" | "today" | "none";
export type PeriodMark = "done" | "missed" | "open" | "none";

/** ET dates with booked trades: the trading days a report card is expected for. */
export function tradingDays(trades: Trade[]): Set<string> {
  return new Set([...dailyTotals(trades, "net")].filter(([, d]) => d.trades > 0).map(([d]) => d));
}

export function dayMark(date: string, today: string, entries: Entries, traded: Set<string>): DayMark {
  const s = dayStatus(entries.daily.get(date));
  if (s === "done") return "done";
  if (s === "morning") return date < today && traded.has(date) ? "missed" : "morning";
  if (date === today) return "today";
  return date < today && traded.has(date) ? "missed" : "none";
}

/**
 * A week or month: done once its review has anything in it; missed when it had
 * trades and has ended without one; open while it runs (with trades).
 */
function periodMark(hasEntry: boolean, from: string, to: string, today: string, traded: Set<string>): PeriodMark {
  if (hasEntry) return "done";
  let any = false;
  for (const d of traded) if (d >= from && d <= to) any = true;
  if (!any) return "none";
  return to < today ? "missed" : "open";
}

export function weekMark(monday: string, today: string, entries: Entries, traded: Set<string>): PeriodMark {
  return periodMark(written(entries.weekly.get(monday)), monday, addDays(monday, 6), today, traded);
}

export function monthMark(month: string, today: string, entries: Entries, traded: Set<string>): PeriodMark {
  return periodMark(written(entries.monthly.get(month)), `${month}-01`, addDays(`${nextMonth(month)}-01`, -1), today, traded);
}

/**
 * Trading days in a row whose report card is done, counted back from the
 * latest one before today. Today counts once done, and never breaks it.
 */
export function streak(today: string, entries: Entries, traded: Set<string>): number {
  const days = [...traded].filter((d) => d <= today).sort().reverse();
  let n = 0;
  for (const d of days) {
    if (dayStatus(entries.daily.get(d)) === "done") n++;
    else if (d === today) continue;
    else break;
  }
  return n;
}

export const weekOfRow = (rowStart: string) => mondayOf(addDays(rowStart, 1));
