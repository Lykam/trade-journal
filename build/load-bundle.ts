// Read the plaintext data the app needs from a trade-history checkout, a Playbook
// checkout and the local quotes.json. Used by the dev server now and by
// bundle-data.ts (milestone 4).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadHistory, REPO_ROOT, validate } from "../cli/lib/history.ts";
import { lastImports } from "../src/core/imports.ts";
import type { DataBundle } from "../src/core/types.ts";
import { readQuotes } from "./fetch-quotes.ts";
import { readCot } from "./fetch-cot.ts";
import { readRegime } from "./fetch-regime.ts";
import { loadPlaybook } from "./playbook.ts";
import { parseMoversFile } from "../src/core/movers/movers.ts";

export function loadBundle(historyDir: string, quotesFile: string, playbookDir: string, regimeFile: string, cotFile?: string): DataBundle {
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
    imports: lastImports(h.fills),
    overrides: h.overrides,
    quotes: readQuotes(quotesFile),
    regime: readRegime(regimeFile),
    cot: cotFile ? readCot(cotFile) : null,
    playbook: loadPlaybook(playbookDir),
    sayings: h.sayings,
    lookups: h.lookups,
    movers: readMovers(historyDir),
    loadedAt: new Date().toISOString(),
    history: headCommit(historyDir),
  };
}

/**
 * movers.json (Q85): trade-history's copy, which the deploy bundles; without one (dev on the
 * fixtures) the local output of `npm run movers` (MOVERS_FILE or ./movers.json).
 */
export function readMovers(historyDir: string) {
  for (const f of [join(historyDir, "movers.json"), process.env.MOVERS_FILE ?? join(REPO_ROOT, "movers.json")])
    if (existsSync(f)) return parseMoversFile(readFileSync(f, "utf8"));
  return null;
}

/** HEAD of the trade-history checkout, so the app can tell when a deploy includes its commit. */
export function headCommit(dir: string): { sha: string; date: string } | null {
  if (!existsSync(join(dir, ".git"))) return null;
  try {
    const out = execFileSync("git", ["-C", dir, "log", "-1", "--format=%H %cI"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const [sha, date] = out.split(" ");
    return sha && date ? { sha, date: new Date(date).toISOString() } : null;
  } catch {
    return null;
  }
}
