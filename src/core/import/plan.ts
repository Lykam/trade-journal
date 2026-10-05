// One import, start to finish, without I/O (SPEC §4.5): parse and merge the
// CSVs, apply any ETF mappings answered in the preview, regroup the trades,
// build the preview, and list the exact files to write. `npm run import` and
// the Import page both run this, so their previews and files are identical.
import { buildTrades } from "../trades";
import { archiveWrites, derivedWrite, fillsWrites, schemaWrites, jsonText, type FileWrite, type HistorySnapshot } from "../history/files";
import { importFiles, type ImportResult } from "../normalize";
import { etDate } from "../normalize/util";
import type { SchemaTexts, Validate } from "../schema-names";
import type { Idea, SymbolsMap, Trade } from "../types";
import { attentionSection, diffTrades, etfTable, filesTable, monthlyTable, summaryTable, tradeRows } from "./report";

export interface ImportInput {
  name: string;
  bytes: Uint8Array;
}

/** CSV bytes → text the way Node's readFileSync(f, "utf8") does it (a BOM is kept; the parser strips it). */
export const decodeCsv = (bytes: Uint8Array) => new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);

export interface ImportPlan {
  inputs: ImportInput[];
  importedAt: string;
  /** ET date of the import: the archive prefix and the commit message date. */
  today: string;
  result: ImportResult;
  trades: Trade[];
  ideas: Idea[];
  reorderedDays: number;
  diff: ReturnType<typeof diffTrades>;
  errors: string[];
  warnings: string[];
  duplicates: number;
  skipped: number;
  /** "OLD → NEW" → fills (the largest count over the files, since overlapping exports repeat them). */
  renames: Map<string, number>;
  /** symbols.json after the answered mappings. */
  symbols: SymbolsMap;
  /** ETF symbols mapped in this import, sorted. */
  mapped: string[];
}

export function planImport(
  inputs: ImportInput[],
  snap: HistorySnapshot,
  opts: { importedAt: string; mappings?: SymbolsMap },
): ImportPlan {
  const mappings = opts.mappings ?? {};
  const mapped = Object.keys(mappings).filter((s) => !snap.symbols[s]).sort();
  const symbols: SymbolsMap = { ...snap.symbols };
  for (const s of mapped) symbols[s] = mappings[s]!;
  const result = importFiles(
    inputs.map((f) => ({ name: f.name, text: decodeCsv(f.bytes) })),
    snap.fills,
    { config: snap.config, symbols, importedAt: opts.importedAt },
  );
  const { trades, ideas, reorderedDays } = buildTrades(result.fills, { config: snap.config, symbols, overrides: snap.overrides });
  const renames = new Map<string, number>();
  for (const f of result.files) for (const [k, n] of Object.entries(f.renames)) renames.set(k, Math.max(renames.get(k) ?? 0, n));
  return {
    inputs,
    importedAt: opts.importedAt,
    today: etDate(opts.importedAt),
    result,
    trades,
    ideas,
    reorderedDays: reorderedDays.length,
    diff: diffTrades(snap.derived, trades),
    errors: result.files.flatMap((f) => f.errors.map((e) => `${f.source}: ${e}`)),
    warnings: result.files.flatMap((f) => f.warnings.map((w) => `${f.source}: ${w}`)),
    duplicates: result.files.reduce((s, f) => s + f.duplicates, 0),
    skipped: result.files.reduce((s, f) => s + Object.values(f.skipped).reduce((a, b) => a + b, 0), 0),
    renames,
    symbols,
    mapped,
  };
}

/** The dry-run preview, line for line as `npm run import -- --dry-run` prints it. */
export function previewLines(p: ImportPlan, opts: { title: string; target: string; limit?: number }): string[] {
  const out: string[] = [];
  const { result, diff } = p;
  const limit = opts.limit ?? 40;
  out.push(opts.title);
  out.push(`trade-history: ${opts.target}\n`);
  out.push(filesTable(result.files));
  out.push(`\nTotal: +${result.added.length} new fills, ${p.duplicates} duplicates, ${p.skipped} skipped rows, ${p.errors.length} errors`);
  out.push(`Fills after import: ${result.fills.length}  (${result.fills[0] ? etDate(result.fills[0].executedAt) : "—"} → ${result.fills.at(-1) ? etDate(result.fills.at(-1)!.executedAt) : "—"})`);
  for (const e of p.errors.slice(0, 20)) out.push(`  ERROR ${e}`);
  for (const w of p.warnings.slice(0, 20)) out.push(`  WARN  ${w}`);

  out.push(`\nTICKER CHANGES (${p.renames.size}) — Webull now reports these fills under a new symbol; the original symbol is kept`);
  out.push(p.renames.size ? [...p.renames].map(([k, n]) => `  ${k}  (${n} fills)`).join("\n") : "  none");

  if (p.mapped.length) out.push(`\nETF SYMBOLS MAPPED IN THIS IMPORT (${p.mapped.length}): ${p.mapped.join(", ")} — written to symbols.json`);
  out.push(`\nNEW ETF SYMBOLS TO MAP (${result.unmappedEtfs.length}) — add to symbols.json`);
  out.push(result.unmappedEtfs.length ? etfTable(result.unmappedEtfs) : "  none");

  out.push(`\nTRADES: ${diff.added.length} new, ${diff.changed.length} changed, ${diff.removed.length} removed  ·  ${p.trades.length} trades in ${p.ideas.length} ideas`);
  const shown = limit > 0 ? [...diff.added, ...diff.changed].slice(-limit) : [];
  if (shown.length) {
    out.push(`(latest ${shown.length}; use --limit N to change)`);
    out.push(tradeRows(shown));
  }

  out.push("\nSUMMARY BY STYLE AND BROKER (win % = W ÷ (W+L); unmatched and open trades not scored)");
  out.push(summaryTable(p.trades));
  out.push("\nBY MONTH");
  out.push(monthlyTable(p.trades));
  out.push("");
  out.push(attentionSection(p.trades, p.today, p.reorderedDays));
  return out;
}

/**
 * Every file the import writes: fills/<year>.json, symbols.json (only when an
 * ETF was mapped), derived/trades.json, the schema copies and the raw CSVs not
 * already archived. Callers skip files whose content is unchanged.
 */
export function importWrites(
  p: ImportPlan,
  ctx: { generator: string; schemas: SchemaTexts; archived: { paths: Set<string>; blobShas: Set<string> } },
  validate: Validate,
): FileWrite[] {
  if (p.errors.length) throw new Error("the import has errors; nothing can be written");
  const out = fillsWrites(p.result.fills, validate);
  if (p.mapped.length) {
    validate("symbols", p.symbols, "symbols.json");
    out.push({ path: "symbols.json", content: jsonText(p.symbols) });
  }
  out.push(derivedWrite({ generated: true, generator: ctx.generator, trades: p.trades, ideas: p.ideas }, validate));
  out.push(...schemaWrites(ctx.schemas));
  out.push(...archiveWrites(p.inputs, p.today, ctx.archived));
  return out;
}

const BROKER_LABEL = { webull: "Webull", schwab: "Schwab" } as const;

/** "Import Webull 2026-10-03: +42 fills" (plus ", 1 ETF mapped"). No symbols or file names. */
export function importMessage(p: ImportPlan): string {
  const brokers = [...new Set(p.result.files.map((f) => f.broker).filter((b) => b !== null))].sort().reverse();
  const label = brokers.map((b) => BROKER_LABEL[b]).join(" + ") || "CSV";
  const mapped = p.mapped.length ? `, ${p.mapped.length} ETF${p.mapped.length === 1 ? "" : "s"} mapped` : "";
  return `Import ${label} ${p.today}: +${p.result.added.length} fill${p.result.added.length === 1 ? "" : "s"}${mapped}`;
}

/** What the user approved: if a retry after main moved gives a different answer, the preview must be shown again. */
export function importFingerprint(p: ImportPlan): string {
  return JSON.stringify({
    added: p.result.added.map((f) => f.id).sort(),
    errors: p.errors.length,
    mapped: p.mapped,
    trades: [p.diff.added.length, p.diff.changed.length, p.diff.removed.length],
  });
}

/**
 * Oldest export first, the same rule for the Import page and the CLI (SPEC
 * §4.5). Order matters because Webull keeps the first-seen symbol (Q18).
 * 1. The file's modified time, when both files have one: Webull's numbering
 *    restarts after Downloads is cleaned, so an old "(3)" can predate a new
 *    unnumbered export.
 * 2. Then the name: Webull numbers re-downloads (Webull_Orders_Records.csv,
 *    then (1), (2), …) and Schwab stamps the export time
 *    (…_Transactions_20260930-194206.csv).
 * 3. Then the plain name.
 */
export function exportOrder<T extends { name: string; lastModified?: number }>(files: T[]): T[] {
  const key = (f: T): [number, string] => {
    const wb = /^Webull_Orders_Records(?:\((\d+)\))?\.csv$/i.exec(f.name);
    if (wb) return [0, String(Number(wb[1] ?? 0)).padStart(6, "0")];
    const sw = /_Transactions_(\d{8}-\d{6})\.csv$/i.exec(f.name);
    if (sw) return [1, sw[1]!];
    return [2, ""];
  };
  return [...files].sort((a, b) => {
    const [ga, ka] = key(a);
    const [gb, kb] = key(b);
    const ta = a.lastModified ?? 0;
    const tb = b.lastModified ?? 0;
    return (ta && tb ? ta - tb : 0) || ga - gb || ka.localeCompare(kb) || a.name.localeCompare(b.name);
  });
}
