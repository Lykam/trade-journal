// Weekly film study and monthly review facts (SPEC §6.7i, Q91, Q92): read from
// the trades, reviews and daily entries, never typed.
import { addDays } from "../calendar";
import { nextMonth } from "../journal/filter";
import type { Journal } from "../journal/journal";
import { cents } from "../normalize/util";
import type { Review } from "../reviews/join";
import { bookedByDay } from "../trades/stats";
import type { Idea, Style, Trade } from "../types";
import { dayStatus, moodOf, mondayOf, type Entries } from "./entries";

export interface PeriodIdea {
  idea: Idea;
  /** P&L booked inside the period. */
  pnl: number;
  trades: Trade[];
  /** Dates in the period it booked P&L on. */
  dates: string[];
  review: Review | null;
}

/** Each idea's P&L booked between `from` and `to` (inclusive ET dates). */
export function periodIdeas(j: Journal, from: string, to: string): PeriodIdea[] {
  const by = new Map<string, PeriodIdea>();
  for (const t of j.trades) {
    for (const [d, amount] of bookedByDay(t, "net")) {
      if (d < from || d > to) continue;
      const idea = j.ideaById.get(t.ideaId);
      if (!idea) continue;
      const p = by.get(idea.id) ?? { idea, pnl: 0, trades: [], dates: [], review: j.reviews.byIdea.get(idea.id)?.at(-1) ?? null };
      p.pnl += amount;
      if (!p.trades.includes(t)) p.trades.push(t);
      if (!p.dates.includes(d)) p.dates.push(d);
      by.set(idea.id, p);
    }
  }
  return [...by.values()].map((p) => ({ ...p, pnl: cents(p.pnl), dates: p.dates.sort() }));
}

/** The `n` best winners and worst losers, for the side-by-side film study. */
export function bestWorst(ideas: PeriodIdea[], n = 3): { best: PeriodIdea[]; worst: PeriodIdea[] } {
  const sorted = [...ideas].sort((a, b) => b.pnl - a.pnl);
  return { best: sorted.filter((p) => p.pnl > 0).slice(0, n), worst: sorted.filter((p) => p.pnl < 0).reverse().slice(0, n) };
}

const errorKey = (e: string) => e.toLowerCase().replace(/[^a-z0-9 ]+/g, "").replace(/\s+/g, " ").trim();

export interface WeekError {
  error: string;
  reviews: Review[];
  /** Seen more than once in the week, or also in the four weeks before. */
  repeat: boolean;
}

/** Errors named by reviews of the week's ideas (dated in the week), with repeats flagged (Q91). */
export function weekErrors(j: Journal, monday: string): WeekError[] {
  const end = addDays(monday, 6);
  const lookback = addDays(monday, -28);
  const inWeek = new Map<string, WeekError>();
  const before = new Set<string>();
  for (const r of j.reviews.reviews) {
    const e = r.header.error;
    if (!e || !r.date) continue;
    const k = errorKey(e);
    if (r.date >= monday && r.date <= end) {
      const w = inWeek.get(k) ?? { error: e, reviews: [], repeat: false };
      w.reviews.push(r);
      inWeek.set(k, w);
    } else if (r.date >= lookback && r.date < monday) before.add(k);
  }
  return [...inWeek].map(([k, w]) => ({ ...w, repeat: w.reviews.length > 1 || before.has(k) }))
    .sort((a, b) => Number(b.repeat) - Number(a.repeat) || b.reviews.length - a.reviews.length);
}

export interface Group {
  label: string;
  ideas: number;
  wins: number;
  pnl: number;
}

function group(rows: Array<{ label: string; pnl: number }>): Group[] {
  // Labels typed by hand group case- and space-insensitively, under the first spelling seen.
  const by = new Map<string, Group>();
  for (const r of rows) {
    const k = r.label.trim().replace(/[.!]+$/, "").replace(/\s+/g, " ").toLowerCase();
    const g = by.get(k) ?? { label: r.label.trim().replace(/\s+/g, " "), ideas: 0, wins: 0, pnl: 0 };
    g.ideas++;
    if (r.pnl > 0) g.wins++;
    g.pnl += r.pnl;
    by.set(k, g);
  }
  return [...by.values()].map((g) => ({ ...g, pnl: cents(g.pnl) })).sort((a, b) => b.pnl - a.pnl);
}

export interface MonthFacts {
  pnl: number;
  ideas: number;
  wins: number;
  byPlay: Group[];
  byGrade: Group[];
  byStyle: Group[];
  byMood: Group[];
  byError: Group[];
  /** Daily entries done / trading days, and weekly reviews done / weeks with trades (weeks keyed by their Monday). */
  coverage: { days: number; daysDone: number; weeks: number; weeksDone: number };
}

const NOT_REVIEWED = "(not reviewed)";

/**
 * The monthly review's numbers (Q92). Ideas are grouped on the P&L they booked
 * in the month. Mood is the mood of the idea's first booked day in the month.
 */
export function monthFacts(j: Journal, month: string, entries: Entries, traded: Set<string>): MonthFacts {
  const from = `${month}-01`;
  const to = addDays(`${nextMonth(month)}-01`, -1);
  const ideas = periodIdeas(j, from, to);
  const days = [...traded].filter((d) => d >= from && d <= to && d <= j.today);
  const weeks = [...new Set(days.map(mondayOf))];
  const style = (s: Style) => (s === "day" ? "DAY" : "SWING");
  return {
    pnl: cents(ideas.reduce((s, p) => s + p.pnl, 0)),
    ideas: ideas.length,
    wins: ideas.filter((p) => p.pnl > 0).length,
    byPlay: group(ideas.map((p) => ({ label: p.review?.header.play ?? NOT_REVIEWED, pnl: p.pnl }))),
    byGrade: group(ideas.map((p) => ({ label: p.review?.header.grade ?? "(no grade)", pnl: p.pnl }))),
    byStyle: group(ideas.map((p) => ({ label: style(p.idea.style), pnl: p.pnl }))),
    byMood: group(ideas.map((p) => ({ label: moodOf(entries.daily.get(p.dates[0]!)) ?? "(no mood)", pnl: p.pnl }))),
    byError: group(ideas.filter((p) => p.review?.header.error).map((p) => ({ label: p.review!.header.error!, pnl: p.pnl }))),
    coverage: {
      days: days.length,
      daysDone: days.filter((d) => dayStatus(entries.daily.get(d)) === "done").length,
      weeks: weeks.length,
      weeksDone: weeks.filter((w) => entries.weekly.get(w)?.sections.some((s) => s.body)).length,
    },
  };
}
