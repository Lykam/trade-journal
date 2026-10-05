// Deterministic synthetic data for the public demo (SPEC §7, Q49). Nothing here
// is derived from real data: tickers, prices and timing are made up.
//
// - About six months of trading days ending at `now` (ET). Every random draw is
//   keyed by "trading days before the anchor date", so the same date gives the
//   same bundle and a later date shifts the same history forward.
// - It generates broker FILLS and derives trades and ideas with the real
//   buildTrades, so the demo exercises the real grouping, gauges and reports.
// - Nothing is dated after `now`.
// - The current week is scripted: a small search over the outcomes of the
//   trades the gauges look at makes Day show ½ (or ¼) size and Swing Full size.
import { addDays, dayOfWeek, etInstant, weekStart } from "../core/calendar";
import { computeGauge } from "../core/gauge/gauge";
import { assignIds, type RawFill } from "../core/normalize/ids";
import { compareFills } from "../core/normalize/dedupe";
import { cents, etDate, etOffset, round } from "../core/normalize/util";
import { buildTrades } from "../core/trades/grouping";
import type { Config, DataBundle, Fill, Overrides, Quote, QuotesFile, Trade } from "../core/types";
import { chartSvg, svgDataUrl, type Candle, type Marker } from "./charts";
import { Rng, seedOf } from "./prng";
import { demoReview } from "./reviews";
import { DAY_TICKERS, DEMO_SYMBOLS, SWING_TICKERS, type DemoTicker } from "./tickers";

export const DEMO_SEED = 20261004;
/** Trading days generated, oldest first, ending at the anchor date. */
export const TRADING_DAYS = 128;

export const DEMO_CONFIG: Config = {
  timezone: "America/New_York",
  weekStartsOn: "monday",
  accounts: ["schwab-main", "webull"],
  schwabAccounts: { "000": "schwab-main" },
  webullAccount: "webull",
  styleByAccount: { "schwab-main": "swing", webull: "day" },
  gauge: {
    baselineDays: 90,
    excludeCurrentWeekFromBaseline: true,
    minSample: { day: 5, swing: 3 },
    bands: { halfSizeBelowPts: 0, quarterSizeBelowPts: 10 },
    swingIncludesOpenPositions: true,
  },
};

export interface DemoData {
  bundle: DataBundle;
  /** Playbook image path → SVG data URL. */
  images: Record<string, string>;
}

// ---------------------------------------------------------------- calendar

/** Weekdays (holidays not modeled), oldest first, ending at the last weekday on or before `anchor`. */
export function tradingDays(anchor: string, n = TRADING_DAYS): string[] {
  const out: string[] = [];
  for (let d = anchor; out.length < n; d = addDays(d, -1)) if (dayOfWeek(d) % 6 !== 0) out.push(d);
  return out.reverse();
}

const hhmmss = (min: number) => {
  const s = Math.round(min * 60);
  return `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor(s / 60) % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};
// The ET offset never changes within trading hours (DST switches at 02:00), so one lookup per date.
const offsets = new Map<string, string>();
const offsetOf = (date: string) => {
  let o = offsets.get(date);
  if (!o) offsets.set(date, (o = etOffset(date, "12:00:00")));
  return o;
};
/** ISO time of `minutes` after midnight ET on `date`. */
const at = (date: string, minutes: number) => `${date}T${hhmmss(minutes)}${offsetOf(date)}`;
const OPEN_MIN = 9 * 60 + 30;
const CLOSE_MIN = 16 * 60;

// ---------------------------------------------------------------- prices

/** Daily closes per symbol, aligned with the trading days (index 0 = oldest). */
type Series = Map<string, number[]>;

function baseSeries(days: string[], tickers: DemoTicker[]): Series {
  const n = days.length;
  const out: Series = new Map();
  for (const t of tickers) {
    const closes: number[] = [];
    let p = t.start;
    for (let i = 0; i < n; i++) {
      const k = n - 1 - i;
      const r = new Rng(seedOf(DEMO_SEED, "walk", t.symbol, k));
      p = Math.max(0.5, p * (1 + t.vol * r.normal() * 0.8 + 0.0004));
      closes.push(p);
    }
    out.set(t.symbol, closes);
  }
  return out;
}

/** ETF closes from their underlying's daily returns, times leverage (negative for inverse). */
function etfSeries(series: Series): void {
  for (const [etf, info] of Object.entries(DEMO_SYMBOLS)) {
    const u = series.get(info.underlying);
    if (!u) continue;
    const mult = info.leverage * (info.direction === "inverse" ? -1 : 1);
    const out = [30];
    for (let i = 1; i < u.length; i++) out.push(Math.max(0.5, out[i - 1]! * (1 + mult * (u[i]! / u[i - 1]! - 1))));
    series.set(etf, out);
  }
}

const price2 = (p: number) => round(p, p < 1 ? 4 : 2);

// ---------------------------------------------------------------- plans

interface DayPlan {
  kind: "day";
  i: number;
  symbol: string;
  entryMin: number;
  exitMin: number;
  qty: number;
  entry: number;
  /** true = win, false = loss, null = breakeven. */
  win: boolean | null;
  mag: number;
  /** Sells half at `partialMin` first. */
  partialMin: number | null;
  /** Bought late and still held (the "held overnight" day trade). */
  overnight?: boolean;
}

interface SwingPlan {
  kind: "swing";
  start: number;
  /** Index of the exit day; null while open. */
  end: number | null;
  symbol: string;
  /** Day index of a later buy that adds half the size, and of a trim that sells a third. */
  add: { i: number } | null;
  trim: { i: number } | null;
  win: boolean;
  mag: number;
  buyFee: number;
  sellFee: number;
}

function dayPlans(days: string[], series: Series, nowMs: number): DayPlan[] {
  const n = days.length;
  const plans: DayPlan[] = [];
  for (let i = 0; i < n; i++) {
    const k = n - 1 - i;
    const r = new Rng(seedOf(DEMO_SEED, "day", k));
    const count = r.chance(0.9) ? r.pick([1, 2, 2, 2, 3, 3, 3]) : 0;
    let free = OPEN_MIN + r.range(1, 20);
    const busy = new Map<string, number>();
    for (let j = 0; j < count; j++) {
      const t = r.pick(DAY_TICKERS);
      const entryMin = Math.max(free, busy.get(t.symbol) ?? 0) + r.range(2, 60);
      const hold = Math.min(Math.exp(r.range(Math.log(2), Math.log(150))), CLOSE_MIN - 2 - entryMin);
      if (hold < 1) break;
      const exitMin = entryMin + hold;
      plans.push(dayPlan(r, i, t.symbol, entryMin, exitMin, series));
      busy.set(t.symbol, exitMin + 1);
      free = entryMin + r.range(5, 40);
    }
  }
  // One idea that mixes a stock and its ETF (SPEC §4.4): a day trade in NVQX, then NVQU.
  const mixed = n - 1 - 9;
  if (mixed >= 0) {
    const r = new Rng(seedOf(DEMO_SEED, "mixed"));
    plans.push(dayPlan(r, mixed, "NVQX", 10 * 60 + 5, 10 * 60 + 41, series), dayPlan(r, mixed, "NVQU", 11 * 60 + 20, 12 * 60 + 2, series));
  }
  // One day trade bought late on the previous trading day and still held: "held overnight".
  {
    const r = new Rng(seedOf(DEMO_SEED, "overnight"));
    const p = dayPlan(r, n - 2, "KRQN", 15 * 60 + 41, CLOSE_MIN, series);
    plans.push({ ...p, overnight: true, partialMin: null });
  }
  // Nothing after now: drop anything not finished (or, overnight, not bought) by then.
  return plans.filter((p) => Date.parse(at(days[p.i]!, p.overnight ? p.entryMin : p.exitMin)) < nowMs - 60_000);
}

function dayPlan(r: Rng, i: number, symbol: string, entryMin: number, exitMin: number, series: Series): DayPlan {
  const closes = series.get(symbol)!;
  const prev = closes[Math.max(0, i - 1)]!;
  const close = closes[i]!;
  const f = (entryMin - OPEN_MIN) / (CLOSE_MIN - OPEN_MIN);
  const entry = price2((prev + (close - prev) * f) * (1 + r.range(-0.01, 0.01)));
  const roll = r.next();
  const win = roll < 0.03 ? null : roll < 0.52;
  return {
    kind: "day", i, symbol, entryMin, exitMin, entry, win,
    qty: Math.max(5, Math.round(r.range(500, 1600) / entry / 5) * 5),
    mag: win ? r.range(0.006, 0.035) : r.range(0.005, 0.028),
    partialMin: r.chance(0.3) ? entryMin + (exitMin - entryMin) * r.range(0.3, 0.7) : null,
  };
}

const SWING_SYMBOLS = [...SWING_TICKERS.map((t) => t.symbol), "NVQU", "MZRU", "NVQD"];

function swingPlans(days: string[], nowMs: number): SwingPlan[] {
  const n = days.length;
  const plans: SwingPlan[] = [];
  const freeFrom = new Map<string, number>();
  const plan = (r: Rng, start: number, symbol: string, hold: number): SwingPlan => {
    const end = start + hold <= n - 1 ? start + hold : null;
    const span = (end ?? n - 1) - start;
    const win = r.chance(0.5);
    return {
      kind: "swing", start, end, symbol, win,
      mag: win ? r.range(0.05, 0.16) : r.range(0.02, 0.06),
      add: span >= 3 && r.chance(0.25) ? { i: start + r.int(1, span - 1) } : null,
      trim: span >= 4 && r.chance(0.3) ? { i: start + r.int(2, span - 1) } : null,
      buyFee: r.chance(0.12) ? 0.65 : 0,
      sellFee: cents(r.range(0.01, 0.06)),
    };
  };
  for (let i = 0; i < n; i++) {
    const r = new Rng(seedOf(DEMO_SEED, "swing", n - 1 - i));
    if (!r.chance(0.42)) continue;
    const free = SWING_SYMBOLS.filter((s) => (freeFrom.get(s) ?? 0) <= i);
    if (!free.length) continue;
    const p = plan(r, i, r.pick(free), r.int(2, 20));
    plans.push(p);
    freeFrom.set(p.symbol, (p.end ?? n) + 1);
  }
  // 6 open positions: open more on recent days, or close the oldest extras.
  const open = () => plans.filter((p) => p.end === null);
  for (let back = 1; open().length < 6 && back < 15; back += 2) {
    const i = n - 1 - back;
    const free = SWING_SYMBOLS.filter((s) => (freeFrom.get(s) ?? 0) <= i);
    if (!free.length) continue;
    const r = new Rng(seedOf(DEMO_SEED, "extra", back));
    const p = { ...plan(r, i, r.pick(free), 99), end: null };
    plans.push(p);
    freeFrom.set(p.symbol, n + 1);
  }
  for (const p of open().sort((a, b) => a.start - b.start).slice(0, Math.max(0, open().length - 7))) p.end = Math.min(n - 2, p.start + 3);
  // Schwab fills are date-only: none on today's date before the session opens.
  const today = days[n - 1]!;
  const tooEarly = nowMs < etInstant(today, "10:00:00");
  return plans
    .filter((p) => !(tooEarly && p.start === n - 1))
    .map((p) => ({
      ...p,
      end: tooEarly && p.end === n - 1 ? null : p.end,
      add: p.add && !(tooEarly && p.add.i === n - 1) ? p.add : null,
      trim: p.trim && !(tooEarly && p.trim.i === n - 1) ? p.trim : null,
    }))
    .sort((a, b) => a.start - b.start);
}

// ---------------------------------------------------------------- fills

/** `quick`: plain counters instead of hashed ids, for the gauge search (ids don't affect it). */
function webullFills(days: string[], plans: DayPlan[], quick = false): Fill[] {
  const raw: Array<RawFill & { placed: string }> = [];
  const push = (date: string, min: number, symbol: string, side: "buy" | "sell", qty: number, price: number) =>
    raw.push({
      broker: "webull", account: "webull", symbol, assetType: "equity", side, qty, price: price2(price), fees: 0,
      executedAt: at(date, min), timePrecision: "second", seq: 0, source: "", importedAt: "", placed: at(date, min - 0.05),
    });
  for (const p of plans) {
    const date = days[p.i]!;
    push(date, p.entryMin, p.symbol, "buy", p.qty, p.entry);
    if (p.overnight) continue;
    const sign = p.win === null ? 0 : p.win ? 1 : -1;
    const exit = p.entry * (1 + sign * p.mag);
    if (p.partialMin !== null && p.qty >= 10) {
      const half = Math.round(p.qty / 10) * 5;
      push(date, p.partialMin, p.symbol, "sell", half, p.entry * (1 + sign * p.mag * 0.6));
      push(date, p.exitMin, p.symbol, "sell", p.qty - half, exit);
    } else {
      push(date, p.exitMin, p.symbol, "sell", p.qty, exit);
    }
  }
  raw.sort((a, b) => Date.parse(a.executedAt) - Date.parse(b.executedAt));
  const fills = raw.map(({ placed: _p, ...f }) => f);
  return quick ? fills.map((f, j) => ({ id: `wb-q${j}`, ...f })) : assignIds(fills, raw.map((f) => f.placed));
}

/** Fills and the final avg cost of each open swing plan (for its quote). */
function schwabFills(days: string[], plans: SwingPlan[], series: Series, quick = false): { fills: Fill[]; avgCost: Map<SwingPlan, number> } {
  const raw: RawFill[] = [];
  const seq = new Map<string, number>();
  const push = (i: number, symbol: string, side: "buy" | "sell", qty: number, price: number, fees: number) => {
    const date = days[i]!;
    const s = seq.get(date) ?? 0;
    seq.set(date, s + 1);
    raw.push({
      broker: "schwab", account: "schwab-main", symbol, assetType: "equity", side, qty, price: price2(price), fees,
      executedAt: `${date}T00:00:00${offsetOf(date)}`, timePrecision: "day", seq: s, source: "", importedAt: "",
    });
  };
  const avgCost = new Map<SwingPlan, number>();
  // Day by day, so seq follows the order fills happen within a date.
  const events: Array<{ i: number; order: number; run: () => void }> = [];
  for (const p of plans) {
    const closes = series.get(p.symbol)!;
    const entry = price2(closes[p.start]!);
    const qty = Math.max(1, Math.round(new Rng(seedOf(DEMO_SEED, "qty", p.symbol, p.start)).range(1000, 3000) / entry));
    let shares = qty;
    let cost = entry;
    events.push({ i: p.start, order: 0, run: () => push(p.start, p.symbol, "buy", qty, entry, p.buyFee) });
    if (p.add) {
      const addPrice = price2(closes[p.add.i]!);
      const addQty = Math.max(1, Math.round(qty / 2));
      cost = (cost * shares + addPrice * addQty) / (shares + addQty);
      shares += addQty;
      const a = p.add;
      events.push({ i: a.i, order: 0, run: () => push(a.i, p.symbol, "buy", addQty, addPrice, 0) });
    }
    const sign = p.win ? 1 : -1;
    if (p.trim && shares >= 2) {
      const t = p.trim;
      const trimQty = Math.floor(shares / 3) || 1;
      shares -= trimQty;
      const c = cost;
      events.push({ i: t.i, order: 1, run: () => push(t.i, p.symbol, "sell", trimQty, c * (1 + sign * p.mag * 0.5), p.sellFee) });
    }
    if (p.end !== null) {
      const e = p.end;
      const c = cost;
      const left = shares;
      events.push({ i: e, order: 1, run: () => push(e, p.symbol, "sell", left, c * (1 + sign * p.mag), p.sellFee) });
    } else {
      avgCost.set(p, cost);
    }
  }
  events.sort((a, b) => a.i - b.i || a.order - b.order).forEach((e) => e.run());
  return { fills: quick ? raw.map((f, j) => ({ id: `sc-q${j}`, ...f })) : assignIds(raw), avgCost };
}

// ---------------------------------------------------------------- quotes

/** When prices were last fetched: a few minutes ago in a session, else the last close. */
function quotesAsOf(nowMs: number): string {
  const today = etDate(new Date(nowMs).toISOString());
  const weekday = dayOfWeek(today) % 6 !== 0;
  if (weekday && nowMs >= etInstant(today, "09:40:00") && nowMs <= etInstant(today, "16:00:00")) return new Date(nowMs - 6 * 60_000).toISOString();
  let d = today;
  while (dayOfWeek(d) % 6 === 0 || etInstant(d, "16:00:00") > nowMs) d = addDays(d, -1);
  return new Date(etInstant(d, "16:00:00")).toISOString();
}

function quotesFor(trades: Trade[], swing: SwingPlan[], avgCost: Map<SwingPlan, number>, asOf: string): QuotesFile {
  const quotes: Record<string, Quote> = {};
  const open = trades.filter((t) => t.status === "open");
  for (const t of open) {
    const plan = swing.find((p) => p.end === null && p.symbol === t.symbol && t.account === "schwab-main");
    const base = plan ? avgCost.get(plan)! * (1 + (plan.win ? 1 : -1) * plan.mag * 0.7) : t.avgCost * 1.02;
    quotes[t.symbol] = { price: price2(base), time: asOf, marketState: "REGULAR" };
  }
  // One quote carried over from a failed fetch.
  const staleSym = open.find((t) => t.account === "schwab-main")?.symbol;
  if (staleSym) quotes[staleSym] = { ...quotes[staleSym]!, time: new Date(Date.parse(asOf) - 26 * 3600_000).toISOString(), stale: true };
  return { asOf, attemptedAt: asOf, quotes };
}

// ---------------------------------------------------------------- scripted gauges

function grouped(fills: Fill[], overrides: Overrides = { trades: {}, openingPositions: [] }) {
  return buildTrades([...fills].sort(compareFills), { config: DEMO_CONFIG, symbols: DEMO_SYMBOLS, overrides });
}

/**
 * Set the outcomes of `zone`, in its fixed shuffled order: the first `be` are
 * breakevens (when allowed), the next w win, the rest lose. Picks the first
 * assignment, w nearest to `ideal` × decisive, whose gauge state is the first of
 * `want` reached. Breakevens change the denominator, so a band between two
 * win counts can still be hit.
 */
function script<P extends { win: boolean | null }>(zone: P[], ideal: number, want: string[], maxBreakeven: number, stateFor: () => string | null): void {
  const set = (be: number, w: number) => zone.forEach((p, j) => (p.win = j < be ? null : j < be + w));
  for (const target of want) {
    for (let be = 0; be <= maxBreakeven; be++) {
      const n = zone.length - be;
      const order = [...Array(n + 1).keys()].sort((a, b) => Math.abs(a - ideal * n) - Math.abs(b - ideal * n) || a - b);
      for (const w of order) {
        set(be, w);
        if (stateFor() === target) return;
      }
    }
  }
  set(0, Math.round(ideal * zone.length));
}

function scriptGauges(days: string[], now: string, day: DayPlan[], swing: SwingPlan[], series: Series) {
  const weekFirst = days.findIndex((d) => d >= weekStart(days[days.length - 1]!));
  const shuffle = <T>(xs: T[], key: string) => {
    const r = new Rng(seedOf(DEMO_SEED, key));
    return xs.map((x) => ({ x, k: r.next() })).sort((a, b) => a.k - b.k).map((o) => o.x);
  };

  // Day: this week's day trades plus the 8 latest before it (the backfill), aiming at ½ size.
  const closedDay = day.filter((p) => !p.overnight).sort((a, b) => a.i - b.i || a.exitMin - b.exitMin);
  const thisWeek = closedDay.filter((p) => p.i >= weekFirst);
  // This week's trades first, so breakevens change the window's denominator rather than the backfill's.
  const dayZone = [...shuffle(thisWeek, "zone-day"), ...shuffle(closedDay.filter((p) => p.i < weekFirst).slice(-8), "zone-day-prior")];
  script(dayZone, 0.5, ["half", "quarter"], 2, () => {
    const { trades } = grouped(webullFills(days, day, true));
    return computeGauge("day", { trades, config: DEMO_CONFIG, now }).state;
  });

  // Swing: closed this week, open now, and the 4 latest closed before the week, aiming at Full size.
  const swingZone = shuffle(
    [...swing.filter((p) => p.end === null || p.end >= weekFirst), ...swing.filter((p) => p.end !== null && p.end < weekFirst).slice(-4)],
    "zone-swing",
  );
  script(swingZone, 0.65, ["full"], 0, () => {
    const { fills, avgCost } = schwabFills(days, swing, series, true);
    const { trades } = grouped(fills);
    const q = quotesFor(trades, swing, avgCost, quotesAsOf(Date.parse(now)));
    return computeGauge("swing", { trades, config: DEMO_CONFIG, now, quotes: q.quotes }).state;
  });
}

// ---------------------------------------------------------------- overrides

const TAGS = ["gap-and-go", "news", "A+ setup", "chased", "oversized", "late-entry"];
const NOTES = ["Demo note: sized down after two losses.", "Demo note: entry on the first pullback.", "Demo note: exit at the planned target."];

/** Manual edits on trades older than the gauges' 90-day baseline, so they don't move the scripted gauges. */
function demoOverrides(trades: Trade[], cutoff: string): Overrides {
  const old = trades.filter((t) => t.status === "closed" && etDate(t.closedAt!) < cutoff);
  const day = old.filter((t) => t.account === "webull");
  const swing = old.filter((t) => t.account === "schwab-main");
  const r = new Rng(seedOf(DEMO_SEED, "overrides"));
  const out: Overrides = { trades: {}, openingPositions: [] };
  const take = (list: Trade[]) => {
    for (let tries = 0; tries < 50; tries++) {
      const t = r.pick(list);
      if (!out.trades[t.id]) return t;
    }
    return list[0]!;
  };
  TAGS.forEach((tag, j) => {
    for (let c = 0; c < 2 + (j % 3); c++) {
      const t = take(j % 2 ? swing : day);
      out.trades[t.id] = { ...out.trades[t.id], tags: [...(out.trades[t.id]?.tags ?? []), tag] };
    }
  });
  for (const note of NOTES) out.trades[take(day).id] = { note };
  out.trades[take(day).id] = { exclude: true };
  out.trades[take(swing).id] = { style: "day" };
  return out;
}

// ---------------------------------------------------------------- charts

function dailyCandles(series: Series, symbol: string, upto: number, n = 40): Candle[] {
  const closes = series.get(symbol)!;
  const r = new Rng(seedOf(DEMO_SEED, "candles", symbol, upto));
  const out: Candle[] = [];
  for (let i = Math.max(1, upto - n + 1); i <= upto; i++) {
    const o = closes[i - 1]! * (1 + r.range(-0.01, 0.01));
    const c = closes[i]!;
    out.push({ o, c, h: Math.max(o, c) * (1 + r.range(0.002, 0.02)), l: Math.min(o, c) * (1 - r.range(0.002, 0.02)) });
  }
  return out;
}

/** 5-minute candles that pass through the given fill prices (a random bridge between them). */
function intradayCandles(seed: number, open: number, close: number, points: Array<{ min: number; price: number }>): Candle[] {
  const r = new Rng(seed);
  const anchors = [{ min: OPEN_MIN, price: open }, ...points.sort((a, b) => a.min - b.min), { min: CLOSE_MIN, price: close }];
  const out: Candle[] = [];
  for (let m = OPEN_MIN; m < CLOSE_MIN; m += 5) {
    const level = (x: number) => {
      const j = Math.max(0, anchors.findIndex((a) => a.min > x) - 1);
      const a = anchors[j]!;
      const b = anchors[Math.min(j + 1, anchors.length - 1)]!;
      const f = b.min === a.min ? 0 : (x - a.min) / (b.min - a.min);
      return a.price + (b.price - a.price) * f;
    };
    const o = level(m) * (1 + r.range(-0.003, 0.003));
    const c = level(m + 5) * (1 + r.range(-0.003, 0.003));
    out.push({ o, c, h: Math.max(o, c) * (1 + r.range(0, 0.004)), l: Math.min(o, c) * (1 - r.range(0, 0.004)) });
  }
  return out;
}

// ---------------------------------------------------------------- bundle

/** The whole demo data set as of `now` (ISO). */
export function generateDemo(now: string): DemoData {
  const nowMs = Date.parse(now);
  const anchor = etDate(now);
  const days = tradingDays(anchor);
  const series = baseSeries(days, [...DAY_TICKERS, ...SWING_TICKERS]);
  etfSeries(series);

  const day = dayPlans(days, series, nowMs);
  const swing = swingPlans(days, nowMs);
  scriptGauges(days, now, day, swing, series);

  const wb = webullFills(days, day);
  const { fills: sc, avgCost } = schwabFills(days, swing, series);
  const fills = [...wb, ...sc].sort(compareFills);
  const plain = grouped(fills);
  const overrides = demoOverrides(plain.trades, addDays(weekStart(anchor), -100));
  const { trades, ideas } = grouped(fills, overrides);
  const quotes = quotesFor(trades, swing, avgCost, quotesAsOf(nowMs));

  // Reviews and charts.
  const images: Record<string, string> = {};
  const reviews = pickReviewIdeas(ideas, trades, anchor).map(({ idea, status }, j) => {
    const ideaTrades = trades.filter((t) => t.ideaId === idea.id);
    const charts: string[] = [];
    const u = idea.underlying;
    const di = days.indexOf(idea.date);
    const own = ideaTrades.filter((t) => t.symbol === u);
    const lastI = Math.max(di, ...own.map((t) => days.indexOf(etDate(t.closedAt ?? now))));
    const candles = dailyCandles(series, u, Math.min(days.length - 1, lastI + 2));
    const firstI = Math.min(days.length - 1, lastI + 2) - candles.length + 1;
    const markers: Marker[] = fills
      .filter((f) => ideaTrades.some((t) => t.fillIds.includes(f.id)) && f.symbol === u)
      .map((f) => ({ x: days.indexOf(etDate(f.executedAt)) - firstI, price: f.price, side: f.side }));
    const daily = `Images/${idea.date}/${u}-daily.png`;
    images[daily] = svgDataUrl(chartSvg(candles, markers, `${u} · DAILY · DEMO`));
    charts.push(daily);
    if (idea.style === "day") {
      const dayFills = fills.filter((f) => f.symbol === u && etDate(f.executedAt) === idea.date && f.account === "webull");
      const toMin = (iso: string) => (Date.parse(iso) - etInstant(idea.date)) / 60_000;
      const closes = series.get(u)!;
      const ic = intradayCandles(seedOf(DEMO_SEED, "intraday", u, idea.date), closes[Math.max(0, di - 1)]!, closes[di]!, dayFills.map((f) => ({ min: toMin(f.executedAt), price: f.price })));
      const im = dayFills.map((f) => ({ x: Math.floor((toMin(f.executedAt) - OPEN_MIN) / 5), price: f.price, side: f.side }));
      const intraday = `Images/${idea.date}/${u}-intraday.png`;
      images[intraday] = svgDataUrl(chartSvg(ic, im, `${u} · 5 MIN · DEMO`));
      charts.push(intraday);
    }
    return demoReview(idea, status, j, charts);
  });

  const bundle: DataBundle = {
    config: DEMO_CONFIG,
    symbols: DEMO_SYMBOLS,
    derived: { generated: true, generator: "trade-journal demo", trades, ideas },
    fills,
    overrides,
    quotes,
    playbook: { reviews, images: Object.keys(images).sort() },
    loadedAt: now,
    history: null,
  };
  return { bundle, images };
}

/** 9 ideas to review: day and swing, closed and open, one OPEN review on a closed swing idea, the mixed stock/ETF idea. */
function pickReviewIdeas(ideas: DataBundle["derived"]["ideas"], trades: Trade[], anchor: string) {
  const r = new Rng(seedOf(DEMO_SEED, "reviews"));
  const recent = ideas.filter((i) => i.date >= addDays(anchor, -75) && i.date < anchor).sort((a, b) => a.date.localeCompare(b.date));
  const picked: Array<{ idea: (typeof ideas)[number]; status: "OPEN" | "CLOSED" }> = [];
  const add = (idea: (typeof ideas)[number] | undefined, status: "OPEN" | "CLOSED") => {
    if (idea && !picked.some((p) => p.idea.id === idea.id || (p.idea.date === idea.date && p.idea.underlying === idea.underlying))) picked.push({ idea, status });
  };
  add(recent.find((i) => i.style === "day" && i.usedEtf), "CLOSED");
  const day = recent.filter((i) => i.style === "day" && i.status === "closed" && trades.some((t) => t.ideaId === i.id && t.symbol === i.underlying));
  for (let j = 0; j < 5; j++) add(day[Math.floor(((j + r.next()) / 5) * day.length)], "CLOSED");
  const swingClosed = recent.filter((i) => i.style === "swing" && i.status === "closed" && SWING_TICKERS.some((t) => t.symbol === i.underlying));
  add(swingClosed[Math.floor(swingClosed.length * 0.3)], "CLOSED");
  add(swingClosed[Math.floor(swingClosed.length * 0.7)], "OPEN"); // the exit sections still to write
  add(ideas.find((i) => i.style === "swing" && i.status === "open" && SWING_TICKERS.some((t) => t.symbol === i.underlying)), "OPEN");
  return picked;
}
