// Read the plaintext data the app needs from a trade-history checkout, a Playbook
// checkout and the local quotes.json. Used by the dev server now and by
// bundle-data.ts (milestone 4).
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadHistory, validate } from "../cli/lib/history.ts";
import { lastImports } from "../src/core/imports.ts";
import type { DataBundle, WatchlistScanFile, WatchlistScanThesisFile } from "../src/core/types.ts";
import { readQuotes } from "./fetch-quotes.ts";
import { readRegime } from "./fetch-regime.ts";
import { loadPlaybook } from "./playbook.ts";

/** watchlist-scan.json lives in the trade-history checkout (committed by the Claude skill, not generated here) and has no schema validation yet — read it best-effort. */
function readWatchlistScan(historyDir: string): WatchlistScanFile | null {
  const path = join(historyDir, "watchlist-scan.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as WatchlistScanFile;
  } catch {
    return null;
  }
}

/**
 * The most recent <date>-pm-thesis.json in watchlist-scans/, unless the morning routine has
 * already finalized the day it forecasts (its <date>.json archive exists) — at that point the
 * live `watchlist-scan.json` is the authoritative version and the thesis is stale, so this
 * returns null rather than show a superseded preview.
 */
function readWatchlistScanThesis(historyDir: string): WatchlistScanThesisFile | null {
  const dir = join(historyDir, "watchlist-scans");
  if (!existsSync(dir)) return null;
  const theses = readdirSync(dir).filter((f) => f.endsWith("-pm-thesis.json")).sort();
  const latest = theses.at(-1);
  if (!latest) return null;
  let parsed: WatchlistScanThesisFile;
  try {
    parsed = JSON.parse(readFileSync(join(dir, latest), "utf8")) as WatchlistScanThesisFile;
  } catch {
    return null;
  }
  if (!parsed.thesisFor) return null;
  if (existsSync(join(dir, `${parsed.thesisFor}.json`))) return null;
  return parsed;
}

export function loadBundle(historyDir: string, quotesFile: string, playbookDir: string, regimeFile: string): DataBundle {
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
    watchlistScan: readWatchlistScan(historyDir),
    watchlistScanThesis: readWatchlistScanThesis(historyDir),
    playbook: loadPlaybook(playbookDir),
    loadedAt: new Date().toISOString(),
    history: headCommit(historyDir),
  };
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
