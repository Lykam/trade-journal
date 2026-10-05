// npm run quotes -- [--history-dir DIR] [--out FILE]
//
// Price the open positions from trade-history/derived/trades.json and write
// quotes.json (SPEC §5.4). quotes.json is gitignored and never committed.
// Output is counts only: symbols are never printed. With TJ_PUBLIC_LOG=1 (the
// workflows, whose logs are public) not even counts are printed (Q35).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadHistory, REPO_ROOT, resolveHistoryDir } from "../cli/lib/history";
import { mergeQuotes, openSymbols, quoteCounts } from "../src/core/quotes";
import type { Quote, QuotesFile } from "../src/core/types";
import { isPublicLog, runMain } from "./public-log";

/** A source of last prices. Swap in another implementation (Finnhub, Alpaca…) without touching callers. */
export interface QuoteProvider {
  readonly name: string;
  /** Quotes for the symbols it could price; missing symbols are simply absent. */
  fetch(symbols: string[]): Promise<Record<string, Quote>>;
}

const silent = { info() {}, warn() {}, error() {}, debug() {}, dir() {} };

export class YahooProvider implements QuoteProvider {
  readonly name = "yahoo";

  async fetch(symbols: string[]): Promise<Record<string, Quote>> {
    if (!symbols.length) return {};
    const { default: YahooFinance } = await import("yahoo-finance2");
    // The library logs validation details that can include symbols, so it gets a silent logger.
    const yf = new YahooFinance({ logger: silent, suppressNotices: ["yahooSurvey"], validation: { logErrors: false } });
    const rows = await yf.quote(symbols, { return: "array" }, { validateResult: false });
    const out: Record<string, Quote> = {};
    for (const r of rows as Array<{ symbol?: string; regularMarketPrice?: number; regularMarketTime?: Date | number; marketState?: string }>) {
      if (!r.symbol || typeof r.regularMarketPrice !== "number" || !r.regularMarketTime) continue;
      const time = r.regularMarketTime instanceof Date ? r.regularMarketTime : new Date(Number(r.regularMarketTime) * 1000);
      out[r.symbol] = { price: r.regularMarketPrice, time: time.toISOString(), ...(r.marketState ? { marketState: r.marketState } : {}) };
    }
    return out;
  }
}

export function resolveQuotesFile(flag?: string): string {
  return resolve(flag ?? process.env.QUOTES_FILE ?? join(REPO_ROOT, "quotes.json"));
}

export function readQuotes(path: string): QuotesFile | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as QuotesFile;
  } catch {
    return null;
  }
}

export async function runFetchQuotes(
  argv: string[],
  opts: { provider?: QuoteProvider; now?: string; log?: (s: string) => void; publicLog?: boolean } = {},
): Promise<number> {
  const log = opts.log ?? console.log;
  const publicLog = opts.publicLog ?? isPublicLog();
  const { values } = parseArgs({ args: argv, options: { "history-dir": { type: "string" }, out: { type: "string" } } });
  const history = loadHistory(resolveHistoryDir(values["history-dir"]));
  if (!history.derived) {
    log("no derived/trades.json: run npm run import first");
    return 1;
  }
  const out = resolveQuotesFile(values.out);
  const provider = opts.provider ?? new YahooProvider();
  const now = opts.now ?? new Date().toISOString();
  const symbols = openSymbols(history.derived.trades);
  const prev = readQuotes(out);

  let fetched: Record<string, Quote> = {};
  let failed = false;
  try {
    fetched = await provider.fetch(symbols);
  } catch (e) {
    failed = true;
    // Error messages can echo the request (symbols), so only the error type is printed.
    log(`quotes: ${provider.name} fetch failed (${(e as Error)?.name ?? "error"}); keeping previous quotes, marked stale`);
  }

  const file = mergeQuotes(prev, fetched, symbols, now);
  writeFileSync(out, `${JSON.stringify(file, null, 2)}\n`);
  const c = quoteCounts(file, symbols);
  if (publicLog) log(`quotes: ${c.fresh === c.requested ? "all open positions priced" : "some open positions not freshly priced"} (${provider.name})`);
  else log(`quotes: ${c.requested} open symbols · ${c.fresh} priced · ${c.stale} stale · ${c.missing} missing (${provider.name})`);
  return failed && c.requested > 0 && c.fresh + c.stale === 0 ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  await runMain("quotes", () => runFetchQuotes(process.argv.slice(2)));
}
