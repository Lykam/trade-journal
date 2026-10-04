// Read the plaintext data the app needs from a trade-history checkout, a Playbook
// checkout and the local quotes.json. Used by the dev server now and by
// bundle-data.ts (milestone 4).
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadHistory, validate } from "../cli/lib/history";
import type { DataBundle } from "../src/core/types";
import { readQuotes } from "./fetch-quotes";
import { loadPlaybook } from "./playbook";

export function loadBundle(historyDir: string, quotesFile: string, playbookDir: string): DataBundle {
  if (!existsSync(join(historyDir, "config.json"))) throw new Error(`no config.json in ${historyDir} (set TRADE_HISTORY_DIR)`);
  const h = loadHistory(historyDir);
  if (!h.derived) throw new Error(`no derived/trades.json in ${historyDir} (run npm run import)`);
  validate("trades", h.derived, "derived/trades.json");
  return {
    config: h.config,
    symbols: h.symbols,
    derived: h.derived,
    // Source file names carry broker account ids; the app never needs them.
    fills: h.fills.map((f) => ({ ...f, source: "", importedAt: "" })),
    overrides: h.overrides,
    quotes: readQuotes(quotesFile),
    playbook: loadPlaybook(playbookDir),
    loadedAt: new Date().toISOString(),
  };
}
