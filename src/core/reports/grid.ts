// The Detailed stats grid (SPEC §6.5), over units in close order.
import { cents } from "../normalize/util";
import { kelly, kRatio, maxStreaks, mean, randomChance, sqn, stdDev, sum } from "./math";
import type { Style } from "../types";
import { holdOf, valueOf, type Unit, type ValueOpts } from "./units";

export interface DayPoint {
  date: string;
  /** Sum of the day's unit values ($ or % return). */
  value: number;
  /** Running total through this day. */
  cum: number;
  units: number;
  wins: number;
  losses: number;
  winRate: number | null;
  volume: number;
}

/** One point per ET date with closed units, oldest first. */
export function daily(units: Unit[], o: ValueOpts): DayPoint[] {
  const by = new Map<string, Unit[]>();
  for (const u of units) by.set(u.date, [...(by.get(u.date) ?? []), u]);
  let cum = 0;
  return [...by.keys()].sort().map((date) => {
    const us = by.get(date)!;
    const value = sum(us.map((u) => valueOf(u, o)));
    cum += value;
    const wins = us.filter((u) => u.result === "win").length;
    const losses = us.filter((u) => u.result === "loss").length;
    return { date, value, cum, units: us.length, wins, losses, winRate: wins + losses ? wins / (wins + losses) : null, volume: sum(us.map((u) => u.volume)) };
  });
}

export interface StreakRef {
  length: number;
  units: Unit[];
}

export interface Grid {
  count: number;
  wins: number;
  losses: number;
  breakevens: number;
  /** wins ÷ (wins + losses) (SPEC §4.4). */
  winRate: number | null;
  /** Shares of all units, for "# winning (%)". */
  winShare: number | null;
  lossShare: number | null;
  total: number;
  largestGain: { value: number; unit: Unit } | null;
  largestLoss: { value: number; unit: Unit } | null;
  days: number;
  avgDaily: number | null;
  /** Shares bought + sold per trading day. */
  avgDailyVolume: number | null;
  /** Dollars per share bought (always $, gross or net). */
  avgPerShare: number | null;
  avgUnit: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  /** Minutes (see holdOf). `byStyle` when both styles are present, since one average of scalps and swings means little (#16). */
  hold: Holds & { untimed: number; byStyle: Record<Style, Holds> | null };
  streaks: { win: StreakRef | null; loss: StreakRef | null };
  stdDev: number | null;
  sqn: number | null;
  randomChance: number | null;
  kelly: number | null;
  kRatio: number | null;
  /** Σ wins ÷ |Σ losses|; null without losses. */
  profitFactor: number | null;
  /** Broker fees and commissions, $ (one combined column in both exports). */
  fees: number;
  /** Per decisive unit: W × avg win + (1 − W) × avg loss. */
  expectancy: number | null;
  daily: DayPoint[];
}

export interface Holds {
  all: number | null;
  winners: number | null;
  losers: number | null;
}

/** Mean hold (minutes) of all units, the winners and the losers; untimed units are left out. */
export function holdsOf(units: Unit[]): Holds {
  const m = (us: Unit[]) => mean(us.map(holdOf).filter((h): h is number => h !== null));
  return { all: m(units), winners: m(units.filter((u) => u.result === "win")), losers: m(units.filter((u) => u.result === "loss")) };
}

export function computeGrid(units: Unit[], o: ValueOpts): Grid {
  const vals = units.map((u) => valueOf(u, o));
  const wins = units.filter((u) => u.result === "win");
  const losses = units.filter((u) => u.result === "loss");
  const vOf = (us: Unit[]) => us.map((u) => valueOf(u, o));
  const winRate = wins.length + losses.length ? wins.length / (wins.length + losses.length) : null;
  const avgWin = mean(vOf(wins));
  const avgLoss = mean(vOf(losses));
  const days = daily(units, o);
  const extreme = (us: Unit[], dir: 1 | -1) =>
    us.reduce<{ value: number; unit: Unit } | null>((best, u) => {
      const v = valueOf(u, o);
      return !best || dir * v > dir * best.value ? { value: v, unit: u } : best;
    }, null);
  const both = units.some((u) => u.style === "day") && units.some((u) => u.style === "swing");
  const st = maxStreaks(units.map((u) => u.result));
  const ref = (s: { length: number; start: number; end: number } | null) => (s ? { length: s.length, units: units.slice(s.start, s.end + 1) } : null);
  const shares = sum(units.map((u) => u.shares));
  const pnlUsd = sum(units.map((u) => (o.pnl === "gross" ? u.gross : u.net)));
  const sumLoss = sum(vOf(losses));
  return {
    count: units.length,
    wins: wins.length,
    losses: losses.length,
    breakevens: units.length - wins.length - losses.length,
    winRate,
    winShare: units.length ? wins.length / units.length : null,
    lossShare: units.length ? losses.length / units.length : null,
    total: sum(vals),
    largestGain: extreme(wins, 1),
    largestLoss: extreme(losses, -1),
    days: days.length,
    avgDaily: days.length ? sum(vals) / days.length : null,
    avgDailyVolume: days.length ? sum(units.map((u) => u.volume)) / days.length : null,
    avgPerShare: shares ? pnlUsd / shares : null,
    avgUnit: mean(vals),
    avgWin,
    avgLoss,
    hold: {
      ...holdsOf(units), untimed: units.filter((u) => holdOf(u) === null).length,
      byStyle: both ? { day: holdsOf(units.filter((u) => u.style === "day")), swing: holdsOf(units.filter((u) => u.style === "swing")) } : null,
    },
    streaks: { win: ref(st.win), loss: ref(st.loss) },
    stdDev: stdDev(vals),
    sqn: sqn(vals),
    randomChance: randomChance(vals),
    kelly: kelly(winRate, avgWin, avgLoss),
    kRatio: kRatio(days.map((d) => d.cum)),
    profitFactor: losses.length && sumLoss !== 0 ? sum(vOf(wins)) / Math.abs(sumLoss) : null,
    fees: cents(sum(units.map((u) => u.fees))),
    expectancy: winRate === null ? null : winRate * (avgWin ?? 0) + (1 - winRate) * (avgLoss ?? 0),
    daily: days,
  };
}
