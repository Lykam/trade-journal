// Single-stock inverse ETFs (SPEC §6 lookups), from the owner's "Leveraged Inverse ETFs"
// TradingView watchlist. Manually curated, not auto-derived: sector, country, bond, commodity
// and index inverse ETFs (e.g. SQQQ, SPXS, TZA) are left out on purpose, since they have no
// single-stock underlying to look up. Refresh by asking Claude to re-pull the watchlist and
// re-derive this file — no build script fetches it, since TradingView access only exists in a
// chat session, not in this repo's Node scripts (which only talk to Yahoo).
import inverseEtfData from "./inverse-etfs.json";

export interface InverseEtf {
  symbol: string;
  underlying: string;
  leverage: number;
  issuer: string;
}

const RAW = inverseEtfData as Record<string, { underlying: string; leverage: number; issuer: string }>;

const ALL: InverseEtf[] = Object.entries(RAW)
  .map(([symbol, info]) => ({ symbol, ...info }))
  .sort((a, b) => a.underlying.localeCompare(b.underlying) || a.symbol.localeCompare(b.symbol));

export function allInverseEtfs(): InverseEtf[] {
  return ALL;
}

/** Rows whose ETF symbol or underlying contains `query` (case-insensitive); a blank query matches everything. */
export function searchInverseEtfs(query: string): InverseEtf[] {
  const q = query.trim().toUpperCase();
  if (!q) return ALL;
  return ALL.filter((r) => r.symbol.includes(q) || r.underlying.includes(q));
}
