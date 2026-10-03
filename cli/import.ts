// npm run import -- [files…] [--all] [--dry-run] [--history-dir DIR] [--downloads DIR] [--limit N]
//
// Parses Schwab/Webull exports, merges them into trade-history/fills, and
// regenerates derived/trades.json (SPEC §4.5B). --dry-run prints the preview
// and writes nothing. This script never runs git; commits are made by hand
// after the preview is approved.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { importFiles } from "../src/core/normalize";
import { etDate } from "../src/core/normalize/util";
import { buildTrades } from "../src/core/trades";
import { generatorVersion, loadHistory, resolveHistoryDir, writeHistory } from "./lib/history";
import {
  attentionSection, diffTrades, etfTable, filesTable, monthlyTable, summaryTable, tradeRows,
} from "./lib/report";

export const PATTERNS = {
  webull: /^Webull_Orders_Records.*\.csv$/i,
  schwab: /^Trading_.*_Transactions_.*\.csv$/i,
};

/** Export files in a folder: the newest of each broker, or all of them. Oldest first. */
export function findExports(dir: string, all: boolean): string[] {
  const entries = readdirSync(dir)
    .filter((n) => PATTERNS.webull.test(n) || PATTERNS.schwab.test(n))
    .map((n) => ({ path: join(dir, n), name: n, mtime: statSync(join(dir, n)).mtimeMs }));
  const pick = all
    ? entries
    : Object.values(PATTERNS).flatMap((re) => entries.filter((e) => re.test(e.name)).sort((a, b) => b.mtime - a.mtime).slice(0, 1));
  return pick.sort((a, b) => a.mtime - b.mtime).map((e) => e.path);
}

export function runImport(argv: string[], log: (s: string) => void = console.log): number {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      "dry-run": { type: "boolean", default: false },
      all: { type: "boolean", default: false },
      "history-dir": { type: "string" },
      downloads: { type: "string" },
      limit: { type: "string", default: "40" },
      now: { type: "string" }, // for tests: fixed import timestamp
    },
  });
  const dryRun = values["dry-run"];
  const historyDir = resolveHistoryDir(values["history-dir"]);
  const files = positionals.length
    ? positionals.map((p) => resolve(p)) // applied in the order given
    : findExports(values.downloads ?? join(homedir(), "Downloads"), values.all);
  if (!files.length) {
    log("No Schwab or Webull exports found.");
    return 1;
  }

  const history = loadHistory(historyDir);
  const importedAt = values.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const today = etDate(importedAt);
  const result = importFiles(
    files.map((f) => ({ name: basename(f), text: readFileSync(f, "utf8") })),
    history.fills,
    { config: history.config, symbols: history.symbols, importedAt },
  );
  const { trades, ideas, reorderedDays } = buildTrades(result.fills, history);
  const diff = diffTrades(history.derived, trades);
  const limit = Number(values.limit);

  const errors = result.files.flatMap((f) => f.errors.map((e) => `${f.source}: ${e}`));
  const warnings = result.files.flatMap((f) => f.warnings.map((w) => `${f.source}: ${w}`));
  const skipped = result.files.reduce((s, f) => s + Object.values(f.skipped).reduce((a, b) => a + b, 0), 0);
  const dup = result.files.reduce((s, f) => s + f.duplicates, 0);

  log(`IMPORT ${dryRun ? "PREVIEW (dry run: nothing written)" : ""}`);
  log(`trade-history: ${historyDir}\n`);
  log(filesTable(result.files));
  log(`\nTotal: +${result.added.length} new fills, ${dup} duplicates, ${skipped} skipped rows, ${errors.length} errors`);
  log(`Fills after import: ${result.fills.length}  (${result.fills[0] ? etDate(result.fills[0].executedAt) : "—"} → ${result.fills.at(-1) ? etDate(result.fills.at(-1)!.executedAt) : "—"})`);
  for (const e of errors.slice(0, 20)) log(`  ERROR ${e}`);
  for (const w of warnings.slice(0, 20)) log(`  WARN  ${w}`);

  log(`\nNEW ETF SYMBOLS TO MAP (${result.unmappedEtfs.length}) — add to symbols.json`);
  log(result.unmappedEtfs.length ? etfTable(result.unmappedEtfs) : "  none");

  log(`\nTRADES: ${diff.added.length} new, ${diff.changed.length} changed, ${diff.removed.length} removed  ·  ${trades.length} trades in ${ideas.length} ideas`);
  const shown = [...diff.added, ...diff.changed].slice(-limit);
  if (shown.length) {
    log(`(latest ${shown.length}; use --limit to show more)`);
    log(tradeRows(shown));
  }

  log("\nSUMMARY BY STYLE AND BROKER (win % = W ÷ (W+L); unmatched and open trades not scored)");
  log(summaryTable(trades));
  log("\nBY MONTH");
  log(monthlyTable(trades));
  log("");
  log(attentionSection(trades, today, reorderedDays.length));

  if (errors.length) {
    log("\nNot writing: fix the errors above first.");
    return 1;
  }
  if (dryRun) return 0;

  const written = writeHistory(historyDir, {
    fills: result.fills,
    derived: { generated: true, generator: generatorVersion(), trades, ideas },
    archive: files,
    today,
  });
  log(`\nWrote ${written.length} file(s) to ${historyDir}:`);
  for (const w of written) log(`  ${w}`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  try {
    process.exitCode = runImport(process.argv.slice(2));
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
  }
}
