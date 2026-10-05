// What `npm run scan` looks for in text bound for this public repo (SPEC §7, §8,
// Q47). Pure, so it is unit-tested with fake values. Unlike check-dist (which
// reads minified JS, full of short identifiers), the scan reads source,
// markdown and commit messages, so 1–2 letter symbols are matched as whole
// words, minus a fixed list of common words that are never treated as tickers.
import { findLeaks } from "../../build/check-dist";

export interface PrivateTokens {
  /** Traded symbols, underlyings and review tickers. */
  symbols: Set<string>;
  /** Review and image file names (see playbookNames). */
  names: Set<string>;
  /** Schwab account ids from config.json schwabAccounts. */
  accountIds: Set<string>;
  /** Stored fill ids (wb-… / sc-…). */
  fillIds: Set<string>;
}

/**
 * Generic 1–2 letter words (English, UI and code) skipped as short tickers.
 * A fixed list, not derived from the data, so it says nothing about what was traded.
 */
export const SHORT_WORDS = new Set(
  ("A I AM AN AS AT BE BY DO GO HE IF IN IS IT ME MY NO OF OK ON OR SO TO UP US WE " +
    "AD AI ET PM ID IO OS PR CI CD UI UX JS TS QA EG IE VS NB PS DB GB KB MB TB " +
    "L R W X Y Z").split(" "),
);

/** Short symbols as whole words: no letter, digit, "_" or "$" on either side, and not a common word. */
function shortWordHits(text: string, symbols: Iterable<string>): string[] {
  const out: string[] = [];
  for (const s of symbols) {
    if (s.length > 2 || SHORT_WORDS.has(s)) continue;
    if (new RegExp(`(?<![A-Za-z0-9_$])${s}(?![A-Za-z0-9_$])`).test(text)) out.push(s);
  }
  return out;
}

/** The forms an account id takes in exports and config: XXX<id> (file names), …<id> / ...<id> (masked), "<id>" / '<id>' (JSON keys). */
function accountHit(text: string, id: string): boolean {
  return new RegExp(`(?:XXX|\\.\\.\\.|…)${id}(?!\\d)|["']${id}["']`).test(text);
}

/** Labels of everything private found in `text`. Account ids are reported without their value. */
export function scanText(text: string, t: PrivateTokens): string[] {
  const hits = [...new Set([...findLeaks(text, t.symbols), ...shortWordHits(text, t.symbols)])];
  hits.push(...[...t.names].filter((n) => text.includes(n)));
  if ([...t.accountIds].some((id) => accountHit(text, id))) hits.push("(a Schwab account id)");
  for (const m of text.matchAll(/(?<![\w-])(?:wb|sc)-[0-9a-f]{12}(?![\w-])/g)) if (t.fillIds.has(m[0])) hits.push(`fill id ${m[0]}`);
  return hits;
}
