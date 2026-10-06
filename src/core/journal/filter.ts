// Global filter bar state (SPEC §6.0), kept in the URL so views can be bookmarked.
// Pure: parsing, serializing and matching take every input as a parameter.
import { addDays, weekStart } from "../calendar";
import { etDate } from "../normalize/util";
import { bookedByDay } from "../trades/stats";
import type { Broker, Style, Trade, TradeResult } from "../types";

export type PnlMode = "net" | "gross";
export type CountMode = "trade" | "idea";
export type Duration = "intraday" | "multiday";
export type Instrument = Trade["instrument"];
export type ReviewFilter = "yes" | "no";
export type Flag = "overnight" | "unmatched" | "open" | "excluded";

export const PRESETS = ["today", "week", "lastweek", "month", "lastmonth", "30d", "90d", "ytd"] as const;
export type Preset = (typeof PRESETS)[number];
export const PRESET_LABELS: Record<Preset, string> = {
  today: "TODAY", week: "THIS WEEK", lastweek: "LAST WEEK", month: "THIS MONTH", lastmonth: "LAST MONTH", "30d": "30D", "90d": "90D", ytd: "YTD",
};
/** The short forms, used only below 640 px (#13). */
export const PRESET_SHORT: Record<Preset, string> = {
  today: "TODAY", week: "THIS WK", lastweek: "LAST WK", month: "THIS MO", lastmonth: "LAST MO", "30d": "30D", "90d": "90D", ytd: "YTD",
};

export interface TradeFilter {
  /** Matches the traded symbol or the underlying (case-insensitive, exact). */
  symbols: string[];
  tags: string[];
  tagMode: "any" | "all";
  style: Style | null;
  instrument: Instrument | null;
  broker: Broker | null;
  duration: Duration | null;
  results: TradeResult[];
  review: ReviewFilter | null;
  /** A relative range; wins over from/to. */
  preset: Preset | null;
  from: string | null;
  to: string | null;
  /** With a date range: trades that booked P&L in it (a trim or the close), not trades dated in it (Q67). */
  booked: boolean;
  flag: Flag | null;
}

export type SortKey = "date" | "symbol" | "style" | "volume" | "executions" | "hold" | "pnl" | "review" | "notes" | "tags";
export const SORT_KEYS: readonly SortKey[] = ["date", "symbol", "style", "volume", "executions", "hold", "pnl", "review", "notes", "tags"];

export interface ViewState {
  filter: TradeFilter;
  pnl: PnlMode;
  count: CountMode;
  sort: { key: SortKey; dir: "asc" | "desc" };
  page: number;
}

export const emptyFilter = (): TradeFilter => ({
  symbols: [], tags: [], tagMode: "any", style: null, instrument: null, broker: null, duration: null, results: [],
  review: null, preset: null, from: null, to: null, booked: false, flag: null,
});

export const defaultView = (): ViewState => ({ filter: emptyFilter(), pnl: "net", count: "trade", sort: { key: "date", dir: "desc" }, page: 1 });

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const oneOf = <T extends string>(v: string | null, allowed: readonly T[]): T | null =>
  v !== null && (allowed as readonly string[]).includes(v) ? (v as T) : null;
const list = (v: string | null) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : []);
const date = (v: string | null) => (v && DATE_RE.test(v) ? v : null);

/** Read view state from URL params. `date=` (week strip, calendar) is shorthand for from = to = date. */
export function parseView(p: URLSearchParams): ViewState {
  const d = defaultView();
  const single = date(p.get("date"));
  const sort = p.get("sort") ?? "";
  const key = oneOf(sort.replace(/^-/, ""), SORT_KEYS);
  const page = Number(p.get("page"));
  return {
    filter: {
      symbols: list(p.get("symbol")).map((s) => s.toUpperCase()),
      tags: list(p.get("tags")),
      tagMode: p.get("tagmode") === "all" ? "all" : "any",
      style: oneOf(p.get("style"), ["day", "swing"] as const),
      instrument: oneOf(p.get("instrument"), ["stock", "leveraged_etf"] as const),
      broker: oneOf(p.get("broker"), ["schwab", "webull"] as const),
      duration: oneOf(p.get("duration"), ["intraday", "multiday"] as const),
      results: list(p.get("result")).filter((r): r is TradeResult => ["win", "loss", "breakeven"].includes(r)),
      review: oneOf(p.get("review"), ["yes", "no"] as const),
      preset: single ? null : oneOf(p.get("range"), PRESETS),
      from: single ?? date(p.get("from")),
      to: single ?? date(p.get("to")),
      booked: p.get("booked") === "1",
      flag: oneOf(p.get("flag"), ["overnight", "unmatched", "open", "excluded"] as const),
    },
    pnl: p.get("pnl") === "gross" ? "gross" : d.pnl,
    count: p.get("count") === "idea" ? "idea" : d.count,
    sort: key ? { key, dir: sort.startsWith("-") ? "desc" : "asc" } : d.sort,
    page: Number.isInteger(page) && page > 1 ? page : 1,
  };
}

/** View state → URL params, leaving out defaults so URLs stay short. */
export function viewToParams(v: ViewState, opts: { page?: boolean; sort?: boolean } = {}): URLSearchParams {
  const p = new URLSearchParams();
  const f = v.filter;
  if (f.symbols.length) p.set("symbol", f.symbols.join(","));
  if (f.tags.length) p.set("tags", f.tags.join(","));
  if (f.tags.length > 1 && f.tagMode === "all") p.set("tagmode", "all");
  if (f.style) p.set("style", f.style);
  if (f.instrument) p.set("instrument", f.instrument);
  if (f.broker) p.set("broker", f.broker);
  if (f.duration) p.set("duration", f.duration);
  if (f.results.length) p.set("result", f.results.join(","));
  if (f.review) p.set("review", f.review);
  if (f.preset) p.set("range", f.preset);
  else if (f.from && f.from === f.to) p.set("date", f.from);
  else {
    if (f.from) p.set("from", f.from);
    if (f.to) p.set("to", f.to);
  }
  if (f.booked && (f.preset || f.from || f.to)) p.set("booked", "1");
  if (f.flag) p.set("flag", f.flag);
  if (v.pnl !== "net") p.set("pnl", v.pnl);
  if (v.count !== "trade") p.set("count", v.count);
  const d = defaultView().sort;
  if (opts.sort !== false && (v.sort.key !== d.key || v.sort.dir !== d.dir)) p.set("sort", `${v.sort.dir === "desc" ? "-" : ""}${v.sort.key}`);
  if (opts.page !== false && v.page > 1) p.set("page", String(v.page));
  return p;
}

export const queryOf = (p: URLSearchParams) => {
  const s = p.toString().replace(/%2C/gi, ",");
  return s ? `?${s}` : "";
};

/** The from/to a filter covers on `today` (ET), resolving presets. Either end may be open. */
export function dateRange(f: TradeFilter, today: string, startsOn: "monday" | "sunday" = "monday"): { from: string | null; to: string | null } {
  const month = today.slice(0, 7);
  switch (f.preset) {
    case "today": return { from: today, to: today };
    case "week": return { from: weekStart(today, startsOn), to: addDays(weekStart(today, startsOn), 6) };
    case "lastweek": { const s = addDays(weekStart(today, startsOn), -7); return { from: s, to: addDays(s, 6) }; }
    case "month": return { from: `${month}-01`, to: addDays(`${nextMonth(month)}-01`, -1) };
    case "lastmonth": { const m = prevMonth(month); return { from: `${m}-01`, to: addDays(`${month}-01`, -1) }; }
    case "30d": return { from: addDays(today, -29), to: today };
    case "90d": return { from: addDays(today, -89), to: today };
    case "ytd": return { from: `${today.slice(0, 4)}-01-01`, to: today };
    default: return { from: f.from, to: f.to };
  }
}

export function prevMonth(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}
export function nextMonth(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}
/**
 * The ET date a trade belongs to: its close date, or its open date while still
 * open (Q26). The date filter and the Trades date column use it; the calendar
 * and the week strip count P&L on the day it was booked instead, and link with
 * `booked` set so a day and its trade list still agree (Q67).
 */
export const tradeDate = (t: Trade) => etDate(t.closedAt ?? t.openedAt);

export function durationOf(t: Trade, today: string): Duration {
  if (t.closedAt) return t.sameDay ? "intraday" : "multiday";
  return etDate(t.openedAt) === today ? "intraday" : "multiday";
}

export interface MatchContext {
  today: string;
  startsOn?: "monday" | "sunday";
  /** Every tag on the trade, automatic and manual (SPEC §6.6). */
  tagsOf: (t: Trade) => string[];
  reviewed: (t: Trade) => boolean;
  overnight?: Set<string>;
}

/** A predicate for one filter, with the date range resolved once. */
export function tradeMatcher(f: TradeFilter, ctx: MatchContext): (t: Trade) => boolean {
  const { from, to } = dateRange(f, ctx.today, ctx.startsOn);
  const syms = new Set(f.symbols.map((s) => s.toUpperCase()));
  const tags = f.tags.map((t) => t.toLowerCase());
  return (t) => {
    if (syms.size && !syms.has(t.symbol.toUpperCase()) && !syms.has(t.underlying.toUpperCase())) return false;
    if (f.style && t.style !== f.style) return false;
    if (f.instrument && t.instrument !== f.instrument) return false;
    if (f.broker && t.broker !== f.broker) return false;
    if (f.duration && durationOf(t, ctx.today) !== f.duration) return false;
    if (f.results.length && (t.result === null || !f.results.includes(t.result))) return false;
    if (f.review && ctx.reviewed(t) !== (f.review === "yes")) return false;
    if (from || to) {
      const inRange = (d: string) => (!from || d >= from) && (!to || d <= to);
      if (f.booked ? ![...bookedByDay(t, "net").keys()].some(inRange) : !inRange(tradeDate(t))) return false;
    }
    if (tags.length) {
      const have = new Set(ctx.tagsOf(t).map((x) => x.toLowerCase()));
      if (f.tagMode === "all" ? !tags.every((x) => have.has(x)) : !tags.some((x) => have.has(x))) return false;
    }
    switch (f.flag) {
      case "overnight": if (!ctx.overnight?.has(t.id)) return false; break;
      case "unmatched": if (t.status !== "unmatched") return false; break;
      case "open": if (t.status !== "open") return false; break;
      case "excluded": if (!t.excluded) return false; break;
    }
    return true;
  };
}

/**
 * One short label per active filter, for the chips on a collapsed filter bar (#21):
 * "NVQX", "DAY", "ETF", "WIN + LOSS", "REVIEWED", "THIS WEEK", "09-01 – 09-30".
 */
export function activeFilterLabels(f: TradeFilter, today: string, startsOn: "monday" | "sunday" = "monday", dates = true): string[] {
  const out: string[] = [];
  if (f.symbols.length) out.push(f.symbols.join(", "));
  if (f.tags.length) out.push(`TAGS ${f.tags.join(f.tagMode === "all" ? " & " : ", ")}`);
  if (f.style) out.push(f.style.toUpperCase());
  if (f.instrument) out.push(f.instrument === "leveraged_etf" ? "ETF" : "STOCK");
  if (f.broker) out.push(f.broker.toUpperCase());
  if (f.duration) out.push(f.duration === "intraday" ? "INTRADAY" : "MULTI-DAY");
  if (f.results.length) out.push(f.results.map((r) => r.toUpperCase()).join(" + "));
  if (f.review) out.push(f.review === "yes" ? "REVIEWED" : "NOT REVIEWED");
  if (dates) {
    if (f.preset) out.push(PRESET_LABELS[f.preset]);
    else if (f.from || f.to) {
      const r = dateRange(f, today, startsOn);
      out.push(r.from === r.to ? r.from! : `${r.from ?? "…"} – ${r.to ?? "…"}`);
    }
    if (f.booked && (f.preset || f.from || f.to)) out[out.length - 1] = `BOOKED ${out[out.length - 1]}`;
  }
  if (f.flag) out.push(f.flag.toUpperCase());
  return out;
}

/** Number of active filter fields (for the "N FILTERS · CLEAR" control). */
export function activeFilterCount(f: TradeFilter): number {
  return [
    f.symbols.length > 0, f.tags.length > 0, f.style, f.instrument, f.broker, f.duration, f.results.length > 0, f.review,
    f.preset || f.from || f.to, f.flag,
  ].filter(Boolean).length;
}
