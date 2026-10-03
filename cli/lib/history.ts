// Node-only I/O for the trade-history repo. All logic lives in src/core.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv } from "ajv";
import { etDate } from "../../src/core/normalize/util";
import type { Config, DerivedTrades, Fill, FillsFile, Overrides, SymbolsMap } from "../../src/core/types";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SCHEMA_DIR = join(REPO_ROOT, "schema");
const SCHEMAS = ["fills", "overrides", "config", "symbols", "trades"] as const;
type SchemaName = (typeof SCHEMAS)[number];

export function generatorVersion(): string {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { version: string };
  return `trade-journal@${pkg.version}`;
}

export function resolveHistoryDir(flag?: string): string {
  return resolve(flag ?? process.env.TRADE_HISTORY_DIR ?? join(REPO_ROOT, "..", "trade-history"));
}

const ajv = new Ajv({ allErrors: true });
const validators = new Map<SchemaName, ReturnType<typeof ajv.compile>>();

export function validate(name: SchemaName, data: unknown, label: string): void {
  let v = validators.get(name);
  if (!v) {
    v = ajv.compile(JSON.parse(readFileSync(join(SCHEMA_DIR, `${name}.schema.json`), "utf8")));
    validators.set(name, v);
  }
  if (!v(data)) {
    const errs = (v.errors ?? []).slice(0, 5).map((e) => `  ${e.instancePath || "/"} ${e.message}`);
    throw new Error(`${label} does not match ${name}.schema.json:\n${errs.join("\n")}`);
  }
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export interface History {
  dir: string;
  config: Config;
  symbols: SymbolsMap;
  overrides: Overrides;
  fills: Fill[];
  derived: DerivedTrades | null;
}

export function loadHistory(dir: string): History {
  const configPath = join(dir, "config.json");
  if (!existsSync(configPath)) throw new Error(`no config.json in ${dir} (set --history-dir or TRADE_HISTORY_DIR)`);
  const config = readJson<Config>(configPath);
  validate("config", config, "config.json");

  const symbolsPath = join(dir, "symbols.json");
  const symbols = existsSync(symbolsPath) ? readJson<SymbolsMap>(symbolsPath) : {};
  validate("symbols", symbols, "symbols.json");

  const overridesPath = join(dir, "overrides.json");
  const overrides = existsSync(overridesPath)
    ? readJson<Overrides>(overridesPath)
    : { trades: {}, openingPositions: [] };
  validate("overrides", overrides, "overrides.json");

  const fills: Fill[] = [];
  const fillsDir = join(dir, "fills");
  if (existsSync(fillsDir)) {
    for (const f of readdirSync(fillsDir).filter((n) => /^\d{4}\.json$/.test(n)).sort()) {
      const file = readJson<FillsFile>(join(fillsDir, f));
      validate("fills", file, `fills/${f}`);
      fills.push(...file.fills);
    }
  }

  const derivedPath = join(dir, "derived", "trades.json");
  const derived = existsSync(derivedPath) ? readJson<DerivedTrades>(derivedPath) : null;
  return { dir, config, symbols, overrides, fills, derived };
}

const json = (data: unknown) => `${JSON.stringify(data, null, 2)}\n`;
const sha = (buf: Buffer | string) => createHash("sha256").update(buf).digest("hex");

/**
 * Write fills/<year>.json, derived/trades.json, schema copies and raw CSV
 * archives. Returns the paths written, relative to the history dir.
 */
export function writeHistory(
  dir: string,
  data: { fills: Fill[]; derived: DerivedTrades; archive: string[]; today: string },
): string[] {
  const written: string[] = [];
  const put = (rel: string, content: string) => {
    const path = join(dir, rel);
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path) && readFileSync(path, "utf8") === content) return;
    writeFileSync(path, content);
    written.push(rel);
  };

  const byYear = new Map<string, Fill[]>();
  for (const f of data.fills) {
    const y = etDate(f.executedAt).slice(0, 4);
    byYear.set(y, [...(byYear.get(y) ?? []), f]);
  }
  for (const [year, fills] of byYear) {
    const file: FillsFile = { schemaVersion: 1, fills };
    validate("fills", file, `fills/${year}.json`);
    put(`fills/${year}.json`, json(file));
  }

  validate("trades", data.derived, "derived/trades.json");
  put("derived/trades.json", json(data.derived));

  for (const name of SCHEMAS) put(`schema/${name}.schema.json`, readFileSync(join(SCHEMA_DIR, `${name}.schema.json`), "utf8"));

  // Archive each original CSV once; identical content already archived is skipped.
  const rawDir = join(dir, "imports", "raw");
  mkdirSync(rawDir, { recursive: true });
  const archived = new Set(readdirSync(rawDir).map((n) => sha(readFileSync(join(rawDir, n)))));
  for (const src of data.archive) {
    const buf = readFileSync(src);
    if (archived.has(sha(buf))) continue;
    let rel = `imports/raw/${data.today}-${basename(src)}`;
    for (let n = 2; existsSync(join(dir, rel)); n++) rel = `imports/raw/${data.today}-${n}-${basename(src)}`;
    copyFileSync(src, join(dir, rel));
    archived.add(sha(buf));
    written.push(rel);
  }
  return written;
}
