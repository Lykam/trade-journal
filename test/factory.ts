// Synthetic trades for gauge and dashboard tests. Fake tickers only.
import { etOffset } from "../src/core/normalize/util";
import type { Style, Trade, TradeEvent } from "../src/core/types";

let n = 0;

interface Closed {
  style?: Style;
  symbol?: string;
  underlying?: string;
  openedAt?: string;
  closedAt: string;
  net: number;
  holdMinutes?: number | null;
  excluded?: boolean;
}

/** A closed round trip with the given net P&L. */
export function closed(o: Closed): Trade {
  const id = `t-${String(++n).padStart(4, "0")}`;
  const symbol = o.symbol ?? "ZZTA";
  const openedAt = o.openedAt ?? o.closedAt;
  return {
    id, ideaId: id, account: o.style === "swing" ? "schwab-main" : "webull", broker: o.style === "swing" ? "schwab" : "webull",
    symbol, underlying: o.underlying ?? symbol, instrument: o.underlying ? "leveraged_etf" : "stock",
    leverage: o.underlying ? 2 : 1, direction: "long", style: o.style ?? "day",
    sameDay: openedAt.slice(0, 10) === o.closedAt.slice(0, 10), openedAt, closedAt: o.closedAt, status: "closed",
    maxPosition: 1, openQty: 0, unmatchedQty: 0, avgEntry: 10, avgExit: 10 + o.net, grossPnl: o.net, fees: 0, netPnl: o.net,
    result: o.net > 0 ? "win" : o.net < 0 ? "loss" : "breakeven", holdMinutes: o.holdMinutes ?? null, fillIds: [id],
    avgCost: 10, realizedPnl: o.net, events: [], tags: [], excluded: o.excluded ?? false,
  };
}

interface Open {
  symbol?: string;
  underlying?: string;
  style?: Style;
  openedAt: string;
  events?: TradeEvent[];
  /** Shortcut for a single buy. */
  qty?: number;
  price?: number;
}

/** A position still open now. Fields follow the events (average cost, trims realize). */
export function open(o: Open): Trade {
  const id = `o-${String(++n).padStart(4, "0")}`;
  const events = o.events ?? [{ kind: "open", at: o.openedAt, qty: o.qty ?? 1, price: o.price ?? 10 }];
  let shares = 0, avgCost = 0, realized = 0, max = 0;
  for (const e of events) {
    if (e.kind === "open" || e.kind === "add") {
      avgCost = (avgCost * shares + e.price * e.qty) / (shares + e.qty);
      shares += e.qty;
      max = Math.max(max, shares);
    } else {
      shares -= e.qty;
      realized += e.realized ?? 0;
    }
  }
  const symbol = o.symbol ?? "SWGA";
  return {
    id, ideaId: id, account: "schwab-main", broker: "schwab", symbol, underlying: o.underlying ?? symbol,
    instrument: o.underlying ? "leveraged_etf" : "stock", leverage: o.underlying ? 2 : 1, direction: "long",
    style: o.style ?? "swing", sameDay: false, openedAt: o.openedAt, closedAt: null, status: "open", maxPosition: max,
    openQty: shares, unmatchedQty: 0, avgEntry: avgCost, avgExit: null, grossPnl: realized, fees: 0, netPnl: realized,
    result: null, holdMinutes: null, fillIds: [id], avgCost, realizedPnl: realized, events, tags: [], excluded: false,
  };
}

/** The same position after it closed later (for "as of" checks across weeks). */
export function closeLater(t: Trade, at: string, price: number): Trade {
  const realized = Math.round((price - t.avgCost) * t.openQty * 100) / 100;
  const net = Math.round((t.realizedPnl + realized) * 100) / 100;
  return {
    ...t, status: "closed", closedAt: at, openQty: 0, netPnl: net, grossPnl: net, realizedPnl: net,
    result: net > 0 ? "win" : net < 0 ? "loss" : "breakeven",
    events: [...t.events, { kind: "close", at, qty: t.openQty, price, realized }],
  };
}

/** n wins and m losses closed on the given ET date. */
export function batch(style: Style, date: string, wins: number, losses: number, bes = 0): Trade[] {
  const at = (i: number) => `${date}T${String(10 + Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00${etOffset(date)}`;
  const out: Trade[] = [];
  let i = 0;
  for (let k = 0; k < wins; k++) out.push(closed({ style, closedAt: at(i++), net: 1 }));
  for (let k = 0; k < losses; k++) out.push(closed({ style, closedAt: at(i++), net: -1 }));
  for (let k = 0; k < bes; k++) out.push(closed({ style, closedAt: at(i++), net: 0 }));
  return out;
}
