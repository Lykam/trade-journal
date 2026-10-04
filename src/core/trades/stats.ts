import { cents, etDate } from "../normalize/util";
import type { Trade } from "../types";

export interface Summary {
  trades: number;
  closed: number;
  open: number;
  unmatched: number;
  excluded: number;
  wins: number;
  losses: number;
  breakevens: number;
  /** wins ÷ (wins + losses); null when there are none. Breakevens are left out (SPEC §4.4). */
  winRate: number | null;
  grossPnl: number;
  fees: number;
  netPnl: number;
}

/** Trades that count toward statistics: closed, matched and not excluded. */
export const isScored = (t: Trade) => t.status === "closed" && !t.excluded && t.result !== null;

export function summarize(trades: Trade[]): Summary {
  const scored = trades.filter(isScored);
  const wins = scored.filter((t) => t.result === "win").length;
  const losses = scored.filter((t) => t.result === "loss").length;
  return {
    trades: trades.length,
    closed: trades.filter((t) => t.status === "closed").length,
    open: trades.filter((t) => t.status === "open").length,
    unmatched: trades.filter((t) => t.status === "unmatched").length,
    excluded: trades.filter((t) => t.excluded).length,
    wins,
    losses,
    breakevens: scored.filter((t) => t.result === "breakeven").length,
    winRate: wins + losses ? wins / (wins + losses) : null,
    grossPnl: cents(scored.reduce((s, t) => s + t.grossPnl, 0)),
    fees: cents(scored.reduce((s, t) => s + t.fees, 0)),
    netPnl: cents(scored.reduce((s, t) => s + t.netPnl, 0)),
  };
}

/** Mark an open position to a price (average-cost basis, SPEC §6.1a). */
export function markToMarket(t: Trade, lastPrice: number) {
  const unrealized = cents((lastPrice - t.avgCost) * t.openQty);
  return {
    unrealized,
    realized: t.realizedPnl,
    total: cents(unrealized + t.realizedPnl),
    marketValue: cents(lastPrice * t.openQty),
    costBasis: cents(t.avgCost * t.openQty),
  };
}

/** Day trades still open after their open date, or closed on a later date (SPEC §4.4 sanity flag). */
export function heldOvernightDayTrades(trades: Trade[], today: string): Trade[] {
  return trades.filter(
    (t) =>
      t.style === "day" &&
      ((t.status === "open" && etDate(t.openedAt) < today) || (t.status === "closed" && !t.sameDay)),
  );
}

/** Closed trades, latest close first. Same-instant closes (Schwab, date only) reverse the input order. */
export function byCloseDesc(trades: Trade[]): Trade[] {
  return trades
    .map((t, i) => ({ t, i }))
    .sort((a, b) => Date.parse(b.t.closedAt!) - Date.parse(a.t.closedAt!) || b.i - a.i)
    .map(({ t }) => t);
}
