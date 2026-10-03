import type { Broker, Config, Fill, SymbolsMap } from "../types";
import { mergeFills } from "./dedupe";
import { guessLeveragedEtf, type EtfGuess } from "./etf";
import { parseSchwab, schwabAccountId, SCHWAB_HEADER } from "./schwab";
import { parseCsv } from "./util";
import { parseWebull, WEBULL_HEADER } from "./webull";

export { mergeFills, compareFills, toStoredFill } from "./dedupe";
export { guessLeveragedEtf } from "./etf";

export function detectBroker(text: string): Broker | null {
  const { header } = parseCsv(text.split(/\r?\n/, 1)[0] ?? "");
  const has = (cols: string[]) => cols.every((c) => header.includes(c));
  if (has(WEBULL_HEADER)) return "webull";
  if (has(SCHWAB_HEADER)) return "schwab";
  return null;
}

export interface FileReport {
  source: string;
  broker: Broker | null;
  account: string | null;
  rows: number;
  parsed: number;
  added: number;
  duplicates: number;
  skipped: Record<string, number>;
  errors: string[];
  warnings: string[];
}

export interface UnmappedEtf {
  symbol: string;
  name: string;
  guess: EtfGuess;
}

export interface ImportResult {
  fills: Fill[];
  added: Fill[];
  files: FileReport[];
  unmappedEtfs: UnmappedEtf[];
}

/** Which account an export belongs to, or an error if config.json doesn't allow it. */
export function resolveAccount(broker: Broker, fileName: string, config: Config): string {
  let account: string | undefined;
  if (broker === "webull") {
    account = config.webullAccount;
  } else {
    const id = schwabAccountId(fileName);
    const configured = Object.values(config.schwabAccounts);
    if (id) account = config.schwabAccounts[id];
    else if (configured.length === 1) account = configured[0];
    if (!account) throw new Error(`Schwab account ${id ?? "(not in file name)"} is not in config.json schwabAccounts`);
  }
  if (!account || !config.accounts.includes(account)) {
    throw new Error(`account "${account}" is not listed in config.json accounts`);
  }
  return account;
}

/**
 * Parse and merge broker exports into the existing fills. Files are applied
 * in the order given (callers pass oldest export first). Pure: no I/O.
 */
export function importFiles(
  inputs: Array<{ name: string; text: string }>,
  existing: Fill[],
  ctx: { config: Config; symbols: SymbolsMap; importedAt: string },
): ImportResult {
  let fills = existing;
  const added: Fill[] = [];
  const files: FileReport[] = [];
  const names = new Map<string, string>();

  for (const input of inputs) {
    const report: FileReport = {
      source: input.name, broker: null, account: null, rows: 0, parsed: 0,
      added: 0, duplicates: 0, skipped: {}, errors: [], warnings: [],
    };
    files.push(report);
    const broker = detectBroker(input.text);
    report.broker = broker;
    if (!broker) {
      report.errors.push("unrecognized CSV header (expected a Schwab or Webull export)");
      continue;
    }
    try {
      report.account = resolveAccount(broker, input.name, ctx.config);
    } catch (e) {
      report.errors.push((e as Error).message);
      continue;
    }
    const opts = { account: report.account, source: input.name, importedAt: ctx.importedAt };
    const parsed = broker === "webull" ? parseWebull(input.text, opts) : parseSchwab(input.text, opts);
    Object.assign(report, { rows: parsed.rows, parsed: parsed.fills.length, skipped: parsed.skipped, errors: parsed.errors });
    if (parsed.errors.length) continue; // never import a partially understood file

    for (const f of parsed.fills) if (f.name && !names.has(f.symbol)) names.set(f.symbol, f.name);
    const merged = mergeFills(fills, parsed.fills);
    if (merged.conflicts.length) {
      report.errors.push(...merged.conflicts.map((c) => `conflict: ${c}`));
      continue;
    }
    fills = merged.fills;
    added.push(...merged.added);
    report.added = merged.added.length;
    report.duplicates = merged.duplicates;
    report.warnings = merged.warnings;
  }

  const unmappedEtfs: UnmappedEtf[] = [];
  for (const [symbol, name] of [...names].sort(([a], [b]) => a.localeCompare(b))) {
    if (ctx.symbols[symbol]) continue;
    const guess = guessLeveragedEtf(name);
    if (guess) unmappedEtfs.push({ symbol, name, guess });
  }

  return { fills, added, files, unmappedEtfs };
}
