// The private values that must never reach this public repo or the built site
// (SPEC §7, §8), read from the sibling checkouts. One list for both guards:
// `npm run scan` (source, docs, commit messages) and `check-dist` (dist/).
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadHistory } from "../cli/lib/history";
import { reviewIdOf } from "../src/core/reviews/join";
import { parseReviewHeader } from "../src/core/reviews/parse-header";
import { readQuotes } from "./fetch-quotes";
import { loadPlaybook } from "./playbook";

export interface PrivateTokens {
  /** Traded symbols, their underlyings, symbols.json entries, quoted symbols and review tickers. */
  symbols: Set<string>;
  /** Review and image file names (see playbookNames). */
  names: Set<string>;
  /** Schwab account ids from config.json schwabAccounts. */
  accountIds: Set<string>;
  /** Stored fill ids (wb-… / sc-…). */
  fillIds: Set<string>;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Symbols that appear as whole tokens. 1–2 letter symbols only count inside quotes (minified code is full of short identifiers). */
export function findLeaks(text: string, symbols: Iterable<string>): string[] {
  const hits: string[] = [];
  for (const s of symbols) {
    const re = s.length <= 2 ? new RegExp(`["'\`]${escape(s)}["'\`]`) : new RegExp(`(?<![A-Za-z0-9_$])${escape(s)}(?![A-Za-z0-9_$])`);
    if (re.test(text)) hits.push(s);
  }
  return hits;
}

/**
 * Private names that must never reach dist/: each review's file name and stem
 * ("2026-07-27-ABC.md", "2026-07-27-ABC") and each image's path and file name.
 */
export function playbookNames(playbook: { reviews: Array<{ path: string }>; images: string[] }): Set<string> {
  const names = new Set<string>();
  for (const r of playbook.reviews) {
    names.add(r.path.split("/").pop()!);
    names.add(reviewIdOf(r.path));
  }
  for (const i of playbook.images) {
    names.add(i);
    names.add(i.split("/").pop()!);
  }
  return names;
}

/** Everything private in the checkouts, or null without a trade-history checkout. */
export function privateTokens(historyDir: string, playbookDir: string, quotesFile?: string): PrivateTokens | null {
  if (!existsSync(join(historyDir, "config.json"))) return null;
  const h = loadHistory(historyDir);
  const playbook = loadPlaybook(playbookDir) ?? { reviews: [], images: [] };
  return {
    symbols: new Set<string>([
      ...h.fills.map((f) => f.symbol),
      ...(h.derived?.trades ?? []).flatMap((t) => [t.symbol, t.underlying]),
      ...Object.entries(h.symbols).flatMap(([etf, s]) => [etf, s.underlying]),
      ...Object.keys((quotesFile ? readQuotes(quotesFile)?.quotes : undefined) ?? {}),
      ...playbook.reviews.map((r) => parseReviewHeader(r.markdown).ticker).filter((t): t is string => t !== null),
    ]),
    names: playbookNames(playbook),
    accountIds: new Set(Object.keys(h.config.schwabAccounts)),
    fillIds: new Set(h.fills.map((f) => f.id)),
  };
}
