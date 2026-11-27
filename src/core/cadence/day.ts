// The daily entry's facts (SPEC §6.7i, Q89): read from the trades, never typed.
import { cents } from "../normalize/util";
import { bookedByDay } from "../trades/stats";
import type { Idea, Trade } from "../types";

export interface DayIdea {
  idea: Idea;
  /** P&L the idea booked that day (trims and closes on that date). */
  pnl: number;
  trades: Trade[];
  /** First open among the trades that booked that day, for ordering. */
  openedAt: string;
}

export interface DayFacts {
  date: string;
  pnl: number;
  trades: number;
  ideas: DayIdea[];
  best: DayIdea | null;
  worst: DayIdea | null;
  /** P&L of the ideas opened after the first losing idea, or null without a loss. */
  afterFirstLoss: { pnl: number; ideas: number } | null;
}

export function dayFacts(date: string, trades: Trade[], ideaById: Map<string, Idea>, pnl: "net" | "gross" = "net"): DayFacts {
  const byIdea = new Map<string, DayIdea>();
  let count = 0;
  for (const t of trades) {
    const amount = bookedByDay(t, pnl).get(date);
    if (amount === undefined) continue;
    const idea = ideaById.get(t.ideaId);
    if (!idea) continue;
    count++;
    const d = byIdea.get(idea.id) ?? { idea, pnl: 0, trades: [], openedAt: t.openedAt };
    d.pnl += amount;
    d.trades.push(t);
    if (t.openedAt < d.openedAt) d.openedAt = t.openedAt;
    byIdea.set(idea.id, d);
  }
  const ideas = [...byIdea.values()].map((d) => ({ ...d, pnl: cents(d.pnl) })).sort((a, b) => a.openedAt.localeCompare(b.openedAt));
  const ranked = [...ideas].sort((a, b) => b.pnl - a.pnl);
  const firstLoss = ideas.findIndex((d) => d.pnl < 0);
  const after = firstLoss < 0 ? null : ideas.slice(firstLoss + 1);
  return {
    date,
    pnl: cents(ideas.reduce((s, d) => s + d.pnl, 0)),
    trades: count,
    ideas,
    best: ranked[0] && ranked[0].pnl > 0 ? ranked[0] : null,
    worst: ranked.at(-1) && ranked.at(-1)!.pnl < 0 ? ranked.at(-1)! : null,
    afterFirstLoss: after && { pnl: cents(after.reduce((s, d) => s + d.pnl, 0)), ideas: after.length },
  };
}
