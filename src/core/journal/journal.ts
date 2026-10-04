// One index over the bundle for the journal pages: lookups, the review join and tags.
import { heldOvernightDayTrades } from "../trades/stats";
import { joinReviews, readReviews, type Review, type ReviewJoin } from "../reviews/join";
import type { DataBundle, Fill, Idea, Trade } from "../types";
import { tradeMatcher, type MatchContext, type TradeFilter } from "./filter";
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
  today: string;
  startsOn: "monday" | "sunday";
}

export function buildJournal(
  data: Pick<DataBundle, "derived" | "symbols" | "playbook" | "config"> & { fills?: Fill[] },
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
  return {
    trades, ideas,
    tradeById: new Map(trades.map((t) => [t.id, t])),
    ideaById: new Map(ideas.map((i) => [i.id, i])),
    fillById: new Map((data.fills ?? []).map((f) => [f.id, f])),
    reviews, tags,
    allTags: [...[...auto].sort(byName), ...[...manual].filter((m) => !auto.has(m)).sort(byName)],
    overnight: new Set(heldOvernightDayTrades(trades, today).map((t) => t.id)),
    today,
    startsOn: data.config.weekStartsOn,
  };
}

/** The reviews linked to a trade's idea (oldest first), or [] if none. */
export const reviewsOf = (j: Journal, t: Trade): Review[] => j.reviews.byIdea.get(t.ideaId) ?? [];

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
