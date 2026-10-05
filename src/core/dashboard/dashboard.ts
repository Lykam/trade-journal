// Dashboard and Open Positions data (SPEC §6.1, §6.1a). Pure functions over derived trades.
import { addDays, dayOfWeek, daysBetween, weekStart } from "../calendar";
import { quoteStatus, type QuoteStatus } from "../gauge/gauge";
import { cents, etDate, round } from "../normalize/util";
import { byCloseDesc, heldOvernightDayTrades, isScored, markToMarket, summarize, type Summary } from "../trades/stats";
import type { Broker, Fill, Quote, Style, Trade, TradeEvent } from "../types";


// ---------------------------------------------------------------- open positions

/** Fees paid on a position's buys (open and add events). Realized P&L already subtracts them (Q44). */
export const buyFees = (t: Trade) => cents(t.events.reduce((s, e) => s + (e.kind === "open" || e.kind === "add" ? (e.fees ?? 0) : 0), 0));

/** Whole ET calendar days from the open date to `now` (the same count everywhere, #14). */
export const daysHeld = (t: Trade, now: string) => daysBetween(etDate(t.openedAt), etDate(now));

export interface OpenRow {
  trade: Trade;
  shares: number;
  maxShares: number;
  avgCost: number;
  costBasis: number;
  daysHeld: number;
  trims: TradeEvent[];
  realized: number;
  /** Buy fees on the open and add events; they are part of `realized` (Q44). */
  buyFees: number;
  quote: QuoteStatus | null;
  last: number | null;
  marketValue: number | null;
  unrealized: number | null;
  unrealizedPct: number | null;
  total: number | null;
}

export interface OpenTotals {
  count: number;
  priced: number;
  unpriced: number;
  stale: number;
  unrealized: number;
  realized: number;
  total: number;
  marketValue: number;
  costBasis: number;
  green: number;
  red: number;
  pricesAsOf: string | null;
}

/** Every open position (any style), oldest first, marked to the quote for the symbol actually held. */
export function openPositions(trades: Trade[], quotes: Record<string, Quote>, now: string): OpenRow[] {
  return trades
    .filter((t) => t.status === "open")
    .sort((a, b) => Date.parse(a.openedAt) - Date.parse(b.openedAt))
    .map((t) => {
      const q = quotes[t.symbol];
      const costBasis = cents(t.avgCost * t.openQty);
      const base = {
        trade: t, shares: t.openQty, maxShares: t.maxPosition, avgCost: t.avgCost, costBasis,
        daysHeld: daysHeld(t, now), trims: t.events.filter((e) => e.kind === "trim"),
        realized: t.realizedPnl, buyFees: buyFees(t),
      };
      if (!q) return { ...base, quote: null, last: null, marketValue: null, unrealized: null, unrealizedPct: null, total: null };
      const m = markToMarket(t, q.price);
      return {
        ...base, quote: quoteStatus(q, now), last: q.price, marketValue: m.marketValue, unrealized: m.unrealized,
        unrealizedPct: costBasis ? round(m.unrealized / costBasis, 6) : null, total: m.total,
      };
    });
}

export type OpenSort = "symbol" | "style" | "opened" | "days" | "shares" | "avg" | "last" | "value" | "unrealized" | "pct" | "realized" | "total";
const OPEN_SORT_VALUE: Record<OpenSort, (r: OpenRow) => number | string | null> = {
  symbol: (r) => r.trade.symbol, style: (r) => r.trade.style, opened: (r) => r.trade.openedAt, days: (r) => r.daysHeld,
  shares: (r) => r.shares, avg: (r) => r.avgCost, last: (r) => r.last, value: (r) => r.marketValue, unrealized: (r) => r.unrealized,
  pct: (r) => r.unrealizedPct, realized: (r) => r.realized, total: (r) => r.total,
};

/** Open Positions page sort (#14): unpriced (null) values sort last either way; ties keep the incoming order. */
export function sortOpenRows(rows: OpenRow[], key: OpenSort, dir: 1 | -1): OpenRow[] {
  const value = OPEN_SORT_VALUE[key];
  return rows
    .map((r, i) => ({ r, i, v: value(r) }))
    .sort((a, b) => {
      if (a.v === null || b.v === null) return a.v === b.v ? a.i - b.i : a.v === null ? 1 : -1;
      const c = typeof a.v === "string" ? a.v.localeCompare(b.v as string) : a.v - (b.v as number);
      return dir * c || a.i - b.i;
    })
    .map(({ r }) => r);
}

export function openTotals(rows: OpenRow[]): OpenTotals {

  const priced = rows.filter((r) => r.quote);
  const sum = (xs: OpenRow[], f: (r: OpenRow) => number | null) => cents(xs.reduce((s, r) => s + (f(r) ?? 0), 0));
  let pricesAsOf: string | null = null;
  for (const r of priced) if (!pricesAsOf || Date.parse(r.quote!.time) > Date.parse(pricesAsOf)) pricesAsOf = r.quote!.time;
  const unrealized = sum(priced, (r) => r.unrealized);
  const realized = sum(rows, (r) => r.realized);
  return {
    count: rows.length,
    priced: priced.length,
    unpriced: rows.length - priced.length,
    stale: priced.filter((r) => r.quote!.isStale).length,
    unrealized,
    realized,
    total: cents(unrealized + realized),
    marketValue: sum(priced, (r) => r.marketValue),
    costBasis: sum(priced, (r) => r.costBasis),
    green: priced.filter((r) => r.total! > 0).length,
    red: priced.filter((r) => r.total! < 0).length,
    pricesAsOf,
  };
}

// ---------------------------------------------------------------- recent trades

const closedOn = (t: Trade) => etDate(t.closedAt!);
const scoredIn = (trades: Trade[], from: string, to: string) =>
  trades.filter((t) => isScored(t) && closedOn(t) >= from && closedOn(t) <= to);


/** "2m 30s", "3h 05m", or for date-only trades "same day" / "3d". */
export function holdLabel(t: Trade): string {
  if (t.holdMinutes !== null) {
    const s = Math.round(t.holdMinutes * 60);
    if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
  }
  if (!t.closedAt) return "";
  const d = daysBetween(etDate(t.openedAt), closedOn(t));
  return d === 0 ? "same day" : `${d}d`;

}

export interface Recent {
  style: Style;
  trades: Trade[]; // newest first
  streak: Array<Trade["result"]>; // oldest → newest
  summary: Summary;
}

export function recentTrades(trades: Trade[], style: Style, n = 10): Recent {
  const list = byCloseDesc(trades.filter((t) => t.style === style && isScored(t))).slice(0, n);
  return { style, trades: list, streak: [...list].reverse().map((t) => t.result), summary: summarize(list) };
}

// ---------------------------------------------------------------- week strip

export interface DayCard {
  date: string;
  net: number;
  trades: number;
}

/** Seven day cards for the week containing `date`, starting on config.weekStartsOn like the gauges (SPEC §6.1 item 4, Q19). */
export function weekStrip(trades: Trade[], date: string, startsOn: "monday" | "sunday" = "monday"): DayCard[] {
  const first = weekStart(date, startsOn);
  return Array.from({ length: 7 }, (_, i) => {
    const d = addDays(first, i);
    const day = scoredIn(trades, d, d);
    return { date: d, net: cents(day.reduce((s, t) => s + t.netPnl, 0)), trades: day.length };
  });
}

// ---------------------------------------------------------------- range widgets

export const DURATION_BUCKETS = [
  "< 5 min", "5–30 min", "30 min–2 h", "2h – close", "same day (no time)", "1–5 days", "1–4 weeks", "> 4 weeks",
] as const;
export type DurationBucket = (typeof DURATION_BUCKETS)[number];

export function durationBucket(t: Trade): DurationBucket {
  const days = t.closedAt ? daysBetween(etDate(t.openedAt), closedOn(t)) : 0;
  if (days === 0) {
    if (t.holdMinutes === null) return "same day (no time)";
    if (t.holdMinutes < 5) return "< 5 min";
    if (t.holdMinutes < 30) return "5–30 min";
    if (t.holdMinutes < 120) return "30 min–2 h";
    return "2h – close";

  }
  if (days <= 5) return "1–5 days";
  if (days <= 28) return "1–4 weeks";
  return "> 4 weeks";
}

interface Bucket {
  net: number;
  trades: number;
  wins: number;
  losses: number;
  winRate: number | null;
}

function bucket(trades: Trade[]): Bucket {
  const s = summarize(trades);
  return { net: s.netPnl, trades: s.closed, wins: s.wins, losses: s.losses, winRate: s.winRate };
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);

export interface RangeStats {
  days: number;
  from: string;
  to: string;
  summary: Summary;
  cumulative: Array<{ date: string; net: number; cum: number }>;
  winByDay: Array<{ date: string } & Bucket>;
  avgWin: number | null;
  avgLoss: number | null;
  profitFactor: number | null;
  largestGain: Trade | null;
  largestLoss: Trade | null;
  /** Day trades: minutes (timed trades only). Swing trades: calendar days. */
  hold: Record<Style, { winners: number | null; losers: number | null; unit: "min" | "days" }>;
  byDayOfWeek: Array<{ dow: number; share: number } & Bucket>;
  byDuration: Array<{ bucket: DurationBucket } & Bucket>;
}

/** Widgets for the last `days` ET calendar days ending today (SPEC §6.1 items 5–6), for one style or both (#15). */
export function rangeStats(trades: Trade[], days: number, now: string, style: Style | null = null): RangeStats {
  const to = etDate(now);
  const from = addDays(to, -(days - 1));
  const list = scoredIn(style ? trades.filter((t) => t.style === style) : trades, from, to);
  const dates = [...new Set(list.map(closedOn))].sort();
  let cum = 0;
  const cumulative = dates.map((date) => {
    const net = cents(list.filter((t) => closedOn(t) === date).reduce((s, t) => s + t.netPnl, 0));
    cum = cents(cum + net);
    return { date, net, cum };
  });
  const wins = list.filter((t) => t.result === "win");
  const losses = list.filter((t) => t.result === "loss");
  const grossWin = wins.reduce((s, t) => s + t.netPnl, 0);
  const grossLoss = losses.reduce((s, t) => s + t.netPnl, 0);
  const extreme = (xs: Trade[], dir: 1 | -1) =>
    xs.reduce<Trade | null>((best, t) => (!best || dir * t.netPnl > dir * best.netPnl ? t : best), null);

  const holdFor = (style: Style) => {
    const of = (xs: Trade[]) =>
      style === "day"
        ? avg(xs.filter((t) => t.style === "day" && t.holdMinutes !== null).map((t) => t.holdMinutes!))
        : avg(xs.filter((t) => t.style === "swing").map((t) => daysBetween(etDate(t.openedAt), closedOn(t))));
    const r = (x: number | null) => (x === null ? null : round(x, 2));
    return { winners: r(of(wins)), losers: r(of(losses)), unit: style === "day" ? ("min" as const) : ("days" as const) };
  };

  const dows = [...new Set([1, 2, 3, 4, 5, ...list.map((t) => dayOfWeek(closedOn(t)))])].sort();
  const byDow = dows.map((dow) => ({ dow, ...bucket(list.filter((t) => dayOfWeek(closedOn(t)) === dow)) }));
  const absTotal = byDow.reduce((s, b) => s + Math.abs(b.net), 0);

  return {
    days, from, to,
    summary: summarize(list),
    cumulative,
    winByDay: dates.map((date) => ({ date, ...bucket(list.filter((t) => closedOn(t) === date)) })),
    avgWin: wins.length ? cents(grossWin / wins.length) : null,
    avgLoss: losses.length ? cents(grossLoss / losses.length) : null,
    profitFactor: losses.length ? round(grossWin / Math.abs(grossLoss), 2) : null,
    largestGain: extreme(wins, 1),
    largestLoss: extreme(losses, -1),
    hold: { day: holdFor("day"), swing: holdFor("swing") },
    byDayOfWeek: byDow.map((b) => ({ ...b, share: absTotal ? round(b.net / absTotal, 4) : 0 })),
    byDuration: DURATION_BUCKETS.map((b) => ({ bucket: b, ...bucket(list.filter((t) => durationBucket(t) === b)) })),
  };
}

// ---------------------------------------------------------------- imports

/** The latest import time per broker, from the fills' `importedAt` (empty values ignored). */
export function lastImports(fills: Fill[]): Partial<Record<Broker, string>> {
  const out: Partial<Record<Broker, string>> = {};
  for (const f of fills) if (f.importedAt && (!out[f.broker] || Date.parse(f.importedAt) > Date.parse(out[f.broker]!))) out[f.broker] = f.importedAt;
  return out;
}

// ---------------------------------------------------------------- needs attention

export interface Attention {
  unmatched: Trade[];
  unpriced: Trade[];
  stale: Trade[];
  heldOvernight: Trade[];
}

export function needsAttention(trades: Trade[], rows: OpenRow[], now: string): Attention {
  return {
    unmatched: trades.filter((t) => t.status === "unmatched"),
    unpriced: rows.filter((r) => !r.quote).map((r) => r.trade),
    stale: rows.filter((r) => r.quote?.isStale).map((r) => r.trade),
    heldOvernight: heldOvernightDayTrades(trades, etDate(now)),
  };
}
