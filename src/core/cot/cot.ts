// COT positioning gauge (SPEC §5.7), after Jason Shapiro's use of the CFTC
// Commitments of Traders report: follow the commercials, the better-informed side.
// Pure: given weekly COT reports and daily bars (oldest first), rank the
// commercials' net position against its own history, find the zone, walk the
// reversal-confirmed signal, and derive a direction-aware swing sizing brake.
// No network here; that lives in build/fetch-cot.ts.
// No runtime imports: build/fetch-cot.ts is loaded natively by the Vite config chain
// (dev-data-plugin → load-bundle), where extensionless imports don't resolve.

const DAY_MS = 86_400_000;
const dayNum = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
const daysBetween = (a: string, b: string) => Math.round((dayNum(b) - dayNum(a)) / DAY_MS);
const round = (n: number, places: number) => {
  const r = Math.round(n * 10 ** places) / 10 ** places;
  return Object.is(r, -0) ? 0 : r;
};
/** "YYYY-MM-DD" in New York for an ISO instant. */
const etDate = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(iso));

/** One weekly legacy futures-only report: [long, short] per trader group. */
export interface CotReport {
  /** Tuesday the positions are as of, "YYYY-MM-DD". */
  date: string;
  openInterest: number;
  commercial: [number, number];
  /** Non-commercial: the large speculators. */
  largeSpec: [number, number];
  /** Non-reportable: small traders, the closest thing to retail. */
  small: [number, number];
}

export interface DailyBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

export type CotMarketId = "ES" | "NQ" | "YM";
export type CotZone = "buy" | "neutral" | "sell";
/** Long = buy the index side; short = an inverse ETF. */
export type CotSide = "long" | "short";

export interface CotMarket {
  id: CotMarketId;
  name: string;
  /** CFTC contract market code; stable across the contract's renames. */
  code: string;
  /** ETF whose daily bars stand in for the future in the reversal check. */
  etf: string;
}

/** Index futures the gauge tracks. Russell was tested and left out: its readings didn't separate outcomes (SPEC §5.7). */
export const COT_MARKETS: readonly CotMarket[] = [
  { id: "ES", name: "S&P 500", code: "13874A", etf: "SPY" },
  { id: "NQ", name: "Nasdaq-100", code: "209742", etf: "QQQ" },
  { id: "YM", name: "Dow", code: "124603", etf: "DIA" },
];

/** Weeks of history each reading is ranked against (3 years). */
export const LOOKBACK_WEEKS = 156;
/** Top or bottom slice of the 3-year range that counts as crowded. */
export const EDGE = 20;
/** Oscillator ≥ this: commercials near their most long of the range, look to buy. */
export const BUY_ZONE = 100 - EDGE;
/** Oscillator ≤ this: commercials near their most short of the range, look to sell. */
export const SELL_ZONE = EDGE;
/** Back at neutral: take profits (Shapiro: "when it goes back to 50, I'm out"). */
export const NEUTRAL = 50;
/** A reversal day undercuts (overtakes) the low (high) of this many prior sessions. */
export const REVERSAL_LOOKBACK = 10;
/** A reading released longer ago than this is too old to act on (holiday delays, data gaps). */
export const STALE_DAYS = 14;
/** Swing size multiplier while any tracked index is positioned against the trade's direction. */
export const COT_BRAKE = 0.5;
/** Weeks in the sparkline. */
export const SPARK_WEEKS = 52;

/** Reports come out Friday 15:30 ET for the prior Tuesday: usable from the session after. */
export const releaseDate = (reportDate: string): string => {
  const d = new Date(`${reportDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 3);
  return d.toISOString().slice(0, 10);
};

/** Net position as a percent of open interest, so readings compare across years of changing OI. */
const netPct = ([long, short]: [number, number], oi: number) => (oi > 0 ? (100 * (long - short)) / oi : 0);

/** Where values[i] sits in the trailing `n` values, 0 (lowest) to 100 (highest); null without enough history. */
export function rank(values: number[], i: number, n = LOOKBACK_WEEKS): number | null {
  if (i < n - 1 || i >= values.length) return null;
  let min = Infinity;
  let max = -Infinity;
  for (let k = i - n + 1; k <= i; k++) {
    min = Math.min(min, values[k]!);
    max = Math.max(max, values[k]!);
  }
  return max === min ? 50 : round((100 * (values[i]! - min)) / (max - min), 1);
}

export const zoneOf = (osc: number): CotZone => (osc >= BUY_ZONE ? "buy" : osc <= SELL_ZONE ? "sell" : "neutral");

export interface CotReading {
  report: string;
  released: string;
  /** Commercials' net ranked in the lookback: 0 = their most short, 100 = their most long. */
  osc: number;
}

/** Oscillator per report, oldest first; reports without a full lookback are left out. */
export function oscillator(reports: CotReport[]): CotReading[] {
  const comm = reports.map((r) => netPct(r.commercial, r.openInterest));
  const out: CotReading[] = [];
  for (let i = 0; i < reports.length; i++) {
    const osc = rank(comm, i);
    if (osc !== null) out.push({ report: reports[i]!.date, released: releaseDate(reports[i]!.date), osc });
  }
  return out;
}

export interface CotSignal {
  /** neutral: no zone. armed: in a zone, waiting for a reversal day. confirmed: in the trade. */
  state: "neutral" | "armed" | "confirmed";
  side: CotSide | null;
  /** armed: first session the zone was known; confirmed: the reversal day. */
  since: string | null;
  /** confirmed: the reversal day's close and the stop (its low for longs, high for shorts). */
  entry: number | null;
  stop: number | null;
  /** How the previous signal ended. ret is % on the ETF, signed for the side. */
  last: { kind: "stopped" | "exited" | "expired"; side: CotSide; date: string; ret: number | null } | null;
}

/**
 * Walk the daily bars with the reading known on each day (released strictly
 * before it, and no older than STALE_DAYS). In a zone, a reversal day confirms:
 * long = low undercuts the prior REVERSAL_LOOKBACK lows, close up on the day and
 * in the upper half of its range (mirror for short). Exit on the stop, or when
 * the oscillator gets back to NEUTRAL. An armed zone that ends before
 * confirming expires.
 */
export function walkSignal(readings: CotReading[], bars: DailyBar[]): CotSignal {
  let ri = -1;
  let pos: { side: CotSide; date: string; entry: number; stop: number } | null = null;
  let armed: { side: CotSide; since: string } | null = null;
  let last: CotSignal["last"] = null;
  const ret = (side: CotSide, entry: number, exit: number) => round((side === "long" ? 1 : -1) * 100 * (exit / entry - 1), 2);

  for (let t = REVERSAL_LOOKBACK; t < bars.length; t++) {
    const b = bars[t]!;
    while (ri + 1 < readings.length && readings[ri + 1]!.released < b.date) ri++;
    const known = ri >= 0 && daysBetween(readings[ri]!.released, b.date) <= STALE_DAYS ? readings[ri]!.osc : null;

    if (pos) {
      const stopped = pos.side === "long" ? b.low <= pos.stop : b.high >= pos.stop;
      if (stopped) {
        const fill = pos.side === "long" ? Math.min(b.open, pos.stop) : Math.max(b.open, pos.stop);
        last = { kind: "stopped", side: pos.side, date: b.date, ret: ret(pos.side, pos.entry, fill) };
        pos = null;
      } else if (known !== null && (pos.side === "long" ? known <= NEUTRAL : known >= NEUTRAL)) {
        last = { kind: "exited", side: pos.side, date: b.date, ret: ret(pos.side, pos.entry, b.close) };
        pos = null;
      }
      continue;
    }

    const zone = known === null ? null : zoneOf(known);
    const side: CotSide | null = zone === "buy" ? "long" : zone === "sell" ? "short" : null;
    if (armed && armed.side !== side) {
      last = { kind: "expired", side: armed.side, date: b.date, ret: null };
      armed = null;
    }
    if (!side) continue;
    armed ??= { side, since: b.date };

    let lo = Infinity;
    let hi = -Infinity;
    for (let k = t - REVERSAL_LOOKBACK; k < t; k++) {
      lo = Math.min(lo, bars[k]!.low);
      hi = Math.max(hi, bars[k]!.high);
    }
    const mid = (b.high + b.low) / 2;
    const prev = bars[t - 1]!.close;
    const reversal =
      side === "long" ? b.low < lo && b.close > prev && b.close >= mid : b.high > hi && b.close < prev && b.close <= mid;
    if (reversal) {
      pos = { side, date: b.date, entry: b.close, stop: side === "long" ? b.low : b.high };
      armed = null;
    }
  }

  if (pos) return { state: "confirmed", side: pos.side, since: pos.date, entry: pos.entry, stop: pos.stop, last };
  if (armed) return { state: "armed", side: armed.side, since: armed.since, entry: null, stop: null, last };
  return { state: "neutral", side: null, since: null, entry: null, stop: null, last };
}

export interface CotBreakdown {
  /** Net positions as % of open interest. */
  commercial: number;
  largeSpec: number;
  small: number;
}

export interface CotMarketSnapshot {
  id: CotMarketId;
  name: string;
  etf: string;
  report: string;
  released: string;
  /** The latest reading is older than STALE_DAYS at `now`: shown, but left out of the brake. */
  stale: boolean;
  osc: number;
  zone: CotZone;
  /** Same oscillator 4 weeks and 52 weeks (year over year) earlier. */
  osc4w: number | null;
  osc1y: number | null;
  net: CotBreakdown;
  net1y: CotBreakdown | null;
  /** Small traders' and large specs' nets, ranked like the oscillator (context; the signal is the commercials). */
  smallRank: number | null;
  specRank: number | null;
  /**
   * Small traders and large specs crowded on opposite sides (Shapiro's 1999: the small guys
   * long and making money while the large specs were short; the top came once they were squeezed out).
   */
  divergence: "small-long-large-short" | "small-short-large-long" | null;
  /** Oscillator for the last SPARK_WEEKS reports, oldest first. */
  spark: number[];
  signal: CotSignal;
}

export interface CotBrake {
  /** 1 = no brake. */
  multiplier: number;
  /** Markets positioned against this direction (sell zone for longs, buy zone for shorts). */
  against: CotMarketId[];
}

export interface CotSnapshot {
  markets: CotMarketSnapshot[];
  brake: Record<CotSide, CotBrake>;
}

const breakdown = (r: CotReport): CotBreakdown => ({
  commercial: round(netPct(r.commercial, r.openInterest), 1),
  largeSpec: round(netPct(r.largeSpec, r.openInterest), 1),
  small: round(netPct(r.small, r.openInterest), 1),
});

/** One market's snapshot at `now`; null without a full lookback of reports. */
export function computeCotMarket(market: CotMarket, reports: CotReport[], bars: DailyBar[], now: string): CotMarketSnapshot | null {
  const sorted = [...reports].sort((a, b) => a.date.localeCompare(b.date));
  const comm = sorted.map((r) => netPct(r.commercial, r.openInterest));
  const spec = sorted.map((r) => netPct(r.largeSpec, r.openInterest));
  const small = sorted.map((r) => netPct(r.small, r.openInterest));
  const i = sorted.length - 1;
  const osc = rank(comm, i);
  if (osc === null) return null;
  const latest = sorted[i]!;
  const smallRank = rank(small, i);
  const specRank = rank(spec, i);
  const zone = zoneOf(osc);
  const high = (r: number | null) => r !== null && r >= 100 - EDGE;
  const low = (r: number | null) => r !== null && r <= EDGE;
  const divergence =
    high(smallRank) && low(specRank) ? "small-long-large-short"
    : low(smallRank) && high(specRank) ? "small-short-large-long"
    : null;
  const spark: number[] = [];
  for (let k = Math.max(0, i - SPARK_WEEKS + 1); k <= i; k++) {
    const v = rank(comm, k);
    if (v !== null) spark.push(v);
  }
  const released = releaseDate(latest.date);
  return {
    id: market.id,
    name: market.name,
    etf: market.etf,
    report: latest.date,
    released,
    stale: daysBetween(released, etDate(now)) > STALE_DAYS,
    osc,
    zone,
    osc4w: rank(comm, i - 4),
    osc1y: rank(comm, i - 52),
    net: breakdown(latest),
    net1y: i >= 52 ? breakdown(sorted[i - 52]!) : null,
    smallRank,
    specRank,
    divergence,
    spark,
    signal: walkSignal(oscillator(sorted), [...bars].sort((a, b) => a.date.localeCompare(b.date))),
  };
}

/** Direction-aware brake: never sizes up, only halves a swing trade the crowd positioning argues against. */
export function cotBrake(markets: CotMarketSnapshot[]): Record<CotSide, CotBrake> {
  const fresh = markets.filter((m) => !m.stale);
  const against = (zone: CotZone) => fresh.filter((m) => m.zone === zone).map((m) => m.id);
  const of = (ids: CotMarketId[]): CotBrake => ({ multiplier: ids.length ? COT_BRAKE : 1, against: ids });
  return { long: of(against("sell")), short: of(against("buy")) };
}

export function computeCot(
  reports: Partial<Record<CotMarketId, CotReport[]>>,
  bars: Record<string, DailyBar[]>,
  now: string,
): CotSnapshot {
  const markets: CotMarketSnapshot[] = [];
  for (const m of COT_MARKETS) {
    const snap = computeCotMarket(m, reports[m.id] ?? [], bars[m.etf] ?? [], now);
    if (snap) markets.push(snap);
  }
  return { markets, brake: cotBrake(markets) };
}
