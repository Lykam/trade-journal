// Statistics behind the Reports grid (SPEC §6.5). Pure numeric functions over
// plain series; formula choices are recorded in SPEC §10 (Q42).

export const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
export const mean = (xs: number[]): number | null => (xs.length ? sum(xs) / xs.length : null);

/** Sample standard deviation (n − 1); null below two values. */
export function stdDev(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const m = sum(xs) / xs.length;
  return Math.sqrt(sum(xs.map((x) => (x - m) ** 2)) / (xs.length - 1));
}

/** Van Tharp's System Quality Number on per-unit P&L: √n × mean ÷ std dev (no cap on n). */
export function sqn(xs: number[]): number | null {
  const sd = stdDev(xs);
  if (sd === null || sd === 0) return null;
  return (Math.sqrt(xs.length) * sum(xs)) / xs.length / sd;
}

// ---------------------------------------------------------------- Student's t

/** ln Γ(x), Lanczos approximation (g = 7, n = 9); accurate to ~15 digits for x > 0. */
function lnGamma(x: number): number {
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  x -= 1;
  let a = c[0]!;
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += c[i]! / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Continued fraction for the incomplete beta function (modified Lentz). */
function betaCf(a: number, b: number, x: number): number {
  const TINY = 1e-300;
  let c = 1;
  let d = 1 - ((a + b) * x) / (a + 1);
  if (Math.abs(d) < TINY) d = TINY;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c; if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d; h *= d * c;
    aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1));
    d = 1 + aa * d; if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c; if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-15) break;
  }
  return h;
}

/** Regularized incomplete beta I_x(a, b). */
export function incompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (front * betaCf(a, b, x)) / a : 1 - (front * betaCf(b, a, 1 - x)) / b;
}

/** Two-sided p-value of Student's t with `df` degrees of freedom: P(|T| ≥ |t|). */
export function tTwoSided(t: number, df: number): number {
  if (!Number.isFinite(t)) return 0;
  return incompleteBeta(df / (df + t * t), df / 2, 0.5);
}

/**
 * Probability of random chance: the two-sided p-value of a one-sample t-test
 * that the mean P&L per unit is zero (t = mean ÷ (sd ÷ √n), df = n − 1). Low
 * means the result is unlikely to be luck. Null below two units or with no spread.
 */
export function randomChance(xs: number[]): number | null {
  const t = sqn(xs);
  return t === null ? null : tTwoSided(t, xs.length - 1);
}

// ---------------------------------------------------------------- Kelly, K-ratio

/** Kelly % = W − (1 − W) ÷ R, with W the win rate (breakevens left out) and R = avg win ÷ |avg loss|. */
export function kelly(winRate: number | null, avgWin: number | null, avgLoss: number | null): number | null {
  if (winRate === null || avgWin === null || avgLoss === null || avgLoss === 0) return null;
  return winRate - (1 - winRate) / (avgWin / Math.abs(avgLoss));
}

/** Least-squares line through (1, y₁) … (n, yₙ). */
export function regress(ys: number[]): { slope: number; intercept: number; slopeSe: number } | null {
  const n = ys.length;
  if (n < 3) return null;
  const xm = (n + 1) / 2;
  const ym = sum(ys) / n;
  let sxx = 0, sxy = 0;
  ys.forEach((y, i) => { sxx += (i + 1 - xm) ** 2; sxy += (i + 1 - xm) * (y - ym); });
  const slope = sxy / sxx;
  const intercept = ym - slope * xm;
  const sse = sum(ys.map((y, i) => (y - (intercept + slope * (i + 1))) ** 2));
  return { slope, intercept, slopeSe: Math.sqrt(sse / (n - 2) / sxx) };
}

/**
 * Kestner's K-ratio (2003 form) on the cumulative P&L at the end of each
 * trading day: slope ÷ (standard error of the slope × number of days). There is
 * no account size, so the curve is cumulative P&L rather than log equity.
 * Needs three days; a perfectly straight curve is ±Infinity.
 */
export function kRatio(cumulative: number[]): number | null {
  const r = regress(cumulative);
  if (!r) return null;
  if (r.slopeSe === 0) return r.slope === 0 ? null : r.slope > 0 ? Infinity : -Infinity;
  return r.slope / (r.slopeSe * cumulative.length);
}

// ---------------------------------------------------------------- streaks

export interface Streak {
  length: number;
  /** Index of the first and last unit of the streak in the input order. */
  start: number;
  end: number;
}

/**
 * Longest run of consecutive wins and of consecutive losses, in close order.
 * A breakeven isn't a win or a loss, so it ends either run. The earliest of
 * equally long runs is kept.
 */
export function maxStreaks(results: Array<"win" | "loss" | "breakeven">): { win: Streak | null; loss: Streak | null } {
  const best: { win: Streak | null; loss: Streak | null } = { win: null, loss: null };
  let i = 0;
  while (i < results.length) {
    const r = results[i]!;
    let j = i;
    while (j + 1 < results.length && results[j + 1] === r) j++;
    if (r !== "breakeven" && (!best[r] || j - i + 1 > best[r]!.length)) best[r] = { length: j - i + 1, start: i, end: j };
    i = j + 1;
  }
  return best;
}

// ---------------------------------------------------------------- drawdown

export interface EquityPoint {
  date: string;
  /** The value added at this point (P&L or % return). */
  value: number;
}

export interface DrawdownPeriod {
  /** Date of the peak the drawdown fell from ("" = the start, before the first point). */
  peakDate: string;
  peak: number;
  troughDate: string;
  trough: number;
  /** Depth (≥ 0): peak − trough. */
  depth: number;
  /** First date the curve was back at or above the peak, or null if it hasn't recovered. */
  recoveredDate: string | null;
}

export interface Drawdown {
  /** Equity after each point and its distance below the running peak (≤ 0). */
  curve: Array<{ date: string; equity: number; underwater: number }>;
  periods: DrawdownPeriod[];
  /** The deepest period; the earliest one on ties. */
  max: DrawdownPeriod | null;
}

/**
 * Drawdowns of the cumulative curve, starting from 0 before the first point,
 * so an opening loss is a drawdown from the start. A period runs from a peak
 * until the curve is back at or above it; points are taken in the order given
 * (close order), so a drawdown inside one day counts.
 */
export function drawdowns(points: EquityPoint[]): Drawdown {
  const curve: Drawdown["curve"] = [];
  const periods: DrawdownPeriod[] = [];
  let equity = 0, peak = 0, peakDate = "";
  let open: DrawdownPeriod | null = null;
  for (const p of points) {
    equity += p.value;
    if (equity >= peak - 1e-9) {
      if (open) { open.recoveredDate = p.date; periods.push(open); open = null; }
      if (equity > peak) { peak = equity; peakDate = p.date; }
      else peakDate = p.date;
    } else {
      if (!open) open = { peakDate, peak, troughDate: p.date, trough: equity, depth: peak - equity, recoveredDate: null };
      else if (equity < open.trough) { open.trough = equity; open.troughDate = p.date; open.depth = peak - equity; }
    }
    curve.push({ date: p.date, equity, underwater: Math.min(0, equity - peak) });
  }
  if (open) periods.push(open);
  const max = periods.reduce<DrawdownPeriod | null>((m, d) => (!m || d.depth > m.depth + 1e-9 ? d : m), null);
  return { curve, periods, max };
}
