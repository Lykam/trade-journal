// Single-stock inverse ETFs (SPEC §3.7, §6 lookups, Q80, Q82). The table lives in
// trade-history's lookups.json and is edited on the LOOKUPS page: one commit can
// remove several rows and add several, through the usual preview (Q40). Until
// lookups.json is first committed, the page starts from the built-in starter list
// (inverse-etfs-starter.json, curated from the owner's TradingView "Leveraged Inverse
// ETFs" watchlist), and that first commit writes the whole table to trade-history.
import starterData from "./inverse-etfs-starter.json";
import { jsonText, type FileWrite, type HistorySnapshot } from "../history/files.ts";
import type { SchemaTexts, Validate } from "../schema-names.ts";
import type { InverseEtfInfo, LookupsFile } from "../types.ts";

export interface InverseEtf extends InverseEtfInfo {
  symbol: string;
}

export type InverseEtfTable = Record<string, InverseEtfInfo>;

/** The built-in list the page starts from while trade-history has no lookups.json. */
export const STARTER_TABLE = starterData as InverseEtfTable;

/** The table in use: trade-history's when it has one, else the starter list. */
export const tableOf = (lookups: LookupsFile | null | undefined): InverseEtfTable => lookups?.inverseEtfs ?? STARTER_TABLE;

/** Rows grouped by underlying, then by symbol. */
export function rowsOf(table: InverseEtfTable): InverseEtf[] {
  return Object.entries(table)
    .map(([symbol, info]) => ({ symbol, ...info }))
    .sort((a, b) => a.underlying.localeCompare(b.underlying) || a.symbol.localeCompare(b.symbol));
}

/** Rows whose ETF symbol or underlying contains `query` (case-insensitive); a blank query matches everything. */
export function searchInverseEtfs(rows: InverseEtf[], query: string): InverseEtf[] {
  const q = query.trim().toUpperCase();
  if (!q) return rows;
  return rows.filter((r) => r.symbol.includes(q) || r.underlying.includes(q));
}

export const TICKER = /^[A-Z][A-Z0-9.]{0,9}$/;

/** One add row as typed on the page. */
export interface InverseEtfDraft {
  symbol: string;
  underlying: string;
  leverage: string;
  issuer: string;
}

export const emptyDraft = (): InverseEtfDraft => ({ symbol: "", underlying: "", leverage: "", issuer: "" });
export const isBlankDraft = (d: InverseEtfDraft) => !d.symbol.trim() && !d.underlying.trim() && !d.leverage.trim() && !d.issuer.trim();

/** The row a draft describes, or an error message. Tickers are upper-cased; "2x" reads as 2. */
export function inverseEtfFromDraft(d: InverseEtfDraft): InverseEtf | string {
  const symbol = d.symbol.trim().toUpperCase();
  const underlying = d.underlying.trim().toUpperCase();
  const lev = d.leverage.trim().replace(/x$/i, "");
  const leverage = Number(lev);
  const issuer = d.issuer.trim().replace(/\s+/g, " ");
  const name = symbol || "A new row";
  if (!symbol) return "Type the ETF symbol.";
  if (!TICKER.test(symbol)) return `${symbol} isn't a ticker.`;
  if (!underlying) return `${name}: type the underlying.`;
  if (!TICKER.test(underlying)) return `${name}: ${underlying} isn't a ticker.`;
  if (!lev || !Number.isFinite(leverage) || leverage <= 0 || leverage > 10) return `${name}: leverage must be a number like 1 or 2.`;
  if (!issuer) return `${name}: type the issuer.`;
  if (issuer.length > 60) return `${name}: keep the issuer under 60 characters.`;
  return { symbol, underlying, leverage, issuer };
}

/** Remove these symbols and add (or replace) these rows, in one commit. */
export interface LookupsChange {
  remove: string[];
  add: InverseEtf[];
}

export interface LookupsCommitPlan {
  lookups: LookupsFile;
  removed: InverseEtf[];
  added: InverseEtf[];
  /** Adds whose symbol was already on file, with the row they replace. */
  replaced: Array<{ before: InverseEtf; after: InverseEtf }>;
  /** Removals no longer on file (someone removed them already); skipped. */
  gone: string[];
  /** True when trade-history had no lookups.json and this commit creates it from the starter list. */
  creating: boolean;
  files: FileWrite[];
  message: string;
  /** Equal for two plans that write the same change (what the user approved, Q40). */
  fingerprint: string;
}

/** Apply removals first, then adds; keys come out sorted. Throws on a symbol added twice. */
export function applyLookupsChange(table: InverseEtfTable, change: LookupsChange) {
  const next: InverseEtfTable = { ...table };
  const removed: InverseEtf[] = [];
  const gone: string[] = [];
  for (const symbol of change.remove) {
    const row = next[symbol];
    if (!row) { gone.push(symbol); continue; }
    removed.push({ symbol, ...row });
    delete next[symbol];
  }
  const added: InverseEtf[] = [];
  const replaced: LookupsCommitPlan["replaced"] = [];
  const seen = new Set<string>();
  for (const r of change.add) {
    if (seen.has(r.symbol)) throw new Error(`${r.symbol} is added twice.`);
    seen.add(r.symbol);
    const before = next[r.symbol];
    const after = { symbol: r.symbol, underlying: r.underlying, leverage: r.leverage, issuer: r.issuer };
    if (before) {
      if (JSON.stringify({ symbol: r.symbol, ...before }) !== JSON.stringify(after)) replaced.push({ before: { symbol: r.symbol, ...before }, after });
    } else added.push(after);
    next[r.symbol] = { underlying: r.underlying, leverage: r.leverage, issuer: r.issuer };
  }
  const sorted: InverseEtfTable = {};
  for (const k of Object.keys(next).sort()) sorted[k] = next[k]!;
  return { table: sorted, removed, added, replaced, gone };
}

const list = (rows: InverseEtf[]) => rows.map((r) => r.symbol).join(", ");

function describe(p: Pick<LookupsCommitPlan, "removed" | "added" | "replaced">): string {
  const parts: string[] = [];
  if (p.removed.length) parts.push(`remove ${list(p.removed)}`);
  if (p.added.length) parts.push(`add ${list(p.added)}`);
  if (p.replaced.length) parts.push(`update ${list(p.replaced.map((x) => x.after))}`);
  return `Lookups: ${parts.join("; ") || "no change"}`;
}

/** The commit for one batch of removals and adds, against the current trade-history. */
export function planLookupsCommit(snap: HistorySnapshot, change: LookupsChange, ctx: { schemas: SchemaTexts }, validate: Validate): LookupsCommitPlan {
  const creating = !snap.lookups;
  const { table, removed, added, replaced, gone } = applyLookupsChange(tableOf(snap.lookups), change);
  const lookups: LookupsFile = { schemaVersion: 1, inverseEtfs: table };
  validate("lookups", lookups, "lookups.json");
  const changed = creating || removed.length + added.length + replaced.length > 0;
  return {
    lookups, removed, added, replaced, gone, creating,
    files: changed
      ? [{ path: "lookups.json", content: jsonText(lookups) }, { path: "schema/lookups.schema.json", content: ctx.schemas.lookups }]
      : [],
    message: describe({ removed, added, replaced }),
    fingerprint: JSON.stringify(change),
  };
}
