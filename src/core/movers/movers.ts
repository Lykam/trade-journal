// Weekly big movers (SPEC §6.7f, Q85), a research list: US stocks whose week
// moved 50%+ either way, with $100M+ average daily dollar volume and a price
// over $5. Pure: the caller supplies every market day's bars (actual traded
// prices, not split-adjusted), the splits, and which tickers are stocks. See
// build/fetch-movers.ts, which writes movers.json into trade-history.
import { weekStart } from "../calendar";

export interface Bar {
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  /** Volume-weighted average price, when the source has it: dollar volume is v × vw. */
  vw?: number;
}

/** One market day: every ticker's bar. A day with no bars (a holiday) is left out by the caller. */
export interface Day {
  date: string;
  bars: Map<string, Bar>;
}

/** A split executed on `date`: `from` old shares became `to` new ones, so earlier prices scale by from / to. */
export interface Split {
  ticker: string;
  date: string;
  from: number;
  to: number;
}

export interface Criteria {
  /** Minimum move, percent, either direction. */
  move: number;
  /** Minimum average daily dollar volume, over the week or the trailing 30 days. */
  dollarVolume: number;
  /** Minimum price at the start (prior week's close) or the end of the week. */
  price: number;
}

export const DEFAULT_CRITERIA: Criteria = { move: 50, dollarVolume: 100e6, price: 5 };

/** Market days in the trailing "30 day" dollar-volume average. */
export const DV30_DAYS = 21;

export interface Mover {
  ticker: string;
  dir: "up" | "down";
  /** "close": the Friday close moved enough. "intraweek": only the week's high or low did. */
  basis: "close" | "intraweek";
  /** Close vs the prior week's close, percent (split-adjusted). */
  chg: number;
  /** The week's high and low vs the prior week's close, percent. */
  hi: number;
  lo: number;
  /** Actual traded prices: the prior week's close and this week's close. */
  start: number;
  end: number;
  /** Average daily dollar volume: this week, and the 21 market days ending this week. */
  dv5: number;
  dv30: number;
  /** Peak single-day dollar volume this week. */
  dvMax: number;
  /** Average daily range (high − low) / low this week, percent. */
  adr: number;
  /** Days the ticker traded this week. */
  days: number;
}

export interface MoverWeek {
  /** Monday of the week and the week's last market day. */
  week: string;
  end: string;
  movers: Mover[];
}

const dollars = (b: Bar) => b.v * (b.vw ?? b.c);

/** Split factor taking a price on `date` to the basis of `asOf`: the product of from / to for splits after `date`, up to `asOf`. */
function factor(splits: Split[] | undefined, date: string, asOf: string): number {
  let f = 1;
  for (const s of splits ?? []) if (s.date > date && s.date <= asOf && s.from > 0 && s.to > 0) f *= s.from / s.to;
  return f;
}

/**
 * The movers of every complete week in `days` (oldest first) after the first: each week is
 * measured from the prior week's last market day. `isStock` drops ETFs, warrants and the like.
 */
export function computeMovers(days: Day[], splits: Split[], isStock: (ticker: string) => boolean, criteria: Criteria = DEFAULT_CRITERIA): MoverWeek[] {
  const bySplit = new Map<string, Split[]>();
  for (const s of splits) (bySplit.get(s.ticker) ?? bySplit.set(s.ticker, []).get(s.ticker)!).push(s);

  const groups: { week: string; first: number; last: number }[] = [];
  days.forEach((d, i) => {
    const w = weekStart(d.date);
    const g = groups[groups.length - 1];
    if (g && g.week === w) g.last = i;
    else groups.push({ week: w, first: i, last: i });
  });

  const m = criteria.move / 100;
  const out: MoverWeek[] = [];
  for (let gi = 1; gi < groups.length; gi++) {
    const g = groups[gi]!;
    const prevDay = days[groups[gi - 1]!.last]!;
    const end = days[g.last]!.date;
    const week = days.slice(g.first, g.last + 1);
    const tickers = new Set(week.flatMap((d) => [...d.bars.keys()]));
    const movers: Mover[] = [];
    for (const t of tickers) {
      const prev = prevDay.bars.get(t);
      if (!prev || prev.c <= 0) continue;
      const sp = bySplit.get(t);
      const base = prev.c * factor(sp, prevDay.date, end);
      let hi = -Infinity;
      let lo = Infinity;
      let last: Bar | undefined;
      let traded = 0;
      let dvSum = 0;
      let dvMax = 0;
      let range = 0;
      for (const d of week) {
        const b = d.bars.get(t);
        if (!b) continue;
        const f = factor(sp, d.date, end);
        hi = Math.max(hi, b.h * f);
        lo = Math.min(lo, b.l * f);
        last = b;
        traded++;
        const dv = dollars(b);
        dvSum += dv;
        dvMax = Math.max(dvMax, dv);
        if (b.l > 0) range += (b.h - b.l) / b.l;
      }
      if (!last) continue;
      const chg = last.c / base - 1;
      const up = hi / base - 1;
      const down = lo / base - 1;
      const byClose = Math.abs(chg) >= m;
      if (!byClose && up < m && down > -m) continue;
      if (prev.c <= criteria.price && last.c <= criteria.price) continue;
      const dv5 = dvSum / week.length;
      const dv30 = trailingDv(days, g.last, t);
      if (dv5 < criteria.dollarVolume && dv30 < criteria.dollarVolume) continue;
      if (!isStock(t)) continue;
      const dir = byClose ? (chg > 0 ? "up" : "down") : up >= -down ? "up" : "down";
      movers.push({
        ticker: t,
        dir,
        basis: byClose ? "close" : "intraweek",
        chg: pct(chg),
        hi: pct(up),
        lo: pct(down),
        start: prev.c,
        end: last.c,
        dv5: Math.round(dv5),
        dv30: Math.round(dv30),
        dvMax: Math.round(dvMax),
        adr: pct(range / traded),
        days: traded,
      });
    }
    movers.sort((a, b) => Math.abs(b.chg) - Math.abs(a.chg) || a.ticker.localeCompare(b.ticker));
    out.push({ week: g.week, end, movers });
  }
  return out;
}

/** Average daily dollar volume over the DV30_DAYS market days ending at `endIdx` (fewer at the start of the data); a day the ticker didn't trade counts as zero. */
function trailingDv(days: Day[], endIdx: number, t: string): number {
  const from = Math.max(0, endIdx - DV30_DAYS + 1);
  let sum = 0;
  for (let i = from; i <= endIdx; i++) {
    const b = days[i]!.bars.get(t);
    if (b) sum += dollars(b);
  }
  return sum / (endIdx - from + 1);
}

const pct = (x: number) => Math.round(x * 1000) / 10;

/** movers.json: written by `npm run movers`, kept in trade-history, shown on the MOVERS page. */
export interface MoversFile {
  schemaVersion: 1;
  /** The last complete week's last market day: the data runs through here. */
  through: string;
  criteria: Criteria;
  /** Oldest first. */
  weeks: MoverWeek[];
}

export function moversFile(weeks: MoverWeek[], criteria: Criteria = DEFAULT_CRITERIA): MoversFile {
  return { schemaVersion: 1, through: weeks.at(-1)?.end ?? "", criteria, weeks };
}

/** Parse movers.json text; null for anything that isn't a movers file (the page then shows its empty state). */
export function parseMoversFile(text: string | undefined | null): MoversFile | null {
  if (!text) return null;
  try {
    const f = JSON.parse(text) as MoversFile;
    return f && f.schemaVersion === 1 && Array.isArray(f.weeks) && f.weeks.every((w) => typeof w.end === "string" && Array.isArray(w.movers)) ? f : null;
  } catch {
    return null;
  }
}

/** A mover with its week, for flat lists. */
export interface MoverRow extends Mover {
  /** The week's Monday and last market day. */
  week: string;
  weekEnd: string;
  /** Weeks this ticker qualified in the whole file. */
  repeats: number;
}

export interface MoverFilter {
  q: string;
  dir: "all" | "up" | "down";
  basis: "all" | "close" | "intraweek";
  /** "before": already liquid (30-day average over the bar). "move": liquid only because of the move. */
  liquidity: "all" | "before" | "move";
}

export const NO_FILTER: MoverFilter = { q: "", dir: "all", basis: "all", liquidity: "all" };

/** Every mover, newest week first (biggest move first within a week), with how often each ticker repeats. */
export function moverRows(file: MoversFile | null | undefined): MoverRow[] {
  if (!file) return [];
  const repeats = new Map<string, number>();
  for (const w of file.weeks) for (const m of w.movers) repeats.set(m.ticker, (repeats.get(m.ticker) ?? 0) + 1);
  return [...file.weeks].reverse().flatMap((w) => w.movers.map((m) => ({ ...m, week: w.week, weekEnd: w.end, repeats: repeats.get(m.ticker) ?? 1 })));
}

export function filterMovers(rows: MoverRow[], f: MoverFilter, bar = DEFAULT_CRITERIA.dollarVolume): MoverRow[] {
  const q = f.q.trim().toUpperCase();
  return rows.filter(
    (r) =>
      (!q || r.ticker.includes(q)) &&
      (f.dir === "all" || r.dir === f.dir) &&
      (f.basis === "all" || r.basis === f.basis) &&
      (f.liquidity === "all" || (f.liquidity === "before") === r.dv30 >= bar),
  );
}

/** CSV of every week's movers, newest week first. */
export function moversCsv(weeks: MoverWeek[]): string {
  const head = "week_end,ticker,dir,basis,chg_pct,hi_pct,lo_pct,start,end,avg_dv_week,avg_dv_30d,max_dv_day,adr_pct,days";
  const rows = [...weeks].reverse().flatMap((w) =>
    w.movers.map((r) => [w.end, r.ticker, r.dir, r.basis, r.chg, r.hi, r.lo, r.start, r.end, r.dv5, r.dv30, r.dvMax, r.adr, r.days].join(",")),
  );
  return `${[head, ...rows].join("\n")}\n`;
}
