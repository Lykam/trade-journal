// P&L calendar (SPEC §6.2): a month grid with a weekly total column, and a
// 12-month year view. Days are ET dates, so totals follow the ET wall clock
// across DST switches.
import { addDays, dayOfWeek, weekStart } from "../calendar";
import { cents } from "../normalize/util";
import { bookedByDay } from "../trades/stats";
import type { Trade } from "../types";
import { nextMonth, type PnlMode } from "./filter";

export interface DayTotal {
  pnl: number;
  trades: number;
  ideas: number;
}

export interface DayCell extends DayTotal {
  date: string;
  inMonth: boolean;
  review: boolean;
}

export interface WeekRow extends DayTotal {
  start: string;
  days: DayCell[];
  /** The week's days inside the month only, which the WEEK column shows (Q75). */
  month: DayTotal;
  /** Whether the week has trades on days outside the month, so the full week differs. */
  spills: boolean;
}

const EMPTY: DayTotal = { pnl: 0, trades: 0, ideas: 0 };

/**
 * P&L booked per ET date (Q67): each trim and close counts on the day it was
 * taken, so a trim on a still-open swing shows on its own day. A day's trade and
 * idea counts are the trades and ideas that booked P&L that day.
 */
export function dailyTotals(trades: Trade[], pnl: PnlMode): Map<string, DayTotal> {
  const acc = new Map<string, { pnl: number; trades: number; ideas: Set<string> }>();
  for (const t of trades) {
    for (const [d, amount] of bookedByDay(t, pnl)) {
      const a = acc.get(d) ?? { pnl: 0, trades: 0, ideas: new Set<string>() };
      a.pnl += amount;
      a.trades++;
      a.ideas.add(t.ideaId);
      acc.set(d, a);
    }
  }
  return new Map([...acc].map(([d, a]) => [d, { pnl: cents(a.pnl), trades: a.trades, ideas: a.ideas.size }]));
}

/** Ideas are counted once per week even when their trades book on different days. */
function weekIdeas(trades: Trade[], from: string, to: string): number {
  const ideas = new Set<string>();
  for (const t of trades) if ([...bookedByDay(t, "net").keys()].some((d) => d >= from && d <= to)) ideas.add(t.ideaId);
  return ideas.size;
}

/** Weeks covering `month` ("YYYY-MM"), each with seven day cells and its total. */
export function monthGrid(
  trades: Trade[],
  month: string,
  opts: { pnl: PnlMode; startsOn?: "monday" | "sunday"; reviewDates?: Set<string> },
): { weeks: WeekRow[]; total: DayTotal } {
  const totals = dailyTotals(trades, opts.pnl);
  const first = `${month}-01`;
  const last = addDays(`${nextMonth(month)}-01`, -1);
  const weeks: WeekRow[] = [];
  for (let start = weekStart(first, opts.startsOn); start <= last; start = addDays(start, 7)) {
    const days = Array.from({ length: 7 }, (_, i) => {
      const date = addDays(start, i);
      return { date, inMonth: date.slice(0, 7) === month, review: opts.reviewDates?.has(date) ?? false, ...(totals.get(date) ?? EMPTY) };
    });
    // The week's totals cover all seven days; `month` keeps only the days inside the month (Q75).
    const own = days.filter((d) => d.inMonth);
    const end = addDays(start, 6);
    weeks.push({
      start, days,
      pnl: cents(days.reduce((s, d) => s + d.pnl, 0)),
      trades: days.reduce((s, d) => s + d.trades, 0),
      ideas: weekIdeas(trades, start, end),
      month: {
        pnl: cents(own.reduce((s, d) => s + d.pnl, 0)),
        trades: own.reduce((s, d) => s + d.trades, 0),
        ideas: weekIdeas(trades, start < first ? first : start, end > last ? last : end),
      },
      spills: days.some((d) => !d.inMonth && d.trades > 0),
    });
  }
  const inMonth = weeks.flatMap((w) => w.days).filter((d) => d.inMonth);
  return {
    weeks,
    total: {
      pnl: cents(inMonth.reduce((s, d) => s + d.pnl, 0)),
      trades: inMonth.reduce((s, d) => s + d.trades, 0),
      ideas: weekIdeas(trades, first, last),
    },
  };
}

export interface MonthSummary extends DayTotal {
  month: string;
  /** Days of the month, with blanks before the 1st so columns line up by weekday. */
  lead: number;
  days: Array<{ date: string } & DayTotal>;
  green: number;
  red: number;
}

/** Twelve months of daily totals for the year heatmap. */
export function yearView(trades: Trade[], year: number, opts: { pnl: PnlMode; startsOn?: "monday" | "sunday" }): MonthSummary[] {
  const totals = dailyTotals(trades, opts.pnl);
  return Array.from({ length: 12 }, (_, m) => {
    const month = `${year}-${String(m + 1).padStart(2, "0")}`;
    const first = `${month}-01`;
    const days: MonthSummary["days"] = [];
    for (let d = first; d.slice(0, 7) === month; d = addDays(d, 1)) days.push({ date: d, ...(totals.get(d) ?? EMPTY) });
    const dow = dayOfWeek(first);
    return {
      month,
      lead: opts.startsOn === "sunday" ? dow : (dow + 6) % 7,
      days,
      pnl: cents(days.reduce((s, d) => s + d.pnl, 0)),
      trades: days.reduce((s, d) => s + d.trades, 0),
      ideas: weekIdeas(trades, first, days[days.length - 1]!.date),
      green: days.filter((d) => d.pnl > 0).length,
      red: days.filter((d) => d.pnl < 0).length,
    };
  });
}

/** Tint strength 0–1 for a day's P&L relative to the largest absolute day in view (square-root scaled). */
export function tint(pnl: number, maxAbs: number): number {
  if (!pnl || !maxAbs) return 0;
  return Math.min(1, Math.sqrt(Math.abs(pnl) / maxAbs));
}
