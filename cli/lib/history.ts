// Node-only I/O for the trade-history repo. All logic lives in src/core.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bytesOf, gitBlobSha, parseHistory, type FileWrite, type HistorySnapshot } from "../../src/core/history/files.ts";
import { makeValidator, SCHEMAS, type SchemaName, type SchemaTexts } from "../../src/core/schema.ts";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SCHEMA_DIR = join(REPO_ROOT, "schema");

export function generatorVersion(): string {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { version: string };
  return `trade-journal@${pkg.version}`;
}

export function resolveHistoryDir(flag?: string): string {
  return resolve(flag ?? process.env.TRADE_HISTORY_DIR ?? join(REPO_ROOT, "..", "trade-history"));
}

export function schemaTexts(): SchemaTexts {
  return Object.fromEntries(SCHEMAS.map((n) => [n, readFileSync(join(SCHEMA_DIR, `${n}.schema.json`), "utf8")])) as SchemaTexts;
}

const validator = makeValidator(schemaTexts());

export function validate(name: SchemaName, data: unknown, label: string): void {
  validator(name, data, label);
}

export interface History extends HistorySnapshot {
  dir: string;
}

const readIf = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : undefined);

export function loadHistory(dir: string): History {
  const config = readIf(join(dir, "config.json"));
  if (config === undefined) throw new Error(`no config.json in ${dir} (set --history-dir or TRADE_HISTORY_DIR)`);
  const fillsDir = join(dir, "fills");
  const snap = parseHistory(
    {
      config,
      symbols: readIf(join(dir, "symbols.json")),
      overrides: readIf(join(dir, "overrides.json")),
      fills: existsSync(fillsDir) ? readdirSync(fillsDir).map((name) => ({ name, text: readFileSync(join(fillsDir, name), "utf8") })) : [],
      derived: readIf(join(dir, "derived", "trades.json")),
    },
    validate,
  );
  return { dir, ...snap };
}

/** What is already archived in imports/raw/, for skipping CSVs archived before. */
export function archivedRaw(dir: string): { paths: Set<string>; blobShas: Set<string> } {
  const rawDir = join(dir, "imports", "raw");
  const names = existsSync(rawDir) ? readdirSync(rawDir) : [];
  return {
    paths: new Set(names.map((n) => `imports/raw/${n}`)),
    blobShas: new Set(names.map((n) => gitBlobSha(readFileSync(join(rawDir, n))))),
  };
}

/** Write the files whose content changed. Returns the paths written, relative to the history dir. */
export function writeFiles(dir: string, files: FileWrite[]): string[] {
  const written: string[] = [];
  for (const f of files) {
    const path = join(dir, f.path);
    const bytes = bytesOf(f.content);
    if (existsSync(path) && Buffer.compare(readFileSync(path), bytes) === 0) continue;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
    written.push(f.path);
  }
  return written;
}
