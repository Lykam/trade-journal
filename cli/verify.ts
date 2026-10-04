// npm run verify -- [--history-dir DIR]
//
// Local-only check (never run in CI, SPEC §7): recompute trades from the real
// trade-history, confirm derived/trades.json is up to date, and print totals.
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { etDate } from "../src/core/normalize/util";
import { buildTrades } from "../src/core/trades";
import { loadHistory, resolveHistoryDir } from "./lib/history";
import { attentionSection, diffTrades, monthlyTable, summaryTable } from "../src/core/import/report";

export function runVerify(argv: string[], log: (s: string) => void = console.log): number {
  const { values } = parseArgs({ args: argv, options: { "history-dir": { type: "string" } } });
  const history = loadHistory(resolveHistoryDir(values["history-dir"]));
  const { trades, reorderedDays } = buildTrades(history.fills, history);
  const diff = diffTrades(history.derived, trades);
  const stale = !history.derived || diff.added.length + diff.changed.length + diff.removed.length > 0;

  log(`${history.fills.length} fills · ${trades.length} trades`);
  log(stale
    ? `derived/trades.json is OUT OF DATE (${diff.added.length} new, ${diff.changed.length} changed, ${diff.removed.length} removed)`
    : "derived/trades.json is up to date");
  log("");
  log(summaryTable(trades));
  log("");
  log(monthlyTable(trades));
  log("");
  log(attentionSection(trades, etDate(new Date().toISOString()), reorderedDays.length));
  return stale ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  try {
    process.exitCode = runVerify(process.argv.slice(2));
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
  }
}
