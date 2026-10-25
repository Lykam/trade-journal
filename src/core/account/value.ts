// Account value and each holding's share of it (SPEC §6.1, Q68). Pure.
//
// Cash is the starting balance plus every P&L booked since, minus what is still
// tied up in open positions at cost; the value adds those positions at the last
// price. The broker's own number, entered now and then as a checkpoint, corrects
// whatever this misses (interest, fees not on fills): the gap between it and the
// value computed for that close carries forward. The checkpoint stores the prices
// it was entered with and is recomputed from today's trades, so fills imported
// after it was entered don't count twice.
import { addDays, etInstant } from "../calendar";
import { positionAt } from "../gauge/gauge";
import { cents, etDate, round } from "../normalize/util";
import type { AccountBalance, AccountCheckpoint, Config, Quote, Trade } from "../types";

export interface Holding {
  trade: Trade;
  shares: number;
  avgCost: number;
  /** The price used: the quote or the checkpoint's mark, else null (counted at cost). */
  price: number | null;
  marketValue: number;
}

export interface Snapshot {
  cash: number;
  /** Open positions at their price (or cost when unpriced). */
  invested: number;
  value: number;
  holdings: Holding[];
}

export interface AccountValue extends Snapshot {
  account: string;
  balance: AccountBalance;
  /** The checkpoint in use (the latest one up to today), and the correction it adds. */
  checkpoint: AccountCheckpoint | null;
  adjustment: number;
  /** Holdings with no quote, counted at cost. */
  atCost: number;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The last instant of an ET date. */
export const endOfDay = (date: string) => new Date(etInstant(addDays(date, 1)) - 1).toISOString();

/** Trades in the account opened on or after the start date. */
const inAccount = (trades: Trade[], account: string, b: AccountBalance) =>
  trades.filter((t) => t.account === account && etDate(t.openedAt) >= b.start.date);

/**
 * Cash a trade moved up to `until`: sales in, buys and fees out. Straight from the
 * fills' prices, so it is exact to the cent (summing per-sale P&L drifts). A sale's
 * fee isn't stored on its event, so it comes from the trade's total fees when every
 * event counts, and otherwise from that sale's gross minus its realized P&L.
 */
function cashFlow(t: Trade, until: number): number {
  let flow = 0;
  let shares = 0;
  let avgCost = 0;
  let saleFees = 0;
  const all = t.events.every((e) => Date.parse(e.at) <= until);
  for (const e of t.events) {
    if (Date.parse(e.at) > until) break;
    if (e.kind === "open" || e.kind === "add") {
      avgCost = (avgCost * shares + e.price * e.qty) / (shares + e.qty);
      shares += e.qty;
      flow -= e.qty * e.price + (e.fees ?? 0);
    } else {
      const gross = (e.price - avgCost) * Math.min(e.qty, shares);
      shares = Math.max(0, shares - e.qty);
      flow += e.qty * e.price;
      saleFees += cents(gross - (e.realized ?? 0));
    }
  }
  if (all) return flow + t.events.reduce((s, e) => s + (e.fees ?? 0), 0) - t.fees;
  return flow - saleFees;
}

/** The account at instant `at`, pricing each open position with `price(symbol)` (null → at cost). */
export function snapshotAt(trades: Trade[], account: string, b: AccountBalance, at: string, price: (symbol: string) => number | null): Snapshot {
  const until = Date.parse(at);
  let flow = 0;
  const holdings: Holding[] = [];
  for (const t of inAccount(trades, account, b)) {
    if (Date.parse(t.openedAt) > until) continue;
    flow += cashFlow(t, until);
    const p = positionAt(t, at);
    if (p.shares <= 0) continue;
    const px = price(t.symbol);
    holdings.push({ trade: t, shares: p.shares, avgCost: p.avgCost, price: px, marketValue: cents(p.shares * (px ?? p.avgCost)) });
  }
  const invested = cents(holdings.reduce((s, h) => s + h.marketValue, 0));
  const cash = cents(b.start.amount + flow);
  return { cash, invested, value: cents(cash + invested), holdings };
}

/** The latest checkpoint dated on or before `today`. */
export function latestCheckpoint(b: AccountBalance, today: string): AccountCheckpoint | null {
  const list = (b.checkpoints ?? []).filter((c) => c.date <= today);
  return list.reduce<AccountCheckpoint | null>((best, c) => (!best || c.date >= best.date ? c : best), null);
}

/** The correction a checkpoint adds: what the broker showed minus what the trades give for that close. */
export function checkpointGap(trades: Trade[], account: string, b: AccountBalance, c: AccountCheckpoint): number {
  const then = snapshotAt(trades, account, b, endOfDay(c.date), (s) => c.marks[s] ?? null);
  return cents(c.value - then.value);
}

/** The account's value now: cash and positions at the last quotes, plus the latest checkpoint's correction. */
export function accountValue(trades: Trade[], account: string, b: AccountBalance, quotes: Record<string, Quote>, now: string): AccountValue {
  const snap = snapshotAt(trades, account, b, now, (s) => quotes[s]?.price ?? null);
  const checkpoint = latestCheckpoint(b, etDate(now));
  const adjustment = checkpoint ? checkpointGap(trades, account, b, checkpoint) : 0;
  return {
    ...snap,
    cash: cents(snap.cash + adjustment),
    value: cents(snap.value + adjustment),
    account, balance: b, checkpoint, adjustment,
    atCost: snap.holdings.filter((h) => h.price === null).length,
  };
}

/** Every account with a balance in config.json, by account label. */
export function accountValues(trades: Trade[], config: Config, quotes: Record<string, Quote>, now: string): Map<string, AccountValue> {
  return new Map(Object.entries(config.balances ?? {}).map(([a, b]) => [a, accountValue(trades, a, b, quotes, now)]));
}

/** A position's share of its account (market value, or cost when unpriced), or null without a balance. */
export function shareOfAccount(t: Trade, accounts: Map<string, AccountValue>): number | null {
  const a = accounts.get(t.account);
  const h = a?.holdings.find((x) => x.trade.id === t.id);
  if (!a || !h || !(a.value > 0)) return null;
  return round(h.marketValue / a.value, 6);
}

/** Symbols held in the account at the close of `date`, for the checkpoint form. */
export function heldAtClose(trades: Trade[], account: string, b: AccountBalance, date: string): Array<{ symbol: string; shares: number }> {
  const by = new Map<string, number>();
  for (const h of snapshotAt(trades, account, b, endOfDay(date), () => null).holdings) by.set(h.trade.symbol, round((by.get(h.trade.symbol) ?? 0) + h.shares, 6));
  return [...by].sort(([a], [b]) => a.localeCompare(b)).map(([symbol, shares]) => ({ symbol, shares }));
}

/** A readable problem with a balance, or null when it can be saved. */
export function balanceError(b: AccountBalance): string | null {
  if (!DATE_RE.test(b.start.date)) return "Start date: pick a date.";
  if (!Number.isFinite(b.start.amount) || b.start.amount < 0) return "Starting balance: a number, 0 or more.";
  for (const c of b.checkpoints ?? []) {
    if (!DATE_RE.test(c.date)) return "Actual value: pick a date.";
    if (c.date < b.start.date) return `Actual value on ${c.date} is before the start date ${b.start.date}.`;
    if (!Number.isFinite(c.value) || c.value < 0) return "Actual value: a number, 0 or more.";
    for (const [s, p] of Object.entries(c.marks)) if (!Number.isFinite(p) || p <= 0) return `Price for ${s}: a number above 0.`;
  }
  if (new Set((b.checkpoints ?? []).map((c) => c.date)).size !== (b.checkpoints ?? []).length) return "One actual value per date.";
  return null;
}
