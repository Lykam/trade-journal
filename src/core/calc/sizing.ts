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
  /**
   * Self-assessed avg days held over your last few trades, and your typical/baseline avg days
   * held. Shorter-than-usual recent holds mean a choppier market (faster turnover) — size down.
   * Omit either (or leave at 0) to skip the turnover adjustment entirely (multiplier stays 1).
   */
  recentAvgDaysHeld?: number;
  baselineAvgDaysHeld?: number;
  /**
   * COT positioning brake for this trade's direction (SPEC §5.7): 0.5 while the crowd is
   * positioned against it, else 1. Omitted = 1. Clamped to (0, 1]: it never sizes up.
   */
  cotMultiplier?: number;
}

export interface SizingResult {
  riskPerShare: number;
  maxRiskDollars: number;
  maxCapitalDollars: number;
  /** Shares the risk rule alone allows. */
  sharesByRisk: number;
  /** Shares the capital rule alone allows. */
  sharesByCapital: number;
  /** min(sharesByRisk, sharesByCapital), before the turnover adjustment. */
  sharesBeforeTurnover: number;
  /**
   * sqrt(recent/baseline) when recent < baseline (turning over faster than usual), else 1.
   * Never sizes up — it's a brake on choppy stretches, not a boost on slow ones.
   */
  turnoverMultiplier: number;
  /** floorToTenth(sharesBeforeTurnover * turnoverMultiplier), before the COT brake. */
  sharesBeforeCot: number;
  /** The COT brake applied, 1 when none. */
  cotMultiplier: number;
  /** floorToTenth(sharesBeforeCot * cotMultiplier): the answer. */
  shares: number;
  limitedBy: "risk" | "capital" | "tie";
  positionCost: number;
  actualRisk: number;
  pctOfAccountUsed: number;
}

/** sqrt(recent/baseline) when recent holds are shorter than baseline, else 1 (never sizes up). */
export function turnoverMultiplier(recentAvgDaysHeld?: number, baselineAvgDaysHeld?: number): number {
  if (!(recentAvgDaysHeld! > 0) || !(baselineAvgDaysHeld! > 0)) return 1;
  if (recentAvgDaysHeld! >= baselineAvgDaysHeld!) return 1;
  return Math.sqrt(recentAvgDaysHeld! / baselineAvgDaysHeld!);
}

/** A brake multiplier in (0, 1]; anything missing, non-positive or above 1 means no brake. */
export function clampBrake(m?: number): number {
  return m !== undefined && m > 0 && m < 1 ? m : 1;
}

/** Floors to the nearest tenth of a share, so the position never exceeds either cap. */
export function floorToTenth(n: number): number {
  if (n <= 0) return 0;
  return Math.floor(n * 10 + 1e-9) / 10;
}

export function computeSizing({ entry, stop, account, riskPct, capPct, recentAvgDaysHeld, baselineAvgDaysHeld, cotMultiplier }: SizingInput): SizingResult {
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
  const sharesBeforeTurnover = Math.min(sharesByRisk, sharesByCapital);
  const limitedBy = sharesByRisk === sharesByCapital ? "tie" : sharesByRisk < sharesByCapital ? "risk" : "capital";

  const turnover = turnoverMultiplier(recentAvgDaysHeld, baselineAvgDaysHeld);
  const sharesBeforeCot = floorToTenth(sharesBeforeTurnover * turnover);
  const cot = clampBrake(cotMultiplier);
  const shares = floorToTenth(sharesBeforeCot * cot);

  return {
    riskPerShare,
    maxRiskDollars,
    maxCapitalDollars,
    sharesByRisk,
    sharesByCapital,
    sharesBeforeTurnover,
    turnoverMultiplier: turnover,
    sharesBeforeCot,
    cotMultiplier: cot,
    shares,
    limitedBy,
    positionCost: cents(shares * entry),
    actualRisk: cents(shares * riskPerShare),
    pctOfAccountUsed: cents(shares * entry) / account,
  };
}
