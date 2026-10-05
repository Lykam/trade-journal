// One index over the bundle for the journal pages: lookups, the review join and tags.
import { cents } from "../normalize/util";
import { heldOvernightDayTrades, markToMarket } from "../trades/stats";
import { joinReviews, readReviews, type Review, type ReviewJoin } from "../reviews/join";
import type { DataBundle, Fill, Idea, QuotesFile, Trade } from "../types";
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
  overnight: Set<string>;
  /** Open trades with a quote: realized + unrealized at the last price (Total open P&L, §6.1a). */
  marks: Map<string, number>;
  today: string;
  startsOn: "monday" | "sunday";
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
  for (const t of trades) if (t.status === "open" && quotes[t.symbol]) marks.set(t.id, markToMarket(t, quotes[t.symbol]!.price).total);
  return {
    trades, ideas,
    tradeById: new Map(trades.map((t) => [t.id, t])),
    ideaById: new Map(ideas.map((i) => [i.id, i])),
    fillById: new Map((data.fills ?? []).map((f) => [f.id, f])),
    reviews, tags,
    allTags: [...[...auto].sort(byName), ...[...manual].filter((m) => !auto.has(m)).sort(byName)],
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
      value = m === undefined || value === null ? null : value + m;
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

/** Review checks for the dashboard's Needs attention widget (SPEC §6.1 item 6). */
export function reviewAttention(j: Journal): ReviewAttention {
  return {
    openButClosed: j.reviews.reviews.filter((r) => {
      const idea = j.ideaById.get(j.reviews.ideaOf.get(r.id) ?? "");
      return r.header.status === "open" && idea?.status === "closed";
    }),
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
