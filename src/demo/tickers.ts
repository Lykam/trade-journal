// The demo's made-up instruments. None is a real traded symbol of the owner
// (`npm run scan` checks every commit); SPEC examples use the same names, so
// the docs and the demo agree (Q49).
import type { SymbolsMap } from "../core/types";

export interface DemoTicker {
  symbol: string;
  /** Company-style name, as a broker export would show it. */
  name: string;
  /** Price on the first generated day. */
  start: number;
  /** Daily volatility of the random walk. */
  vol: number;
}

/** Small caps for the Webull-style day account. */
export const DAY_TICKERS: DemoTicker[] = [
  { symbol: "QBTX", name: "QUBITEX SYSTEMS INC", start: 4.2, vol: 0.06 },
  { symbol: "ZNRG", name: "ZENERGIA CORP", start: 7.8, vol: 0.05 },
  { symbol: "VXLA", name: "VEXELLA THERAPEUTICS", start: 2.9, vol: 0.07 },
  { symbol: "KRQN", name: "KRAQEN LABS INC", start: 11.5, vol: 0.045 },
  { symbol: "PLZM", name: "PLAZMIC MATERIALS", start: 5.6, vol: 0.055 },
  { symbol: "TQRV", name: "TORQIVE MOBILITY", start: 3.4, vol: 0.065 },
];

/** Larger names for the Schwab-style swing account. */
export const SWING_TICKERS: DemoTicker[] = [
  { symbol: "NVQX", name: "NOVAQUANT SEMICONDUCTOR", start: 48, vol: 0.028 },
  { symbol: "MZRT", name: "MAZORIT SOFTWARE", start: 112, vol: 0.022 },
  { symbol: "CRQL", name: "CRIQUAL NETWORKS", start: 36, vol: 0.026 },
  { symbol: "AQRS", name: "AQUARIS ENERGY", start: 64, vol: 0.024 },
  { symbol: "BLNQ", name: "BALINQ HEALTH", start: 27, vol: 0.03 },
  { symbol: "TRVQ", name: "TRAVOQ LOGISTICS", start: 82, vol: 0.021 },
];

/** Single-stock ETFs on two of the swing names (2x long each, plus a 2x inverse). */
export const DEMO_SYMBOLS: SymbolsMap = {
  NVQU: { underlying: "NVQX", type: "leveraged_etf", leverage: 2, direction: "long", issuer: "Demo Funds" },
  MZRU: { underlying: "MZRT", type: "leveraged_etf", leverage: 2, direction: "long", issuer: "Demo Funds" },
  NVQD: { underlying: "NVQX", type: "leveraged_etf", leverage: 2, direction: "inverse", issuer: "Demo Funds" },
  // A Korean-listed underlying, as in SPEC §3.4 (not traded in the demo).
  HXQY: { underlying: "999990.KS", type: "leveraged_etf", leverage: 2, direction: "long", issuer: "Demo Funds" },
};

export const ETF_NAMES: Record<string, string> = {
  NVQU: "DEMO DAILY NVQX BULL 2X SHARES",
  MZRU: "DEMO DAILY MZRT BULL 2X SHARES",
  NVQD: "DEMO DAILY NVQX BEAR 2X SHARES",
};

/** Every symbol the demo can show, for scans and tests. */
export const ALL_DEMO_SYMBOLS = [...DAY_TICKERS, ...SWING_TICKERS].map((t) => t.symbol).concat(Object.keys(DEMO_SYMBOLS));
