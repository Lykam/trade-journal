// Risk-on / unsure / risk-off market regime gauge (SPEC §5.6). Pure: given
// daily bars (oldest first) for a fixed ETF basket, score five indicators and
// roll them into a state. No network here — that lives in build/fetch-regime.ts.

export interface Bar {
  date: string;
  close: number;
  volume: number;
}

export type RegimeState = "risk-on" | "unsure" | "risk-off";

export interface RegimeIndicator {
  id: string;
  label: string;
  score: -1 | 0 | 1;
  detail: string;
}

export interface RegimeSnapshot {
  state: RegimeState;
  score: number;
  indicators: RegimeIndicator[];
}

/** The fixed symbol basket every indicator is computed from. */
export const REGIME_SYMBOLS = {
  trend: ["SPY", "QQQ"],
  breadth: ["RSP", "SPY"],
  offensive: ["SMH", "XLY", "XLI", "XLF", "XLK"],
  defensive: ["XLU", "XLP", "GLD"],
  beta: ["SPHB", "SPLV"],
} as const;

export const ALL_REGIME_SYMBOLS: string[] = [...new Set(Object.values(REGIME_SYMBOLS).flat())].sort();

/** Score ≥ this → RISK-ON; ≤ its negative → RISK-OFF; otherwise UNSURE. */
const ON_ABOVE = 2;
const OFF_BELOW = -2;

const avg = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
const fmtPct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;

/** Simple moving average of the last `n` closes, `offset` sessions back from the end (0 = most recent). */
function sma(bars: Bar[], n: number, offset = 0): number | null {
  const end = bars.length - offset;
  if (end < n) return null;
  return avg(bars.slice(end - n, end).map((b) => b.close));
}

/** % return from `n` sessions ago to the latest close. */
function returnPct(bars: Bar[], n: number): number | null {
  if (bars.length <= n) return null;
  const now = bars[bars.length - 1]!.close;
  const then = bars[bars.length - 1 - n]!.close;
  return ((now - then) / then) * 100;
}

/** IBD-style distribution days in the trailing `n` sessions: closed down ≥0.2% on volume above the prior session's. */
function distributionDays(bars: Bar[], n: number): number {
  const window = bars.slice(-n);
  let count = 0;
  for (let i = 1; i < window.length; i++) {
    const prev = window[i - 1]!;
    const cur = window[i]!;
    if ((cur.close - prev.close) / prev.close <= -0.002 && cur.volume > prev.volume) count++;
  }
  return count;
}

/** +1 above a rising 50/200dma, −1 below 50dma with 10<20 both falling, else 0. */
function trendScore(bars: Bar[]): -1 | 0 | 1 {
  const close = bars[bars.length - 1]?.close;
  const sma50 = sma(bars, 50);
  const sma200 = sma(bars, 200);
  const sma200Prior = sma(bars, 200, 20);
  if (close != null && sma50 != null && sma200 != null && sma200Prior != null && close > sma50 && sma50 > sma200 && sma200 > sma200Prior) return 1;
  const sma10 = sma(bars, 10);
  const sma20 = sma(bars, 20);
  const sma10Prior = sma(bars, 10, 5);
  const sma20Prior = sma(bars, 20, 5);
  if (
    close != null && sma50 != null && sma10 != null && sma20 != null && sma10Prior != null && sma20Prior != null &&
    close < sma50 && sma10 < sma20 && sma10 < sma10Prior && sma20 < sma20Prior
  )
    return -1;
  return 0;
}

const trendDetail = (bars: Bar[]): string => {
  const s = trendScore(bars);
  return s === 1 ? "above rising 50/200dma" : s === -1 ? "below 50dma, 10<20dma falling" : "mixed";
};

function trendIndicator(bars: Record<string, Bar[]>): RegimeIndicator {
  const spy = bars.SPY, qqq = bars.QQQ;
  if (!spy || !qqq) return { id: "trend", label: "Trend (SPY/QQQ vs 50/200dma)", score: 0, detail: "insufficient data" };
  const sum = trendScore(spy) + trendScore(qqq);
  const score: -1 | 0 | 1 = sum >= 1 ? 1 : sum <= -1 ? -1 : 0;
  return { id: "trend", label: "Trend (SPY/QQQ vs 50/200dma)", score, detail: `SPY ${trendDetail(spy)}; QQQ ${trendDetail(qqq)}` };
}

function breadthIndicator(bars: Record<string, Bar[]>): RegimeIndicator {
  const rsp = bars.RSP, spy = bars.SPY;
  const rspRet = rsp && returnPct(rsp, 20);
  const spyRet = spy && returnPct(spy, 20);
  const rspClose = rsp?.[rsp.length - 1]?.close;
  const rspSma50 = rsp && sma(rsp, 50);
  let score: -1 | 0 | 1 = 0;
  let detail = "insufficient data";
  if (rspRet != null && spyRet != null && rspClose != null && rspSma50 != null) {
    const spread = rspRet - spyRet;
    if (spread > 0.5 && rspClose > rspSma50) score = 1;
    else if (spread < -0.5 && rspClose < rspSma50) score = -1;
    detail = `RSP ${fmtPct(rspRet)} vs SPY ${fmtPct(spyRet)} over 20d`;
  }
  return { id: "breadth", label: "Breadth proxy (equal-weight vs cap-weight)", score, detail };
}

function leadershipIndicator(bars: Record<string, Bar[]>): RegimeIndicator {
  const off = REGIME_SYMBOLS.offensive.map((s) => (bars[s] ? returnPct(bars[s]!, 20) : null)).filter((x): x is number => x != null);
  const def = REGIME_SYMBOLS.defensive.map((s) => (bars[s] ? returnPct(bars[s]!, 20) : null)).filter((x): x is number => x != null);
  let score: -1 | 0 | 1 = 0;
  let detail = "insufficient data";
  if (off.length && def.length) {
    const offAvg = avg(off), defAvg = avg(def);
    const spread = offAvg - defAvg;
    if (spread > 1.5) score = 1;
    else if (spread < -1.5) score = -1;
    detail = `offensive ${fmtPct(offAvg)} vs defensive ${fmtPct(defAvg)} over 20d`;
  }
  return { id: "leadership", label: "Leadership (offensive vs defensive groups)", score, detail };
}

function betaIndicator(bars: Record<string, Bar[]>): RegimeIndicator {
  const hi = bars.SPHB && returnPct(bars.SPHB, 20);
  const lo = bars.SPLV && returnPct(bars.SPLV, 20);
  let score: -1 | 0 | 1 = 0;
  let detail = "insufficient data";
  if (hi != null && lo != null) {
    const spread = hi - lo;
    if (spread > 2) score = 1;
    else if (spread < -2) score = -1;
    detail = `SPHB ${fmtPct(hi)} vs SPLV ${fmtPct(lo)} over 20d`;
  }
  return { id: "beta", label: "High-beta vs low-beta", score, detail };
}

function distributionIndicator(bars: Record<string, Bar[]>): RegimeIndicator {
  const spy = bars.SPY, qqq = bars.QQQ;
  if (!spy || !qqq) return { id: "distribution", label: "Distribution days (SPY+QQQ, 25d)", score: 0, detail: "insufficient data" };
  const count = distributionDays(spy, 25) + distributionDays(qqq, 25);
  const score: -1 | 0 | 1 = count <= 3 ? 1 : count >= 7 ? -1 : 0;
  return { id: "distribution", label: "Distribution days (SPY+QQQ, 25d)", score, detail: `${count} combined in the last 25 sessions` };
}

export function computeRegime(bars: Record<string, Bar[]>): RegimeSnapshot {
  const indicators = [trendIndicator(bars), breadthIndicator(bars), leadershipIndicator(bars), betaIndicator(bars), distributionIndicator(bars)];
  const score = indicators.reduce((s, i) => s + i.score, 0);
  const state: RegimeState = score >= ON_ABOVE ? "risk-on" : score <= OFF_BELOW ? "risk-off" : "unsure";
  return { state, score, indicators };
}
