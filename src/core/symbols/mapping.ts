// Editing symbols.json from the app (SPEC §3.4, §6.4, §6.9): map a symbol to the
// ticker it tracks (a single-stock ETF → its underlying), change a mapping, or
// remove one. One commit writes symbols.json and a derived/trades.json regenerated
// with it, so trades, ideas and review links follow the new underlying.
// Mapping is always an explicit choice (Q8); the import preview still offers new ETFs.
import { derivedWrite, jsonText, type FileWrite, type HistorySnapshot } from "../history/files";
import type { Validate } from "../schema-names";
import { buildTrades } from "../trades/grouping";
import type { DerivedTrades, SymbolInfo, SymbolsMap, Trade } from "../types";

/** A mapping to set (`info`) or remove (`info: null`). */
export interface SymbolChange {
  symbol: string;
  info: SymbolInfo | null;
}

export const SYMBOL_RE = /^[A-Z0-9.^-]{1,15}$/;

/** A readable problem with a mapping, or null when it can be saved. */
export function mappingError(symbol: string, info: SymbolInfo): string | null {
  if (!SYMBOL_RE.test(symbol)) return "Symbol: letters, digits, '.', '^' or '-' only.";
  if (!SYMBOL_RE.test(info.underlying)) return "Underlying: letters, digits, '.', '^' or '-' only.";
  if (info.underlying === symbol) return "The underlying must be a different ticker.";
  if (!(info.leverage > 0) || !Number.isFinite(info.leverage)) return "Leverage must be a number above 0 (e.g. 2).";
  if (info.direction !== "long" && info.direction !== "inverse") return "Direction must be long or inverse.";
  return null;
}

/**
 * symbols.json with the changes applied. Key order is kept and new symbols go at
 * the end, as the importer writes them, so both writers produce the same bytes.
 */
export function applySymbolChanges(symbols: SymbolsMap, changes: SymbolChange[]): SymbolsMap {
  const next: SymbolsMap = { ...symbols };
  for (const c of changes) {
    if (c.info) {
      const { underlying, type, leverage, direction, issuer } = c.info;
      next[c.symbol] = { underlying, type, leverage, direction, ...(issuer?.trim() ? { issuer: issuer.trim() } : {}) };
    } else delete next[c.symbol];
  }
  return next;
}

/** Symbols whose entry differs between two symbols.json files: symbol → new entry (null when removed). */
export function changedSymbols(before: SymbolsMap, after: SymbolsMap): Record<string, SymbolInfo | null> {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return Object.fromEntries(
    keys.filter((k) => JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null)).map((k) => [k, after[k] ?? null]),
  );
}

export interface SymbolPreview {
  /** Trades whose underlying, instrument, leverage or direction change. */
  trades: number;
  ideasBefore: number;
  ideasAfter: number;
  /** Ideas that appear or disappear (a new underlying regroups ideas). */
  ideasChanged: number;
}

function preview(before: { trades: Trade[]; ideas: Array<{ id: string; tradeIds: string[] }> }, after: typeof before): SymbolPreview {
  const key = (t: Trade) => JSON.stringify([t.underlying, t.instrument, t.leverage, t.direction, t.ideaId]);
  const prev = new Map(before.trades.map((t) => [t.id, key(t)]));
  const ideaKey = (i: { id: string; tradeIds: string[] }) => `${i.id}:${i.tradeIds.join(",")}`;
  const a = new Set(before.ideas.map(ideaKey));
  const b = new Set(after.ideas.map(ideaKey));
  return {
    trades: after.trades.filter((t) => prev.get(t.id) !== key(t)).length,
    ideasBefore: before.ideas.length,
    ideasAfter: after.ideas.length,
    ideasChanged: [...b].filter((k) => !a.has(k)).length + [...a].filter((k) => !b.has(k)).length,
  };
}

const describe = (symbol: string, info: SymbolInfo | null) =>
  info ? `${symbol} → ${info.underlying} ${info.leverage}x ${info.direction}` : `${symbol} unmapped`;

export interface SymbolCommitPlan {
  symbols: SymbolsMap;
  derived: DerivedTrades;
  /** symbols.json entries that change: symbol → new entry (null when removed). */
  changes: Record<string, SymbolInfo | null>;
  preview: SymbolPreview;
  files: FileWrite[];
  message: string;
  /** Equal for two plans that write the same symbols.json changes (what the user approved, Q40). */
  fingerprint: string;
}

/** The commit for a set of mapping changes, computed against the current trade-history (not the deployed bundle). */
export function planSymbolCommit(snap: HistorySnapshot, edits: SymbolChange[], ctx: { generator: string }, validate: Validate): SymbolCommitPlan {
  for (const e of edits) {
    const err = e.info ? mappingError(e.symbol, e.info) : SYMBOL_RE.test(e.symbol) ? null : "Bad symbol.";
    if (err) throw new Error(`${e.symbol}: ${err}`);
  }
  const symbols = applySymbolChanges(snap.symbols, edits);
  validate("symbols", symbols, "symbols.json");
  const before = buildTrades(snap.fills, snap);
  const after = buildTrades(snap.fills, { ...snap, symbols });
  const derived: DerivedTrades = { generated: true, generator: ctx.generator, trades: after.trades, ideas: after.ideas };
  const changes = changedSymbols(snap.symbols, symbols);
  return {
    symbols,
    derived,
    changes,
    preview: preview(before, after),
    // A mapping trade-history already has writes nothing (not even a reformatted file).
    files: Object.keys(changes).length ? [{ path: "symbols.json", content: jsonText(symbols) }, derivedWrite(derived, validate)] : [],
    message: `Map symbols: ${Object.entries(changes).map(([s, i]) => describe(s, i)).join("; ") || "no change"}`,
    fingerprint: JSON.stringify(changes),
  };
}
