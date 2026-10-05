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
import { exportOrder, importWrites, planImport, previewLines } from "../src/core/import/plan";
import { archivedRaw, generatorVersion, loadHistory, resolveHistoryDir, schemaTexts, validate, writeFiles } from "./lib/history";

export const PATTERNS = {
  webull: /^Webull_Orders_Records.*\.csv$/i,
  schwab: /^Trading_.*_Transactions_.*\.csv$/i,
};

/** Export files in a folder: the newest of each broker, or all of them. Oldest first. */
export function findExports(dir: string, all: boolean): string[] {
  const entries = readdirSync(dir)
    .filter((n) => PATTERNS.webull.test(n) || PATTERNS.schwab.test(n))
    .map((n) => ({ path: join(dir, n), name: n, lastModified: statSync(join(dir, n)).mtimeMs }));
  const pick = all
    ? entries
    : Object.values(PATTERNS).flatMap((re) => exportOrder(entries.filter((e) => re.test(e.name))).slice(-1));
  // The Import page's rule, so both paths apply the same exports in the same order.
  return exportOrder(pick).map((e) => e.path);
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
  const inputs = files.map((f) => ({ name: basename(f), bytes: new Uint8Array(readFileSync(f)) }));
  const plan = planImport(inputs, history, { importedAt });
  const title = `IMPORT ${dryRun ? "PREVIEW (dry run: nothing written)" : ""}`;
  for (const line of previewLines(plan, { title, target: historyDir, limit: Number(values.limit) })) log(line);

  if (plan.errors.length) {
    log("\nNot writing: fix the errors above first.");
    return 1;
  }
  if (dryRun) return 0;

  const written = writeFiles(
    historyDir,
    importWrites(plan, { generator: generatorVersion(), schemas: schemaTexts(), archived: archivedRaw(historyDir) }, validate),
  );
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
