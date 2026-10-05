// npm run import:tradervue -- [file] [--dry-run] [--history-dir DIR] [--downloads DIR] [--limit N]
//
// One-time import of a Tradervue trades export (SPEC §4.7): Tradervue's tags,
// swing tag and notes become overrides.json entries for the matching journal
// trades, and derived/trades.json is regenerated. Fills are not touched. With
// no file, it uses the one Tradervue trades export in ~/Downloads (found by its
// header). --dry-run prints the preview and writes nothing. Never runs git.
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { parseCsv } from "../src/core/normalize/util";
import { isTradervueTrades } from "../src/core/tradervue/parse";
import { planTradervue, tradervueMessage, tradervuePreview, tradervueWrites } from "../src/core/tradervue/plan";
import { archivedRaw, generatorVersion, loadHistory, resolveHistoryDir, schemaTexts, validate, writeFiles } from "./lib/history";

/** CSVs in a folder whose header is a Tradervue trades export. */
export function findTradervueExports(dir: string): string[] {
  return readdirSync(dir)
    .filter((n) => /\.csv$/i.test(n))
    .map((n) => join(dir, n))
    .filter((p) => {
      const firstLine = readFileSync(p, "utf8").split(/\r?\n/, 1)[0] ?? "";
      return isTradervueTrades(parseCsv(firstLine).header);
    });
}

export function runImportTradervue(argv: string[], log: (s: string) => void = console.log): number {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      "dry-run": { type: "boolean", default: false },
      "history-dir": { type: "string" },
      downloads: { type: "string" },
      limit: { type: "string", default: "40" },
      "style-tag": { type: "string" },
      "note-max": { type: "string" },
      now: { type: "string" }, // for tests: fixed import timestamp
    },
  });
  let file = positionals[0] ? resolve(positionals[0]) : undefined;
  if (!file) {
    const dir = values.downloads ?? join(homedir(), "Downloads");
    const found = findTradervueExports(dir);
    if (found.length !== 1) {
      log(found.length ? `Several Tradervue exports in ${dir}; pass one:\n${found.map((f) => `  ${f}`).join("\n")}` : `No Tradervue trades export in ${dir}.`);
      return 1;
    }
    file = found[0]!;
  }

  const historyDir = resolveHistoryDir(values["history-dir"]);
  const history = loadHistory(historyDir);
  const importedAt = values.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const plan = planTradervue({ name: basename(file), bytes: new Uint8Array(readFileSync(file)) }, history, {
    importedAt,
    styleTag: values["style-tag"],
    noteMax: values["note-max"] ? Number(values["note-max"]) : undefined,
  });
  const dryRun = values["dry-run"];
  const title = `TRADERVUE IMPORT ${dryRun ? "PREVIEW (dry run: nothing written)" : ""}`;
  for (const line of tradervuePreview(plan, { title, target: historyDir, limit: Number(values.limit) })) log(line);

  if (plan.errors.length) {
    log("\nNot writing: fix the errors above first.");
    return 1;
  }
  if (dryRun) return 0;

  const written = writeFiles(
    historyDir,
    tradervueWrites(plan, { generator: generatorVersion(), schemas: schemaTexts(), archived: archivedRaw(historyDir) }, validate),
  );
  log(`\nWrote ${written.length} file(s) to ${historyDir}:`);
  for (const w of written) log(`  ${w}`);
  log(`\nSuggested commit message: ${tradervueMessage(plan)}`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  try {
    process.exitCode = runImportTradervue(process.argv.slice(2));
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
  }
}
