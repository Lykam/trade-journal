// Reports page state and the analyses beyond the grid (SPEC §6.5): Win vs Loss
// Days, Drawdown, Compare and Tag Breakdown.
import { daysBetween } from "../calendar";
import { parseView, viewToParams, type TradeFilter, type ViewState } from "../journal/filter";
import { AUTO_TAGS, type TradeTags } from "../journal/tags";
import type { Trade } from "../types";
import { computeGrid, type Grid } from "./grid";
import { drawdowns, mean, sum, type DrawdownPeriod } from "./math";
import { buildUnits, holdOf, valueOf, type Unit, type ValueMode, type ValueOpts } from "./units";

// ---------------------------------------------------------------- URL state

export const TABS = ["overview", "detailed", "days", "drawdown", "compare", "tags"] as const;
export type Tab = (typeof TABS)[number];
export const TAB_LABELS: Record<Tab, string> = {
  overview: "OVERVIEW", detailed: "DETAILED", days: "WIN VS LOSS DAYS", drawdown: "DRAWDOWN", compare: "COMPARE", tags: "TAG BREAKDOWN",
};
export const SUBS = ["times", "price", "instrument", "wle"] as const;
export type Sub = (typeof SUBS)[number];
export const SUB_LABELS: Record<Sub, string> = { times: "DAYS/TIMES", price: "PRICE/VOLUME", instrument: "INSTRUMENT", wle: "WIN/LOSS/EXPECTATION" };

export interface ReportState {
  tab: Tab;
  sub: Sub;
  mode: ValueMode;
  /** Compare: the second filter set (the first is the global filter). */
  b: TradeFilter;
  /** Tag Breakdown: the tag whose full grid is open. */
  tag: string | null;
}

const pick = <T extends string>(v: string | null, all: readonly T[], d: T): T => (v !== null && (all as readonly string[]).includes(v) ? (v as T) : d);

/** `#/reports?tab=compare&sub=price&mode=pct&b=style%3Dswing&tag=…` next to the global filter params. */
export function parseReport(p: URLSearchParams): ReportState {
  return {
    tab: pick(p.get("tab"), TABS, "overview"),
    sub: pick(p.get("sub"), SUBS, "times"),
    mode: p.get("mode") === "pct" ? "pct" : "usd",
    b: parseView(new URLSearchParams(p.get("b") ?? "")).filter,
    tag: p.get("tag") || null,
  };
}

/** Report params that ride along with the global filter (defaults left out). */
export function reportExtra(r: ReportState): Record<string, string> {
  const out: Record<string, string> = {};
  if (r.tab !== "overview") out.tab = r.tab;
  if (r.sub !== "times") out.sub = r.sub;
  if (r.mode !== "usd") out.mode = r.mode;
  const b = filterQuery(r.b);
  if (r.tab === "compare" && b) out.b = b;
  if (r.tab === "tags" && r.tag) out.tag = r.tag;
  return out;
}

/** A filter alone as a query string (no P&L / count / sort / page), for Compare's second set. */
export const filterQuery = (f: TradeFilter) => viewToParams({ ...parseView(new URLSearchParams()), filter: f }, { page: false, sort: false }).toString();

export interface ComparePreset {
  key: string;
  label: string;
  a: Partial<TradeFilter>;
  b: Partial<TradeFilter>;
}

export const COMPARE_PRESETS: ComparePreset[] = [
  { key: "style", label: "DAY VS SWING", a: { style: "day" }, b: { style: "swing" } },
  { key: "instrument", label: "STOCK VS ETF", a: { instrument: "stock" }, b: { instrument: "leveraged_etf" } },
  { key: "broker", label: "SCHWAB VS WEBULL", a: { broker: "schwab" }, b: { broker: "webull" } },
  { key: "month", label: "THIS MONTH VS LAST MONTH", a: { preset: "month", from: null, to: null }, b: { preset: "lastmonth", from: null, to: null } },
];

/** Apply a preset on top of the current filter: both sides keep everything else. */
export function applyPreset(view: ViewState, p: ComparePreset): { a: TradeFilter; b: TradeFilter } {
  return { a: { ...view.filter, ...p.a }, b: { ...view.filter, ...p.b } };
}

// ---------------------------------------------------------------- win vs loss days

export interface DaySide {
  days: number;
  units: Unit[];
  grid: Grid;
  perDay: {
    units: number | null;
    volume: number | null;
    /** Mean shares bought per unit. */
    shares: number | null;
    /** Mean cost per unit, $. */
    cost: number | null;
    /** Minutes (holdOf). */
    hold: number | null;
  };
}

/**
 * Units split by whether their ET close date was a green or red day overall.
 * A day's color comes from its net P&L, like a trade's result (Q2), in both
 * P&L modes; flat days (exactly $0.00) are counted apart.
 */
export function winLossDays(units: Unit[], o: ValueOpts): { green: DaySide; red: DaySide; flatDays: number } {
  const by = new Map<string, Unit[]>();
  for (const u of units) by.set(u.date, [...(by.get(u.date) ?? []), u]);
  const green: Unit[] = [], red: Unit[] = [];
  let gd = 0, rd = 0, flat = 0;
  for (const us of by.values()) {
    const net = Math.round(sum(us.map((u) => u.net)) * 100);
    if (net > 0) { gd++; green.push(...us); } else if (net < 0) { rd++; red.push(...us); } else flat++;
  }
  const side = (us: Unit[], days: number): DaySide => {
    const holds = us.map(holdOf).filter((h): h is number => h !== null);
    return {
      days, units: us, grid: computeGrid(us, o),
      perDay: {
        units: days ? us.length / days : null,
        volume: days ? sum(us.map((u) => u.volume)) / days : null,
        shares: mean(us.map((u) => u.shares)),
        cost: mean(us.map((u) => u.cost)),
        hold: mean(holds),
      },
    };
  };
  const inOrder = (xs: Unit[]) => xs.sort((a, b) => a.time - b.time || a.order - b.order);
  return { green: side(inOrder(green), gd), red: side(inOrder(red), rd), flatDays: flat };
}

// ---------------------------------------------------------------- drawdown

export interface DrawdownReport {
  /** End-of-day equity and underwater depth (≤ 0), for the chart. */
  days: Array<{ date: string; equity: number; underwater: number }>;
  max: DrawdownPeriod | null;
  /** The max drawdown as a share of the peak it fell from ($ mode, peak > 0 only). */
  maxPctOfPeak: number | null;
  /** Longest period below a peak, in calendar days (to the last date if still under water). */
  longest: (DrawdownPeriod & { days: number }) | null;
  /** Calendar days from the max drawdown's trough back to its peak; null while not recovered. */
  recoveryDays: number | null;
  /** Calendar days from the max drawdown's peak to its trough. */
  declineDays: number | null;
  current: number;
  periods: number;
}

/**
 * Drawdown of the cumulative curve in close order (each unit a step, so a dip
 * inside a day counts). Periods that start at the very beginning are dated
 * from the first close.
 */
export function drawdownReport(units: Unit[], o: ValueOpts): DrawdownReport {
  const dd = drawdowns(units.map((u) => ({ date: u.date, value: valueOf(u, o) })));
  const first = units[0]?.date ?? "";
  const last = units[units.length - 1]?.date ?? "";
  const start = (p: DrawdownPeriod) => p.peakDate || first;
  const length = (p: DrawdownPeriod) => daysBetween(start(p), p.recoveredDate ?? last);
  const longest = dd.periods.reduce<(DrawdownPeriod & { days: number }) | null>((m, p) => {
    const d = length(p);
    return !m || d > m.days ? { ...p, days: d } : m;
  }, null);
  const byDay = new Map<string, { equity: number; underwater: number }>();
  for (const c of dd.curve) {
    const prev = byDay.get(c.date);
    // End-of-day equity, but keep the day's deepest point so the chart shows it.
    byDay.set(c.date, { equity: c.equity, underwater: Math.min(prev?.underwater ?? 0, c.underwater) });
  }
  const m = dd.max;
  return {
    days: [...byDay].map(([date, v]) => ({ date, ...v })),
    max: m,
    maxPctOfPeak: m && o.mode === "usd" && m.peak > 0 ? m.depth / m.peak : null,
    longest,
    recoveryDays: m?.recoveredDate ? daysBetween(m.troughDate, m.recoveredDate) : null,
    declineDays: m ? daysBetween(start(m), m.troughDate) : null,
    current: dd.curve.length ? dd.curve[dd.curve.length - 1]!.underwater : 0,
    periods: dd.periods.length,
  };
}

// ---------------------------------------------------------------- tag breakdown

export interface TagGroup {
  kind: "manual" | "category" | "style";
  tag: string;
  units: Unit[];
  grid: Grid;
}

/**
 * The grid for every manual tag, every review Category (the automatic tags
 * other than Day / Swing / ETF / Reviewed) and each style, over the filtered
 * trades. A trade can sit in several groups.
 */
export function tagGroups(trades: Trade[], tagsOf: (t: Trade) => TradeTags | undefined, count: Unit["kind"], o: ValueOpts): TagGroup[] {
  const fixed = new Set<string>(AUTO_TAGS.map((t) => t.toLowerCase()));
  const groups = new Map<string, { kind: TagGroup["kind"]; tag: string; trades: Trade[] }>();
  const add = (kind: TagGroup["kind"], tag: string, t: Trade) => {
    const k = `${kind}:${tag.toLowerCase()}`;
    const g = groups.get(k) ?? { kind, tag, trades: [] };
    g.trades.push(t);
    groups.set(k, g);
  };
  for (const t of trades) {
    const tt = tagsOf(t);
    for (const m of tt?.manual ?? t.tags) add("manual", m, t);
    for (const a of tt?.auto ?? []) if (!fixed.has(a.toLowerCase())) add("category", a, t);
    add("style", t.style === "day" ? "Day" : "Swing", t);
  }
  const rank = { manual: 0, category: 1, style: 2 };
  return [...groups.values()]
    .map((g) => {
      const units = buildUnits(g.trades, count);
      return { kind: g.kind, tag: g.tag, units, grid: computeGrid(units, o) };
    })
    .filter((g) => g.units.length > 0)
    .sort((a, b) => rank[a.kind] - rank[b.kind] || a.tag.localeCompare(b.tag));
}
