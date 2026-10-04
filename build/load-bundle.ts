// Read the plaintext data the app needs from a trade-history checkout plus the
// local quotes.json. Used by the dev server now and by bundle-data.ts (milestone 4).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { validate } from "../cli/lib/history";
import type { Config, DataBundle, DerivedTrades, SymbolsMap } from "../src/core/types";
import { readQuotes } from "./fetch-quotes";

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;

export function loadBundle(historyDir: string, quotesFile: string): DataBundle {
  const path = (rel: string) => join(historyDir, rel);
  if (!existsSync(path("config.json"))) throw new Error(`no config.json in ${historyDir} (set TRADE_HISTORY_DIR)`);
  if (!existsSync(path("derived/trades.json"))) throw new Error(`no derived/trades.json in ${historyDir} (run npm run import)`);
  const config = readJson<Config>(path("config.json"));
  validate("config", config, "config.json");
  const symbols = existsSync(path("symbols.json")) ? readJson<SymbolsMap>(path("symbols.json")) : {};
  validate("symbols", symbols, "symbols.json");
  const derived = readJson<DerivedTrades>(path("derived/trades.json"));
  validate("trades", derived, "derived/trades.json");
  return { config, symbols, derived, quotes: readQuotes(quotesFile), loadedAt: new Date().toISOString() };
}
