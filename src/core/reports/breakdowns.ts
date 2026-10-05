// Breakdown sub-tabs under the Detailed grid (SPEC §6.5): P&L per group, with
// win rate, count and expectancy for the hover text.
import { dayOfWeek } from "../calendar";
import { mean, sum } from "./math";
import { valueOf, type Unit, type ValueOpts } from "./units";

export interface Bucket {
  key: string;
  label: string;
  count: number;
  wins: number;
  losses: number;
  winRate: number | null;
  total: number;
  /** Mean value per unit (breakevens included). */
  avg: number | null;
  /** Per decisive unit, as in the grid. */
  expectancy: number | null;
}

export function bucketOf(key: string, label: string, units: Unit[], o: ValueOpts): Bucket {
  const wins = units.filter((u) => u.result === "win");
  const losses = units.filter((u) => u.result === "loss");
  const winRate = wins.length + losses.length ? wins.length / (wins.length + losses.length) : null;
  const vals = units.map((u) => valueOf(u, o));
  const avgW = mean(wins.map((u) => valueOf(u, o)));
  const avgL = mean(losses.map((u) => valueOf(u, o)));
  return {
    key, label, count: units.length, wins: wins.length, losses: losses.length, winRate,
    total: sum(vals), avg: mean(vals),
    expectancy: winRate === null ? null : winRate * (avgW ?? 0) + (1 - winRate) * (avgL ?? 0),
  };
}

/** Group units by key; `order` fixes the order (and labels) of known keys, others follow sorted. */
export function groupBy(units: Unit[], keyOf: (u: Unit) => string | null, o: ValueOpts, order?: Array<[string, string]>): Bucket[] {
  const by = new Map<string, Unit[]>();
  for (const u of units) {
    const k = keyOf(u);
    if (k !== null) by.set(k, [...(by.get(k) ?? []), u]);
  }
  const known = (order ?? []).filter(([k]) => by.has(k)).map(([k, label]) => bucketOf(k, label, by.get(k)!, o));
  const rest = [...by.keys()].filter((k) => !order?.some(([x]) => x === k)).sort().map((k) => bucketOf(k, k, by.get(k)!, o));
  return [...known, ...rest];
}

// ---------------------------------------------------------------- days / times

const DOW = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

export function byDayOfWeek(units: Unit[], o: ValueOpts): Bucket[] {
  // Monday first; weekend days only appear when something closed on them.
  return groupBy(units, (u) => String(dayOfWeek(u.date)), o, [1, 2, 3, 4, 5, 6, 0].map((d) => [String(d), DOW[d]!]));
}

/** Entry hour (ET) of timed trades; date-only (Schwab) units are counted, not placed. */
export function byHour(units: Unit[], o: ValueOpts): { buckets: Bucket[]; untimed: number } {
  const order = Array.from({ length: 24 }, (_, h): [string, string] => [String(h).padStart(2, "0"), `${String(h).padStart(2, "0")}:00`]);
  return {
    buckets: groupBy(units, (u) => (u.entryHour === null ? null : String(u.entryHour).padStart(2, "0")), o, order),
    untimed: units.filter((u) => u.entryHour === null).length,
  };
}

export function byMonth(units: Unit[], o: ValueOpts): Bucket[] {
  return groupBy(units, (u) => u.date.slice(0, 7), o).map((b) => ({ ...b, label: `${MONTHS[Number(b.key.slice(5)) - 1]} ${b.key.slice(0, 4)}` }));
}

// ---------------------------------------------------------------- price / volume

/** Lower edges; a value goes in the last edge it reaches. */
export function edgeBuckets(edges: number[], fmt: (n: number) => string): { keyOf: (v: number) => string; order: Array<[string, string]> } {
  const label = (i: number) => (i === edges.length - 1 ? `${fmt(edges[i]!)}+` : `${fmt(edges[i]!)}–${fmt(edges[i + 1]!)}`);
  const order = edges.map((_, i): [string, string] => [String(i).padStart(2, "0"), i === 0 ? `< ${fmt(edges[1]!)}` : label(i)]);
  return {
    keyOf: (v) => {
      let i = 0;
      while (i + 1 < edges.length && v >= edges[i + 1]!) i++;
      return String(i).padStart(2, "0");
    },
    order,
  };
}

const usd = (n: number) => (n >= 1000 ? `$${n / 1000}k` : `$${n}`);
export const PRICE_EDGES = [0, 2, 5, 10, 20, 50, 100, 200, 500];
export const SHARE_EDGES = [0, 2, 6, 11, 26, 51, 101, 501];
export const COST_EDGES = [0, 100, 250, 500, 1000, 2500, 5000, 10000, 25000];

export function byEntryPrice(units: Unit[], o: ValueOpts): Bucket[] {
  const b = edgeBuckets(PRICE_EDGES, usd);
  return groupBy(units, (u) => b.keyOf(u.entryPrice), o, b.order);
}

/** Position size in shares bought (an idea sums its trades). */
export function byShares(units: Unit[], o: ValueOpts): Bucket[] {
  const b = edgeBuckets(SHARE_EDGES, String);
  // Shares are normally whole, so label inclusive ranges: < 2, 2–5, 6–10, …
  const order = b.order.map(([k], i): [string, string] =>
    [k, i === 0 ? "< 2" : i === SHARE_EDGES.length - 1 ? `${SHARE_EDGES[i]}+` : `${SHARE_EDGES[i]}–${SHARE_EDGES[i + 1]! - 1}`]);
  return groupBy(units, (u) => b.keyOf(u.shares), o, order);
}

/** Position size in dollars bought. */
export function byCost(units: Unit[], o: ValueOpts): Bucket[] {
  const b = edgeBuckets(COST_EDGES, usd);
  return groupBy(units, (u) => b.keyOf(u.cost), o, b.order);
}

// ---------------------------------------------------------------- instrument

const byTotalDesc = (a: Bucket, b: Bucket) => b.total - a.total || a.key.localeCompare(b.key);

/** Best and worst groups by total; with 40 or fewer groups the two lists share none. */
export function topBottom(buckets: Bucket[], n = 20): { top: Bucket[]; bottom: Bucket[] } {
  const sorted = [...buckets].sort(byTotalDesc);
  const top = sorted.slice(0, Math.min(n, Math.ceil(sorted.length / 2)));
  const bottom = sorted.slice(top.length).reverse().slice(0, n);
  return { top, bottom };
}

export const bySymbol = (units: Unit[], o: ValueOpts) => groupBy(units, (u) => u.symbol, o);
export const byUnderlying = (units: Unit[], o: ValueOpts) => groupBy(units, (u) => u.underlying, o);

const INSTRUMENTS: Array<[string, string]> = [["stock", "STOCK"], ["leveraged_etf", "ETF"], ["mixed", "STOCK + ETF"]];
export const byInstrument = (units: Unit[], o: ValueOpts) => groupBy(units, (u) => u.instrument, o, INSTRUMENTS);

export interface SameUnderlying {
  underlying: string;
  stock: Bucket;
  etf: Bucket;
  /** Idea view only: ideas that used both. */
  mixed: Bucket | null;
}

/** Each underlying traded both as the stock and through a single-stock ETF, side by side. */
export function sameUnderlying(units: Unit[], o: ValueOpts): SameUnderlying[] {
  const by = new Map<string, Unit[]>();
  for (const u of units) by.set(u.underlying, [...(by.get(u.underlying) ?? []), u]);
  const out: SameUnderlying[] = [];
  for (const [underlying, us] of by) {
    const stock = us.filter((u) => u.instrument === "stock");
    const etf = us.filter((u) => u.instrument === "leveraged_etf");
    const mixed = us.filter((u) => u.instrument === "mixed");
    if (!(stock.length && etf.length) && !mixed.length) continue;
    out.push({
      underlying,
      stock: bucketOf("stock", "STOCK", stock, o),
      etf: bucketOf("leveraged_etf", "ETF", etf, o),
      mixed: mixed.length ? bucketOf("mixed", "STOCK + ETF", mixed, o) : null,
    });
  }
  return out.sort((a, b) => a.underlying.localeCompare(b.underlying));
}

// ---------------------------------------------------------------- win / loss / expectation

export const byStyle = (units: Unit[], o: ValueOpts) => groupBy(units, (u) => u.style, o, [["day", "DAY"], ["swing", "SWING"]]);
export const byBroker = (units: Unit[], o: ValueOpts) =>
  groupBy(units, (u) => u.broker, o, [["schwab", "SCHWAB"], ["webull", "WEBULL"], ["both", "BOTH"]]);

/** A "nice" step (1, 2, 2.5 or 5 × 10ⁿ) that splits `span` into about `bins` parts. */
export function niceStep(span: number, bins: number): number {
  if (!(span > 0)) return 1;
  const raw = span / bins;
  const p = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw)!;
}

export interface HistBin {
  /** [from, to): a value equal to `to` goes in the next bin. */
  from: number;
  to: number;
  count: number;
  wins: number;
  losses: number;
}

/** Distribution of unit values in equal bins whose edges are multiples of a nice step (so 0 is an edge). */
export function distribution(units: Unit[], o: ValueOpts, bins = 12): { step: number; bins: HistBin[] } {
  const vals = units.map((u) => valueOf(u, o));
  if (!vals.length) return { step: 0, bins: [] };
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const step = niceStep(hi - lo, bins);
  const start = Math.floor(lo / step + 1e-9);
  const end = Math.floor(hi / step + 1e-9);
  const out: HistBin[] = Array.from({ length: end - start + 1 }, (_, i) => ({ from: (start + i) * step, to: (start + i + 1) * step, count: 0, wins: 0, losses: 0 }));
  units.forEach((u, i) => {
    const b = out[Math.floor(vals[i]! / step + 1e-9) - start]!;
    b.count++;
    if (u.result === "win") b.wins++;
    if (u.result === "loss") b.losses++;
  });
  return { step, bins: out };
}
