// The things Reports counts (SPEC §6.5): one unit per scored trade, or per idea
// in the Idea view (Q28: an idea is built from its trades that pass the filter,
// and scores on their combined net P&L).
import { daysBetween } from "../calendar";
import type { CountMode, PnlMode } from "../journal/filter";
import { cents, etDate } from "../normalize/util";
import { isScored } from "../trades/stats";
import type { Broker, Style, Trade, TradeResult } from "../types";

export type ValueMode = "usd" | "pct";

export interface Unit {
  kind: "trade" | "idea";
  /** Trade id, or idea id. */
  id: string;
  /** Scored trades only, oldest open first. */
  trades: Trade[];
  /** ET close date of the latest trade. */
  date: string;
  /** Close instant of the latest trade (ms). */
  time: number;
  /** Position of the latest trade in the input order; breaks same-instant ties (Schwab, date only). */
  order: number;
  /** The traded symbol; an idea that mixed symbols joins them ("ABC+ABCU"). */
  symbol: string;
  underlying: string;
  instrument: Trade["instrument"] | "mixed";
  style: Style;
  broker: Broker | "both";
  gross: number;
  net: number;
  fees: number;
  /** Cost of every buy (open and add events): the base for % return. */
  cost: number;
  /** From net P&L in both P&L modes (Q2, Q27). */
  result: TradeResult;
  /** Timed hold in minutes, or null when any trade has date-only precision. */
  holdMinutes: number | null;
  /** Calendar days from the first open to the last close (ET). */
  holdDays: number;
  /** Shares bought. */
  shares: number;
  /** Shares bought plus shares sold, as on the Trades table. */
  volume: number;
  /** Average entry of the first trade. */
  entryPrice: number;
  /** ET hour (0–23) of the first open, or null for date-only (Schwab) trades. */
  entryHour: number | null;
  /** ET minutes after midnight of the first open (09:30 = 570), or null for date-only trades. */
  entryMinute: number | null;
}

const closeTime = (t: Trade) => Date.parse(t.closedAt!);
const bought = (t: Trade) => t.events.filter((e) => e.kind === "open" || e.kind === "add");
const ET_HOUR = new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", hour: "2-digit", hourCycle: "h23" });
const etHour = (iso: string) => Number(ET_HOUR.format(new Date(iso)));
const ET_HM = new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const etMinute = (iso: string) => {
  const [h, m] = ET_HM.format(new Date(iso)).split(":").map(Number) as [number, number];
  return h * 60 + m;
};

function makeUnit(kind: Unit["kind"], id: string, trades: Trade[], order: Map<string, number>): Unit {
  const ts = [...trades].sort((a, b) => Date.parse(a.openedAt) - Date.parse(b.openedAt) || order.get(a.id)! - order.get(b.id)!);
  const first = ts[0]!;
  const last = ts.reduce((a, b) => (closeTime(b) > closeTime(a) || (closeTime(b) === closeTime(a) && order.get(b.id)! > order.get(a.id)!) ? b : a));
  const uniq = <T,>(xs: T[]) => [...new Set(xs)];
  const symbols = uniq(ts.map((t) => t.symbol)).sort();
  const instruments = uniq(ts.map((t) => t.instrument));
  const brokers = uniq(ts.map((t) => t.broker));
  const net = cents(ts.reduce((s, t) => s + t.netPnl, 0));
  const timed = ts.every((t) => t.holdMinutes !== null);
  return {
    kind, id, trades: ts,
    date: etDate(last.closedAt!),
    time: closeTime(last),
    order: order.get(last.id)!,
    symbol: symbols.join("+"),
    underlying: first.underlying,
    instrument: instruments.length > 1 ? "mixed" : instruments[0]!,
    style: first.style,
    broker: brokers.length > 1 ? "both" : brokers[0]!,
    gross: cents(ts.reduce((s, t) => s + t.grossPnl, 0)),
    net,
    fees: cents(ts.reduce((s, t) => s + t.fees, 0)),
    cost: cents(ts.reduce((s, t) => s + bought(t).reduce((c, e) => c + e.qty * e.price, 0), 0)),
    result: kind === "trade" ? first.result! : net > 0 ? "win" : net < 0 ? "loss" : "breakeven",
    holdMinutes: !timed ? null : ts.length === 1 ? first.holdMinutes : (closeTime(last) - Date.parse(first.openedAt)) / 60_000,
    holdDays: daysBetween(etDate(first.openedAt), etDate(last.closedAt!)),
    shares: ts.reduce((s, t) => s + bought(t).reduce((q, e) => q + e.qty, 0), 0),
    volume: ts.reduce((s, t) => s + t.events.reduce((q, e) => q + e.qty, 0), 0),
    entryPrice: first.avgEntry,
    entryHour: first.holdMinutes === null ? null : etHour(first.openedAt),
    entryMinute: first.holdMinutes === null ? null : etMinute(first.openedAt),

  };
}

/**
 * Units from (already filtered) trades, in close order: oldest first, and
 * same-instant closes in input order. Open, unmatched and excluded trades are
 * left out; an idea keeps its scored trades.
 */
export function buildUnits(trades: Trade[], count: CountMode): Unit[] {
  const scored = trades.filter(isScored);
  const order = new Map(trades.map((t, i) => [t.id, i]));
  let units: Unit[];
  if (count === "trade") units = scored.map((t) => makeUnit("trade", t.id, [t], order));
  else {
    const groups = new Map<string, Trade[]>();
    for (const t of scored) groups.set(t.ideaId, [...(groups.get(t.ideaId) ?? []), t]);
    units = [...groups].map(([id, ts]) => makeUnit("idea", id, ts, order));
  }
  return units.sort((a, b) => a.time - b.time || a.order - b.order);
}

export interface ValueOpts {
  pnl: PnlMode;
  mode: ValueMode;
}

/** A unit's P&L in dollars, or as a fraction of its cost in % mode (0.05 = 5%). */
export function valueOf(u: Unit, o: ValueOpts): number {
  const pnl = o.pnl === "gross" ? u.gross : u.net;
  if (o.mode === "usd") return pnl;
  return u.cost ? pnl / u.cost : 0;
}

/**
 * Hold time used for averages, in minutes: the timed hold when known, else
 * whole calendar days × 1440 for multi-day trades. A same-day trade without
 * times (Schwab) has no hold and is left out.
 */
export function holdOf(u: Unit): number | null {
  if (u.holdMinutes !== null) return u.holdMinutes;
  return u.holdDays > 0 ? u.holdDays * 1440 : null;
}
