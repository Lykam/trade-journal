// Weekly temperature gauges (SPEC §5). Pure: every input, including "now", is a parameter.
import { addDays, sessionsBetween, weekStart } from "../calendar";
import { cents, etDate, round } from "../normalize/util";
import { byCloseDesc, isScored, markToMarket } from "../trades/stats";
import type { Config, Quote, Style, Trade, TradeResult } from "../types";

/** Baselines with fewer decisive trades than this get a low-confidence note (SPEC §5.3). */
export const LOW_CONFIDENCE_BELOW = 20;
export const SPARKLINE_WEEKS = 8;

export type SizeState = "full" | "half" | "quarter";

/** An open position as it stood at some instant, rebuilt from the trade's events. */
export interface PositionAt {
  shares: number;
  avgCost: number;
  realized: number;
}

export interface QuoteStatus extends Quote {
  /** Older than one trading session, or carried over after a failed fetch. */
  isStale: boolean;
}

export interface WindowItem {
  trade: Trade;
  /** "week" = closed this week, "open" = open swing position marked to market, "prior" = backfill. */
  source: "week" | "open" | "prior";
  /** Score: realized net P&L, or realized + unrealized for open positions. */
  pnl: number;
  result: TradeResult;
  realized: number;
  unrealized: number;
  quote?: QuoteStatus;
}

export interface WindowStats {
  wins: number;
  losses: number;
  breakevens: number;
  /** Swing: the W/L split between closed and open positions. */
  closed: { wins: number; losses: number };
  open: { wins: number; losses: number };
  winRate: number | null;
  realized: number;
  unrealized: number;
  net: number;
  avgWin: number | null;
  avgLoss: number | null;
  /** Gross wins ÷ |gross losses|; null when there are no losses. */
  profitFactor: number | null;
  /** Mean P&L per decisive (W/L) trade. */
  expectancy: number | null;
}

export interface Baseline {
  from: string;
  to: string;
  wins: number;
  losses: number;
  breakevens: number;
  winRate: number | null;
  lowConfidence: boolean;
}

export interface SparkPoint {
  weekStart: string;
  wins: number;
  losses: number;
  winRate: number | null;
  current: boolean;
}

export interface Gauge {
  style: Style;
  now: string;
  week: { start: string; end: string };
  items: WindowItem[];
  counts: { week: number; open: number; prior: number };
  /** e.g. "3 this week + 2 prior" or "2 closed + 3 open". */
  label: string;
  stats: WindowStats;
  baseline: Baseline;
  /** windowWinRate − baselineWinRate in percentage points. */
  delta: number | null;
  state: SizeState | null;
  message: string;
  /** Open swing positions left out because they have no quote. */
  unpriced: Trade[];
  /** Open swing positions priced with a stale quote (still counted). */
  stale: Trade[];
  /** Latest quote time used, for "prices as of HH:MM ET". */
  pricesAsOf: string | null;
  sparkline: SparkPoint[];
}

export interface GaugeInput {
  trades: Trade[];
  config: Config;
  now: string;
  quotes?: Record<string, Quote>;
}

const scoreOf = (pnl: number): TradeResult => (pnl > 0 ? "win" : pnl < 0 ? "loss" : "breakeven");
const decisive = (r: TradeResult | null) => r === "win" || r === "loss";

/** Rebuild the position at `now` from events (adds re-average cost; trims realize). */
export function positionAt(t: Trade, now: string): PositionAt {
  const at = Date.parse(now);
  if (t.status === "open" && t.events.every((e) => Date.parse(e.at) <= at)) {
    return { shares: t.openQty, avgCost: t.avgCost, realized: t.realizedPnl };
  }
  let shares = 0;
  let avgCost = 0;
  let realized = 0;
  for (const e of t.events) {
    if (Date.parse(e.at) > at) break;
    if (e.kind === "open" || e.kind === "add") {
      avgCost = (avgCost * shares + e.price * e.qty) / (shares + e.qty);
      shares = round(shares + e.qty, 6);
      realized -= e.fees ?? 0;
    } else {
      shares = round(Math.max(0, shares - e.qty), 6);
      realized += e.realized ?? 0;
    }
  }
  return { shares, avgCost: round(avgCost, 6), realized: cents(realized) };
}

/** Open as of `now`: opened by then and not yet closed by then. */
export function isOpenAt(t: Trade, now: string): boolean {
  const at = Date.parse(now);
  if (t.status === "unmatched" || Date.parse(t.openedAt) > at) return false;
  return t.closedAt === null ? t.status === "open" : Date.parse(t.closedAt) > at;
}

/** Closed and scored by `now` (later closes are invisible to a gauge computed at `now`). */
const closedBy = (t: Trade, now: string) => isScored(t) && t.closedAt !== null && Date.parse(t.closedAt) <= Date.parse(now);

export function quoteStatus(q: Quote, now: string): QuoteStatus {
  return { ...q, isStale: q.stale === true || sessionsBetween(q.time, now) >= 1 };
}

/** Mark an open position to a quote. Uses the trade's own fields when the position is current. */
function markAt(t: Trade, now: string, price: number) {
  const p = positionAt(t, now);
  if (p.shares === t.openQty && p.avgCost === t.avgCost && p.realized === t.realizedPnl) {
    const m = markToMarket(t, price);
    return { unrealized: m.unrealized, realized: m.realized };
  }
  return { unrealized: cents((price - p.avgCost) * p.shares), realized: p.realized };
}

/** Full / ½ / ¼ from Δ in points, using the configured bands (SPEC §5.3). */
export function sizeState(delta: number, bands: Config["gauge"]["bands"]): SizeState {
  const d = round(delta, 6); // 0.5 − 0.6 must be exactly −10, not −9.999…
  if (d >= -bands.halfSizeBelowPts) return "full";
  if (d >= -bands.quarterSizeBelowPts) return "half";
  return "quarter";
}

const MESSAGES: Record<SizeState, string> = {
  // Sizes are spelled out: at body size "½" reads as "%" in JetBrains Mono (#13). The glyphs stay in the big headline.
  full: "At or above your average.",
  half: "Below your average: trade half size.",
  quarter: "Well below your average: trade quarter size.",
};

export function windowStats(items: WindowItem[]): WindowStats {
  const wins = items.filter((i) => i.result === "win");
  const losses = items.filter((i) => i.result === "loss");
  const sum = (xs: WindowItem[]) => xs.reduce((s, i) => s + i.pnl, 0);
  const grossWin = sum(wins);
  const grossLoss = sum(losses);
  const n = wins.length + losses.length;
  const split = (open: boolean) => ({
    wins: wins.filter((i) => (i.source === "open") === open).length,
    losses: losses.filter((i) => (i.source === "open") === open).length,
  });
  return {
    wins: wins.length,
    losses: losses.length,
    breakevens: items.filter((i) => i.result === "breakeven").length,
    closed: split(false),
    open: split(true),
    winRate: n ? wins.length / n : null,
    realized: cents(items.reduce((s, i) => s + i.realized, 0)),
    unrealized: cents(items.reduce((s, i) => s + i.unrealized, 0)),
    net: cents(sum(items)),
    avgWin: wins.length ? cents(grossWin / wins.length) : null,
    avgLoss: losses.length ? cents(grossLoss / losses.length) : null,
    profitFactor: losses.length ? round(grossWin / Math.abs(grossLoss), 2) : null,
    expectancy: n ? cents((grossWin + grossLoss) / n) : null,
  };
}

function winRateOf(trades: Trade[]) {
  const wins = trades.filter((t) => t.result === "win").length;
  const losses = trades.filter((t) => t.result === "loss").length;
  return {
    wins,
    losses,
    breakevens: trades.filter((t) => t.result === "breakeven").length,
    winRate: wins + losses ? wins / (wins + losses) : null,
  };
}

export function computeGauge(style: Style, input: GaugeInput): Gauge {
  const { config, now } = input;
  const g = config.gauge;
  const quotes = input.quotes ?? {};
  const today = etDate(now);
  const start = weekStart(today, config.weekStartsOn);
  const end = addDays(start, 6);
  const mine = input.trades.filter((t) => t.style === style && !t.excluded);
  const closed = mine.filter((t) => closedBy(t, now));
  const closedOn = (t: Trade) => etDate(t.closedAt!);

  const closedItem = (t: Trade, source: "week" | "prior"): WindowItem => ({
    trade: t, source, pnl: t.netPnl, result: t.result!, realized: t.netPnl, unrealized: 0,
  });

  // 1. Closed this week.
  const items: WindowItem[] = closed.filter((t) => closedOn(t) >= start && closedOn(t) <= end).map((t) => closedItem(t, "week"));

  // 2. Swing: every position open at `now`, marked to market.
  const unpriced: Trade[] = [];
  const stale: Trade[] = [];
  let pricesAsOf: string | null = null;
  if (style === "swing" && g.swingIncludesOpenPositions) {
    for (const t of mine.filter((t) => isOpenAt(t, now))) {
      const q = quotes[t.symbol]; // the symbol actually held, never the underlying
      if (!q) {
        unpriced.push(t);
        continue;
      }
      const status = quoteStatus(q, now);
      if (status.isStale) stale.push(t);
      if (!pricesAsOf || Date.parse(q.time) > Date.parse(pricesAsOf)) pricesAsOf = q.time;
      const m = markAt(t, now, q.price);
      const pnl = cents(m.unrealized + m.realized);
      items.push({ trade: t, source: "open", pnl, result: scoreOf(pnl), realized: m.realized, unrealized: m.unrealized, quote: status });
    }
  }

  // 3. Backfill with the most recent earlier closed trades until the window has
  //    minSample decisive (W/L) trades. Breakevens don't count toward the minimum.
  const min = g.minSample[style];
  let have = items.filter((i) => decisive(i.result)).length;
  for (const t of byCloseDesc(closed.filter((t) => closedOn(t) < start))) {
    if (have >= min) break;
    items.push(closedItem(t, "prior"));
    if (decisive(t.result)) have++;
  }

  const count = (s: WindowItem["source"]) => items.filter((i) => i.source === s && decisive(i.result)).length;
  const counts = { week: count("week"), open: count("open"), prior: count("prior") };
  const parts =
    style === "swing" && g.swingIncludesOpenPositions
      ? [`${counts.week} closed`, `${counts.open} open`]
      : [`${counts.week} this week`];
  if (counts.prior) parts.push(`${counts.prior} prior`);

  // Baseline: closed trades in the baselineDays up to today (or, with
  // excludeCurrentWeekFromBaseline, before this week; Q73).
  const baseTo = g.excludeCurrentWeekFromBaseline ? addDays(start, -1) : today;
  const baseFrom = addDays(baseTo, -(g.baselineDays - 1));
  const base = winRateOf(closed.filter((t) => closedOn(t) >= baseFrom && closedOn(t) <= baseTo));
  const baseline: Baseline = {
    from: baseFrom, to: baseTo, ...base, lowConfidence: base.wins + base.losses < LOW_CONFIDENCE_BELOW,
  };

  const stats = windowStats(items);
  const delta = stats.winRate !== null && base.winRate !== null ? round((stats.winRate - base.winRate) * 100, 6) : null;
  const state = delta === null ? null : sizeState(delta, g.bands);
  const message =
    state ? MESSAGES[state]
    : stats.winRate === null ? "No decisive trades in the window yet."
    : "No baseline: no closed trades in the baseline period.";

  const sparkline: SparkPoint[] = [];
  for (let w = SPARKLINE_WEEKS - 1; w >= 0; w--) {
    const ws = addDays(start, -7 * w);
    const we = addDays(ws, 6);
    const r = winRateOf(closed.filter((t) => closedOn(t) >= ws && closedOn(t) <= we));
    sparkline.push({ weekStart: ws, wins: r.wins, losses: r.losses, winRate: r.winRate, current: w === 0 });
  }

  return {
    style, now, week: { start, end }, items, counts, label: parts.join(" + "), stats, baseline, delta, state, message,
    unpriced, stale, pricesAsOf, sparkline,
  };
}

/**
 * How many more wins this week bring the gauge back to full size, all else equal (#15):
 * each win joins the window and, while backfill is padding it, pushes the oldest prior
 * trade out. Null when already at full size, without a baseline, or out of reach (> 50).
 */
export function winsToFull(g: Gauge, config: Config): { wins: number; w: number; l: number } | null {
  if (g.state === "full" || g.state === null || g.baseline.winRate === null) return null;
  const base = g.items.filter((i) => i.source !== "prior" && decisive(i.result));
  const prior = g.items.filter((i) => i.source === "prior");
  const min = config.gauge.minSample[g.style];
  for (let k = 1; k <= 50; k++) {
    let need = Math.max(0, min - base.length - k);
    let w = base.filter((i) => i.result === "win").length + k;
    let l = base.length - (w - k);
    for (const p of prior) {
      if (need <= 0) break;
      if (!decisive(p.result)) continue;
      if (p.result === "win") w++;
      else l++;
      need--;
    }
    if (sizeState(round((w / (w + l) - g.baseline.winRate) * 100, 6), config.gauge.bands) === "full") return { wins: k, w, l };
  }
  return null;
}

/** The gauge rules in plain words, from config (Settings, #23). */
export function gaugeRules(config: Config): string[] {
  const g = config.gauge;
  const below = (pts: number) => (pts === 0 ? "below your average" : `${pts}+ points below it`);
  return [
    `Average = your win % over the last ${g.baselineDays} days${g.excludeCurrentWeekFromBaseline ? ", this week excluded" : ""}.`,
    `Half size ${below(g.bands.halfSizeBelowPts)}; quarter size ${below(g.bands.quarterSizeBelowPts)}.`,
    `Needs ${g.minSample.day} day / ${g.minSample.swing} swing trades this week; earlier trades fill in until then.`,
    ...(g.swingIncludesOpenPositions ? ["Swing counts open positions at the last price."] : []),
  ];
}

export function computeGauges(input: GaugeInput): Record<Style, Gauge> {
  return { day: computeGauge("day", input), swing: computeGauge("swing", input) };
}
