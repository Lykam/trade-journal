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

/** Trades whose trims and closes book P&L on the calendar (Q67): matched and not excluded, open or closed. */
export const booksPnl = (t: Trade) => t.status !== "unmatched" && !t.excluded;

/**
 * P&L a trade booked per ET date (Q67): each trim and the close on its own day.
 * Buy fees go with the first sale after them, so a buy alone books nothing. The
 * close books whatever is left, so a closed trade's days add up to its P&L exactly.
 */
export function bookedByDay(t: Trade, pnl: "net" | "gross"): Map<string, number> {
  const out = new Map<string, number>();
  if (!booksPnl(t)) return out;
  let shares = 0;
  let avgCost = 0;
  let fees = 0;
  let booked = 0;
  for (const e of t.events) {
    if (e.kind === "open" || e.kind === "add") {
      avgCost = (avgCost * shares + e.price * e.qty) / (shares + e.qty);
      shares += e.qty;
      fees += e.fees ?? 0;
      continue;
    }
    const gross = (e.price - avgCost) * Math.min(e.qty, shares);
    shares = Math.max(0, shares - e.qty);
    const amount = e.kind === "close" ? (pnl === "gross" ? t.grossPnl : t.netPnl) - booked : cents(pnl === "gross" ? gross : (e.realized ?? 0) - fees);
    fees = 0;
    booked = cents(booked + amount);
    const d = etDate(e.at);
    out.set(d, cents((out.get(d) ?? 0) + amount));
  }
  return out;
}

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
