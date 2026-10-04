// The trade-history repo as files (SPEC §3): parsing what is read, and the
// exact bytes to write. Shared by the CLI (Node fs) and the app (GitHub API), so
// an import or override edit produces byte-identical files either way.
import { sha1 } from "@noble/hashes/legacy.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { etDate } from "../normalize/util";
import { SCHEMAS, type SchemaTexts, type Validate } from "../schema-names";
import type { Config, DerivedTrades, Fill, FillsFile, Overrides, SymbolsMap } from "../types";

export interface HistorySnapshot {
  config: Config;
  symbols: SymbolsMap;
  overrides: Overrides;
  fills: Fill[];
  derived: DerivedTrades | null;
}

/** Raw file texts of a trade-history checkout; optional files may be missing. */
export interface HistoryTexts {
  config: string;
  symbols?: string;
  overrides?: string;
  /** fills/<year>.json, by file name. */
  fills: Array<{ name: string; text: string }>;
  derived?: string;
}

export interface FileWrite {
  path: string;
  content: string | Uint8Array;
}

export const FILLS_FILE_RE = /^\d{4}\.json$/;
export const jsonText = (data: unknown) => `${JSON.stringify(data, null, 2)}\n`;
const utf8 = new TextEncoder();
export const bytesOf = (content: string | Uint8Array) => (typeof content === "string" ? utf8.encode(content) : content);

/** Git's object id for a blob: SHA-1 of "blob <size>\0" + content. Lets both writers skip unchanged files and archived CSVs. */
export function gitBlobSha(content: string | Uint8Array): string {
  const body = bytesOf(content);
  const head = utf8.encode(`blob ${body.length}\0`);
  const all = new Uint8Array(head.length + body.length);
  all.set(head, 0);
  all.set(body, head.length);
  return bytesToHex(sha1(all));
}

/** Parse and schema-validate everything the importer and the override editor read. */
export function parseHistory(t: HistoryTexts, validate: Validate): HistorySnapshot {
  const config = JSON.parse(t.config) as Config;
  validate("config", config, "config.json");
  const symbols = t.symbols === undefined ? {} : (JSON.parse(t.symbols) as SymbolsMap);
  validate("symbols", symbols, "symbols.json");
  const overrides = t.overrides === undefined ? { trades: {}, openingPositions: [] } : (JSON.parse(t.overrides) as Overrides);
  validate("overrides", overrides, "overrides.json");
  const fills: Fill[] = [];
  for (const f of t.fills.filter((x) => FILLS_FILE_RE.test(x.name)).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = JSON.parse(f.text) as FillsFile;
    validate("fills", file, `fills/${f.name}`);
    fills.push(...file.fills);
  }
  const derived = t.derived === undefined ? null : (JSON.parse(t.derived) as DerivedTrades);
  return { config, symbols, overrides, fills, derived };
}

/** fills/<year>.json for every execution year (ET), in the stored format. */
export function fillsWrites(fills: Fill[], validate: Validate): FileWrite[] {
  const byYear = new Map<string, Fill[]>();
  for (const f of fills) {
    const y = etDate(f.executedAt).slice(0, 4);
    byYear.set(y, [...(byYear.get(y) ?? []), f]);
  }
  return [...byYear].map(([year, list]) => {
    const file: FillsFile = { schemaVersion: 1, fills: list };
    validate("fills", file, `fills/${year}.json`);
    return { path: `fills/${year}.json`, content: jsonText(file) };
  });
}

export function derivedWrite(derived: DerivedTrades, validate: Validate): FileWrite {
  validate("trades", derived, "derived/trades.json");
  return { path: "derived/trades.json", content: jsonText(derived) };
}

/** The canonical schemas, copied into trade-history on every write (Q17). */
export function schemaWrites(schemas: SchemaTexts): FileWrite[] {
  return SCHEMAS.map((name) => ({ path: `schema/${name}.schema.json`, content: schemas[name] }));
}

/**
 * Archive each original CSV once under imports/raw/<today>-<name>. A file whose
 * exact bytes are already archived (by git blob id) is skipped, and a name
 * already taken gets -2-, -3-, … .
 */
export function archiveWrites(
  inputs: Array<{ name: string; bytes: Uint8Array }>,
  today: string,
  existing: { paths: Set<string>; blobShas: Set<string> },
): FileWrite[] {
  const out: FileWrite[] = [];
  const paths = new Set(existing.paths);
  const shas = new Set(existing.blobShas);
  for (const f of inputs) {
    const sha = gitBlobSha(f.bytes);
    if (shas.has(sha)) continue;
    let path = `imports/raw/${today}-${f.name}`;
    for (let n = 2; paths.has(path); n++) path = `imports/raw/${today}-${n}-${f.name}`;
    out.push({ path, content: f.bytes });
    paths.add(path);
    shas.add(sha);
  }
  return out;
}
