// Match Tradervue trades to journal trades (SPEC §4.7). Pure.
//
// - Timed trades (Webull) match on the exact ET open and close second plus the
//   shares bought. The symbol may differ: Webull renames past rows after a
//   ticker change and the journal keeps the first-seen symbol (Q18), while
//   Tradervue may hold the new one, or both.
// - Date-only trades (Schwab) match on symbol, open and close date and shares.
//   Several same-day round trips are told apart by gross P&L first; whatever
//   is left pairs up in order (the day's lots were paired differently).
// - A Tradervue row whose trade is already matched is a duplicate copy
//   (Tradervue keeps a second copy when overlapping files were imported).
import { cents } from "../normalize/util";
import type { Fill, Trade } from "../types";
import type { TvTrade } from "./parse";

export interface TvPair {
  tv: TvTrade;
  trade: Trade;
  /** A second (or later) Tradervue copy of a trade already matched. */
  duplicate: boolean;
}

export type TvMissReason = "before broker fills" | "split or quantity differs" | "no journal trade";
export type JournalMissReason = "split or quantity differs" | "no Tradervue trade";

export interface TvMatchResult {
  pairs: TvPair[];
  /** Journal trade id → its Tradervue rows (first = the primary match). */
  byTrade: Map<string, TvTrade[]>;
  unmatchedTv: Array<{ tv: TvTrade; reason: TvMissReason }>;
  /** Journal trades opened inside the export's date range with no Tradervue trade. */
  unmatchedJournal: Array<{ trade: Trade; reason: JournalMissReason }>;
  /** Journal trades opened after the export's last date (not expected in it). */
  afterRange: Trade[];
  /** "JOURNAL → TRADERVUE" symbol → matched rows. */
  renames: Map<string, number>;
  range: { from: string; to: string } | null;
}

const ET_PARTS = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});

/** ISO instant → ET wall-clock "YYYY-MM-DD HH:MM:SS", the form Tradervue exports. */
export function etDateTime(iso: string): string {
  const p = Object.fromEntries(ET_PARTS.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

export const sharesBought = (t: Trade) => t.events.filter((e) => e.kind === "open" || e.kind === "add").reduce((s, e) => s + e.qty, 0);

/** Schwab exports carry dates only (§4.2). */
export const isDateOnly = (t: Trade) => t.broker === "schwab";

const day = (s: string | null) => (s ? s.slice(0, 10) : "");

export function matchTradervue(tvTrades: TvTrade[], trades: Trade[], fills: Fill[]): TvMatchResult {
  const view = trades.map((t) => ({
    t,
    open: etDateTime(t.openedAt),
    close: t.closedAt ? etDateTime(t.closedAt) : null,
    shares: sharesBought(t),
    dateOnly: isDateOnly(t),
  }));
  type View = (typeof view)[number];
  const matched = new Map<string, TvTrade[]>();
  const pairs: TvPair[] = [];
  const pending = new Set(tvTrades);

  const sameShape = (tv: TvTrade, v: View) =>
    v.dateOnly === tv.dateOnly &&
    (tv.closedAt === null) === (v.close === null) &&
    (tv.shares === null || tv.shares === v.shares) &&
    (tv.dateOnly
      ? v.t.symbol === tv.symbol && day(v.open) === day(tv.openedAt) && day(v.close) === day(tv.closedAt)
      : v.open === tv.openedAt && (v.close ?? null) === tv.closedAt);
  // A timed candidate with the same symbol is preferred over a renamed one.
  const candidates = (tv: TvTrade) =>
    view.filter((v) => sameShape(tv, v)).sort((a, b) => Number(b.t.symbol === tv.symbol) - Number(a.t.symbol === tv.symbol));
  const take = (tv: TvTrade, v: View) => {
    const dup = matched.has(v.t.id);
    matched.set(v.t.id, [...(matched.get(v.t.id) ?? []), tv]);
    pairs.push({ tv, trade: v.t, duplicate: dup });
    pending.delete(tv);
  };
  const pnlClose = (tv: TvTrade, v: View) => Math.abs(cents(tv.grossPnl) - v.t.grossPnl) <= 0.011;

  // 1. Unmatched trade with the same shape (and, for date-only, the same P&L);
  //    same-symbol rows first, so a renamed copy is the duplicate, not the primary.
  for (const sameSymbol of [true, false]) {
    for (const tv of [...pending]) {
      const v = candidates(tv).find((c) => !matched.has(c.t.id) && (!sameSymbol || c.t.symbol === tv.symbol) && (!tv.dateOnly || pnlClose(tv, c)));
      if (v) take(tv, v);
    }
  }
  // 2. Date-only: any unmatched trade with the same shape (lots paired differently).
  for (const tv of [...pending]) {
    const v = candidates(tv).find((c) => !matched.has(c.t.id));
    if (v) take(tv, v);
  }
  // 3. What is left and fits an already matched trade is a duplicate copy.
  for (const tv of [...pending]) {
    const c = candidates(tv);
    const v = c.find((x) => pnlClose(tv, x)) ?? c[0];
    if (v) take(tv, v);
  }

  const renames = new Map<string, number>();
  for (const p of pairs) {
    if (p.tv.symbol !== p.trade.symbol) {
      const k = `${p.trade.symbol} → ${p.tv.symbol}`;
      renames.set(k, (renames.get(k) ?? 0) + 1);
    }
  }

  const dates = tvTrades.flatMap((t) => [day(t.openedAt), day(t.closedAt)]).filter(Boolean).sort();
  const range = dates.length ? { from: dates[0]!, to: dates.at(-1)! } : null;

  // Coverage: the first broker fill of each precision (date-only = Schwab-style accounts).
  const firstFill = { day: "", second: "" };
  for (const f of fills) {
    const d = etDateTime(f.executedAt).slice(0, 10);
    if (!firstFill[f.timePrecision] || d < firstFill[f.timePrecision]) firstFill[f.timePrecision] = d;
  }

  const unmatchedViews = view.filter((v) => !matched.has(v.t.id));
  const near = (dateOnly: boolean, symbol: string, date: string) => (v: View) => v.dateOnly === dateOnly && v.t.symbol === symbol && day(v.open) === date;
  const unmatchedTv = [...pending].map((tv) => {
    const first = firstFill[tv.dateOnly ? "day" : "second"];
    const reason: TvMissReason =
      !first || day(tv.openedAt) < first ? "before broker fills"
      : view.some(near(tv.dateOnly, tv.symbol, day(tv.openedAt))) ? "split or quantity differs"
      : "no journal trade";
    return { tv, reason };
  });
  const inRange = (v: View) => range !== null && day(v.open) >= range.from && day(v.open) <= range.to;
  const unmatchedJournal = unmatchedViews.filter(inRange).map((v) => ({
    trade: v.t,
    reason: (pending.size && [...pending].some((tv) => tv.dateOnly === v.dateOnly && tv.symbol === v.t.symbol && day(tv.openedAt) === day(v.open))
      ? "split or quantity differs" : "no Tradervue trade") as JournalMissReason,
  }));
  const afterRange = unmatchedViews.filter((v) => range !== null && day(v.open) > range.to).map((v) => v.t);
  return { pairs, byTrade: matched, unmatchedTv, unmatchedJournal, afterRange, renames, range };
}
