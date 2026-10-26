// One index over the bundle for the journal pages: lookups, the review join and tags.
import { cents } from "../normalize/util";
import { heldOvernightDayTrades, markToMarket } from "../trades/stats";
import { joinReviews, readReviews, type Review, type ReviewJoin } from "../reviews/join";
import type { DataBundle, Fill, Idea, QuotesFile, Style, Trade } from "../types";
import { activeFilterCount, dateRange, tradeMatcher, type MatchContext, type TradeFilter } from "./filter";
import { tradeTags, type TradeTags } from "./tags";

export interface Journal {
  trades: Trade[];
  ideas: Idea[];
  tradeById: Map<string, Trade>;
  ideaById: Map<string, Idea>;
  fillById: Map<string, Fill>;
  reviews: ReviewJoin;
  tags: Map<string, TradeTags>;
  /** Every tag in use, automatic first, then manual, alphabetical within each. */
  allTags: string[];
  /** Setup values in use, grouped by style, alphabetical. */
  setupsByStyle: Record<Style, string[]>;
  /** Entry values in use, grouped by style, alphabetical. */
  entriesByStyle: Record<Style, string[]>;
  overnight: Set<string>;
  /** Open trades with a quote: unrealized P&L at the last price. Tables add the trade's gross or net realized P&L (§6.1a). */
  marks: Map<string, number>;
  today: string;
  startsOn: "monday" | "sunday";
}

/** Distinct values of `pick`, case-insensitively deduped (first casing wins), grouped by trade style, alphabetical. */
function valuesByStyle(trades: Trade[], pick: (t: Trade) => string | undefined): Record<Style, string[]> {
  const seen: Record<Style, Map<string, string>> = { day: new Map(), swing: new Map() };
  for (const t of trades) {
    const v = pick(t);
    if (!v) continue;
    const key = v.toLowerCase();
    if (!seen[t.style].has(key)) seen[t.style].set(key, v);
  }
  const sorted = (m: Map<string, string>) => [...m.values()].sort((a, b) => a.localeCompare(b));
  return { day: sorted(seen.day), swing: sorted(seen.swing) };
}

export function buildJournal(
  data: Pick<DataBundle, "derived" | "symbols" | "playbook" | "config"> & { fills?: Fill[]; quotes?: QuotesFile | null },
  today: string,
): Journal {
  const { trades, ideas } = data.derived;
  const reviews = joinReviews(readReviews(data.playbook?.reviews ?? [], data.symbols), { ideas, trades });
  const tags = new Map<string, TradeTags>();
  const auto = new Set<string>();
  const manual = new Set<string>();
  for (const t of trades) {
    const rs = reviews.byIdea.get(t.ideaId);
    const tt = tradeTags(t, rs ? rs.map((r) => r.header.category) : null);
    tags.set(t.id, tt);
    tt.auto.forEach((x) => auto.add(x));
    tt.manual.forEach((x) => manual.add(x));
  }
  const byName = (a: string, b: string) => a.localeCompare(b);
  const quotes = data.quotes?.quotes ?? {};
  const marks = new Map<string, number>();
  for (const t of trades) if (t.status === "open" && quotes[t.symbol]) marks.set(t.id, markToMarket(t, quotes[t.symbol]!.price).unrealized);
  return {
    trades, ideas,
    tradeById: new Map(trades.map((t) => [t.id, t])),
    ideaById: new Map(ideas.map((i) => [i.id, i])),
    fillById: new Map((data.fills ?? []).map((f) => [f.id, f])),
    reviews, tags,
    allTags: [...[...auto].sort(byName), ...[...manual].filter((m) => !auto.has(m)).sort(byName)],
    setupsByStyle: valuesByStyle(trades, (t) => t.setup),
    entriesByStyle: valuesByStyle(trades, (t) => t.entry),
    overnight: new Set(heldOvernightDayTrades(trades, today).map((t) => t.id)),
    marks,
    today,
    startsOn: data.config.weekStartsOn,
  };
}

/** The reviews linked to a trade's idea (oldest first), or [] if none. */
export const reviewsOf = (j: Journal, t: Trade): Review[] => j.reviews.byIdea.get(t.ideaId) ?? [];

export interface GroupPnl {
  /** Closed trades at their gross or net P&L, open ones marked to the last price; null if an open trade has no quote. */
  value: number | null;
  /** Any trade still open: the value is a mark, not a result (shown muted, never as a win or loss). */
  open: boolean;
}

/** P&L of a trade, an idea or any group of trades, for tables (§6.3, §6.7). */
export function groupPnl(j: Journal, trades: Trade[], mode: "gross" | "net"): GroupPnl {
  let value: number | null = 0;
  let open = false;
  for (const t of trades) {
    if (t.status === "open") {
      open = true;
      const m = j.marks.get(t.id);
      // Realized so far (trims, minus fees in net mode) plus the open shares at the last price.
      value = m === undefined || value === null ? null : value + m + (mode === "gross" ? t.grossPnl : t.netPnl);
    } else if (value !== null) value += mode === "gross" ? t.grossPnl : t.netPnl;
  }
  return { value: value === null ? null : cents(value), open };
}

export function matchContext(j: Journal): MatchContext {
  return {
    today: j.today, startsOn: j.startsOn,
    tagsOf: (t) => j.tags.get(t.id)?.all ?? t.tags,
    reviewed: (t) => j.reviews.byIdea.has(t.ideaId),
    overnight: j.overnight,
  };
}

export const filterTrades = (j: Journal, f: TradeFilter): Trade[] => j.trades.filter(tradeMatcher(f, matchContext(j)));

/** ET dates that have at least one review (calendar and week strip 📄). */
export const reviewDates = (j: Journal): Set<string> => new Set(j.reviews.reviews.map((r) => r.date).filter((d): d is string => d !== null));

export interface ReviewAttention {
  /** Reviews still marked OPEN whose idea has closed: finish the exit-phase sections. */
  openButClosed: Review[];
  unmatched: Review[];
  multiple: ReviewJoin["multiple"];
}

/** A review still marked OPEN whose idea has closed: its exit sections are missing (#22). */
export function exitMissing(j: Journal, r: Review): boolean {
  const idea = j.ideaById.get(j.reviews.ideaOf.get(r.id) ?? "");
  return r.header.status === "open" && idea?.status === "closed";
}

/** The Journal list order: reviews missing their exit first (the ones that need work), then as given (newest first). */
export const journalOrder = (j: Journal, reviews: Review[]): Review[] =>
  reviews.map((r, i) => ({ r, i, m: exitMissing(j, r) ? 0 : 1 })).sort((a, b) => a.m - b.m || a.i - b.i).map((x) => x.r);

/** Review checks for the dashboard's Needs attention widget (SPEC §6.1 item 6). */
export function reviewAttention(j: Journal): ReviewAttention {
  return {
    openButClosed: j.reviews.reviews.filter((r) => exitMissing(j, r)),
    unmatched: j.reviews.unmatched,
    multiple: j.reviews.multiple,
  };
}

/**
 * Reviews for the Journal list under the global filter (SPEC §6.7): a linked
 * review shows when any trade in its idea passes the filter. A review that
 * matches no idea has no trades to test, so it shows only when the active
 * filters are ones its own fields can answer (symbol, date range).
 */
export function filterReviews(j: Journal, f: TradeFilter): Review[] {
  const match = tradeMatcher(f, matchContext(j));
  const { from, to } = dateRange(f, j.today, j.startsOn);
  const tradeOnly = activeFilterCount({ ...f, symbols: [], preset: null, from: null, to: null }) > 0;
  return j.reviews.reviews.filter((r) => {
    const idea = j.ideaById.get(j.reviews.ideaOf.get(r.id) ?? "");
    if (idea) return idea.tradeIds.some((id) => { const t = j.tradeById.get(id); return t !== undefined && match(t); });
    if (tradeOnly) return false;
    if (f.symbols.length && !f.symbols.some((s) => s === r.ticker || s === r.underlying)) return false;
    if ((from || to) && (!r.date || (from && r.date < from) || (to && r.date > to))) return false;
    return true;
  });
}

export interface ErrorRow {
  idea: Idea;
  /** The review the error comes from (the idea's latest review when none names one). */
  review: Review;
  /** null: a losing idea's review has no "## The Error" answer yet. */
  error: string | null;
}

/**
 * The error table (Q77, Q79, after Darvas): every closed, reviewed idea whose review
 * names an error, win or loss. A reviewed loss with no answer yet is listed with a
 * null error; a review that says "No error" is left out. Newest idea first.
 */
export function errorTable(j: Journal): ErrorRow[] {
  const rows: ErrorRow[] = [];
  for (const [ideaId, rs] of j.reviews.byIdea) {
    const idea = j.ideaById.get(ideaId);
    if (!idea || idea.status !== "closed") continue;
    const named = [...rs].reverse().find((r) => r.header.error !== null);
    if (named) rows.push({ idea, review: named, error: named.header.error });
    else if (idea.netPnl < 0 && !rs.some((r) => r.header.noError)) rows.push({ idea, review: rs.at(-1)!, error: null });
  }
  return rows.sort((a, b) => b.idea.date.localeCompare(a.idea.date) || a.idea.underlying.localeCompare(b.idea.underlying));
}
