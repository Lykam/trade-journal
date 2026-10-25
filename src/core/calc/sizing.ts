// Position-size calculator: how many shares a 1% max-risk / 3% max-capital rule
// allows, rounded down to a tenth of a share. Pure, no app state.
import { cents } from "../normalize/util";

export interface SizingInput {
  /** Planned entry price. */
  entry: number;
  /** Stop-loss price; must be below entry (long only). */
  stop: number;
  /** Account size to size against, after any temporary exclusion. */
  account: number;
  /** Fraction of account willing to lose if the stop is hit, e.g. 0.01 for 1%. */
  riskPct: number;
  /** Fraction of account allowed to go into one position, e.g. 0.03 for 3%. */
  capPct: number;
}

export interface SizingResult {
  riskPerShare: number;
  maxRiskDollars: number;
  maxCapitalDollars: number;
  /** Shares the risk rule alone allows. */
  sharesByRisk: number;
  /** Shares the capital rule alone allows. */
  sharesByCapital: number;
  /** min(sharesByRisk, sharesByCapital): the answer. */
  shares: number;
  limitedBy: "risk" | "capital" | "tie";
  positionCost: number;
  actualRisk: number;
  pctOfAccountUsed: number;
}

/** Floors to the nearest tenth of a share, so the position never exceeds either cap. */
export function floorToTenth(n: number): number {
  if (n <= 0) return 0;
  return Math.floor(n * 10 + 1e-9) / 10;
}

export function computeSizing({ entry, stop, account, riskPct, capPct }: SizingInput): SizingResult {
  if (!(entry > 0)) throw new Error("Entry price must be greater than 0.");
  if (!(stop > 0)) throw new Error("Stop price must be greater than 0.");
  if (stop >= entry) throw new Error("Stop price must be below entry price.");
  if (!(account > 0)) throw new Error("Account size must be greater than 0.");
  if (!(riskPct > 0)) throw new Error("Max risk % must be greater than 0.");
  if (!(capPct > 0)) throw new Error("Max capital % must be greater than 0.");

  const riskPerShare = cents(entry - stop);
  const maxRiskDollars = cents(account * riskPct);
  const maxCapitalDollars = cents(account * capPct);

  const sharesByRisk = floorToTenth(maxRiskDollars / riskPerShare);
  const sharesByCapital = floorToTenth(maxCapitalDollars / entry);
  const shares = Math.min(sharesByRisk, sharesByCapital);
  const limitedBy = sharesByRisk === sharesByCapital ? "tie" : sharesByRisk < sharesByCapital ? "risk" : "capital";

  return {
    riskPerShare,
    maxRiskDollars,
    maxCapitalDollars,
    sharesByRisk,
    sharesByCapital,
    shares,
    limitedBy,
    positionCost: cents(shares * entry),
    actualRisk: cents(shares * riskPerShare),
    pctOfAccountUsed: cents(shares * entry) / account,
  };
}
