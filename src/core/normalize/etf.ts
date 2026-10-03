import type { SymbolInfo } from "../types";

// Names of single-stock leveraged ETFs (SPEC §3.4). "2X"/"3X" (alone or glued
// to BULL/BEAR) is required, so names like "BULLDOG TEST" don't match.
const LEVERAGED = /(?:^|[\s-])(?:BULL|BEAR)?\s?([23])X(?=\s|$)|\b(?:BULL|BEAR)([23])X\b/i;

const ISSUERS: Array<[RegExp, string]> = [
  [/DIREXION/i, "Direxion"],
  [/GRANITESHARES/i, "GraniteShares"],
  [/T-REX/i, "T-REX"],
  [/TRADR/i, "Tradr"],
  [/LEVERAGE SHARES/i, "Leverage Shares"],
  [/DEFIANCE/i, "Defiance"],
  [/PROSHARES/i, "ProShares"],
];

// Words that can sit where the ticker is but aren't one.
const NOT_TICKERS = new Set(["DAILY", "LONG", "SHORT", "BULL", "BEAR", "ETF", "SHARES", "FORWARD", "TARGET", "THE"]);

export interface EtfGuess extends Omit<SymbolInfo, "underlying"> {
  underlying: string | null; // null when the name doesn't say
}

/** Guess whether an export name is a single-stock leveraged ETF, and its underlying. */
export function guessLeveragedEtf(name: string): EtfGuess | null {
  const m = LEVERAGED.exec(name);
  if (!m) return null;
  const leverage = Number(m[1] ?? m[2]);
  const inverse = /\bBEAR|\bSHORT\b|\bINVERSE\b/i.test(name);

  const candidates = [
    /DAILY\s+([A-Z.]{1,6})\s+(?:BULL|BEAR)/i, // DIREXION DAILY ABC BULL2X SHARES
    /[23]X\s+(?:LONG|SHORT|INVERSE)\s+([A-Z.]{1,6})\s+DAILY/i, // GRANITESHARES 2X LONG ABC DAILY ETF
  ];
  let underlying: string | null = null;
  for (const re of candidates) {
    const t = re.exec(name)?.[1]?.toUpperCase();
    if (t && !NOT_TICKERS.has(t)) {
      underlying = t;
      break;
    }
  }

  return {
    underlying,
    type: "leveraged_etf",
    leverage,
    direction: inverse ? "inverse" : "long",
    issuer: ISSUERS.find(([re]) => re.test(name))?.[1],
  };
}
