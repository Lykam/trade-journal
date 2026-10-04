// Review ↔ idea join (SPEC §6.11). Reviews attach to ideas, never to single trades.
//
//  1. An "**Idea ID:**" line wins when it names an existing idea.
//  2. Otherwise <DATE>-<TICKER> (header fields, falling back to the file name)
//     matches the idea whose underlying is TICKER and whose open date is DATE.
//     A ticker named for a single-stock ETF resolves to its underlying through
//     symbols.json. If two ideas qualify (a day and a swing idea on the same
//     underlying and date), the review's Trade Type picks one.
//  3. A swing review written when re-entering (dated the re-entry trade's open
//     date rather than the idea's) matches the swing idea containing that trade.
import { etDate } from "../normalize/util";
import type { Idea, ReviewFile, SymbolsMap, Trade } from "../types";
import { parseReviewHeader, parseReviewName, type ReviewHeader } from "./parse-header";

export interface Review {
  /** File stem, e.g. "2026-07-27-ABC"; used in Journal URLs. */
  id: string;
  path: string;
  markdown: string;
  header: ReviewHeader;
  date: string | null;
  ticker: string | null;
  /** The ticker resolved through symbols.json. */
  underlying: string | null;
}

export type JoinMethod = "idea-id" | "date-ticker" | "re-entry";

export interface ReviewJoin {
  /** Newest first. */
  reviews: Review[];
  byId: Map<string, Review>;
  /** review id → idea id */
  ideaOf: Map<string, string>;
  method: Map<string, JoinMethod>;
  /** idea id → its reviews (oldest file first) */
  byIdea: Map<string, Review[]>;
  /** Reviews that match no idea. */
  unmatched: Review[];
  /** Ideas with more than one review. */
  multiple: Array<{ ideaId: string; reviews: Review[] }>;
}

export const reviewIdOf = (path: string) => (path.split(/[\\/]/).pop() ?? path).replace(/\.md$/i, "");

const newestFirst = (a: Review, b: Review) => (b.date ?? "").localeCompare(a.date ?? "") || b.id.localeCompare(a.id);

export function readReviews(files: ReviewFile[], symbols: SymbolsMap): Review[] {
  return files
    .map((f) => {
      const header = parseReviewHeader(f.markdown);
      const name = parseReviewName(f.path);
      const ticker = header.ticker ?? name?.ticker ?? null;
      return {
        id: reviewIdOf(f.path), path: f.path, markdown: f.markdown, header,
        date: header.date ?? name?.date ?? null,
        ticker,
        underlying: ticker ? (symbols[ticker]?.underlying ?? ticker) : null,
      };
    })
    .sort(newestFirst);
}

export function joinReviews(reviews: Review[], data: { ideas: Idea[]; trades: Trade[] }): ReviewJoin {
  const ideasById = new Map(data.ideas.map((i) => [i.id, i]));
  const tradesById = new Map(data.trades.map((t) => [t.id, t]));
  const ideaOf = new Map<string, string>();
  const method = new Map<string, JoinMethod>();
  const unmatched: Review[] = [];

  const pick = (candidates: Idea[], r: Review) =>
    candidates.length <= 1 ? candidates[0] : (candidates.find((i) => i.style === r.header.tradeType) ?? candidates[0]);
  // The underlying, or an ETF actually traded in the idea but missing from symbols.json.
  const sameTicker = (i: Idea, r: Review) => i.underlying === r.underlying || i.symbolsTraded.includes(r.ticker!);

  for (const r of reviews) {
    const pinned = r.header.ideaId ? ideasById.get(r.header.ideaId) : undefined;
    if (pinned) {
      ideaOf.set(r.id, pinned.id);
      method.set(r.id, "idea-id");
      continue;
    }
    if (!r.date || !r.ticker) {
      unmatched.push(r);
      continue;
    }
    const byDate = pick(data.ideas.filter((i) => i.date === r.date && sameTicker(i, r)), r);
    if (byDate) {
      ideaOf.set(r.id, byDate.id);
      method.set(r.id, "date-ticker");
      continue;
    }
    const reentry = pick(
      data.ideas.filter(
        (i) => i.style === "swing" && sameTicker(i, r) &&
          i.tradeIds.some((id) => { const t = tradesById.get(id); return t !== undefined && etDate(t.openedAt) === r.date; }),
      ),
      r,
    );
    if (reentry) {
      ideaOf.set(r.id, reentry.id);
      method.set(r.id, "re-entry");
      continue;
    }
    unmatched.push(r);
  }

  const byIdea = new Map<string, Review[]>();
  for (const r of [...reviews].reverse()) {
    const id = ideaOf.get(r.id);
    if (id) byIdea.set(id, [...(byIdea.get(id) ?? []), r]);
  }
  const multiple = [...byIdea].filter(([, rs]) => rs.length > 1).map(([ideaId, rs]) => ({ ideaId, reviews: rs }));
  return { reviews, byId: new Map(reviews.map((r) => [r.id, r])), ideaOf, method, byIdea, unmatched, multiple };
}
