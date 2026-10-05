// quotes.json bookkeeping (SPEC §5.4). Pure; the network part lives in build/fetch-quotes.ts.
import type { Quote, QuotesFile, Trade } from "./types.ts";

/** Symbols to price: every open position's own symbol (the ETF held, not its underlying). */
export function openSymbols(trades: Trade[]): string[] {
  return [...new Set(trades.filter((t) => t.status === "open").map((t) => t.symbol))].sort();
}

/**
 * Combine a fetch with the previous quotes.json. Fetched symbols get fresh
 * quotes; a requested symbol the fetch missed keeps its previous quote marked
 * stale; symbols no longer held are dropped. `asOf` only moves on success.
 */
export function mergeQuotes(
  prev: QuotesFile | null,
  fetched: Record<string, Quote>,
  symbols: string[],
  now: string,
): QuotesFile {
  const quotes: Record<string, Quote> = {};
  for (const s of symbols) {
    const fresh = fetched[s];
    const old = prev?.quotes[s];
    if (fresh) quotes[s] = { price: fresh.price, time: fresh.time, ...(fresh.marketState ? { marketState: fresh.marketState } : {}) };
    else if (old) quotes[s] = { ...old, stale: true };
  }
  const anyFresh = symbols.some((s) => fetched[s]);
  return { asOf: anyFresh ? now : (prev?.asOf ?? now), attemptedAt: now, quotes };
}

export function quoteCounts(file: QuotesFile, symbols: string[]) {
  const got = symbols.filter((s) => file.quotes[s]);
  const stale = got.filter((s) => file.quotes[s]!.stale).length;
  return { requested: symbols.length, fresh: got.length - stale, stale, missing: symbols.length - got.length };
}
