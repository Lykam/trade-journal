// Trades table rows (SPEC §6.3): one per trade, or one per idea in the Idea view.
// Sorting is stable: rows with equal keys keep the default order (newest first).
import { daysBetween } from "../calendar";
import { cents, etDate } from "../normalize/util";
import { isScored } from "../trades/stats";
import type { Style, Trade, TradeResult } from "../types";
import { tradeDate, type CountMode, type PnlMode, type SortKey, type ViewState } from "./filter";
import { filterTrades, type Journal } from "./journal";

export interface Row {
  kind: "trade" | "idea";
  /** Trade id, or idea id in the Idea view. */
  id: string;
  /** The row's trades that pass the filter, oldest first. */
  trades: Trade[];
  /** ET date (latest trade date for an idea) and the first trade's date. */
  date: string;
  firstDate: string;
  /** Close (or open) instant of the latest trade; orders same-day rows. */
  time: number;
  symbol: string;
  /** Symbols traded in the row (an idea can mix the stock and its ETFs). */
  symbols: string[];
  style: Style;
  /** Shares bought plus shares sold. */
  volume: number;
  executions: number;
  /** Timed hold in minutes, or null when any trade has date-only precision or is open. */
  holdMinutes: number | null;
  /** Calendar days from first open to last close (or to today while open). */
  holdDays: number;
  gross: number;
  net: number;
  /** Win/loss/breakeven from net P&L of scored trades (Q2); null if none are scored. */
  result: TradeResult | null;
  open: boolean;
  reviewed: boolean;
  note: string;
  tags: string[];
  /** Position of the latest trade in derived order; breaks ties between same-instant rows. */
  order: number;
}

export const PAGE_SIZE = 50;

const instant = (t: Trade) => Date.parse(t.closedAt ?? t.openedAt);
/** Shares bought plus shares sold. A sell event already holds the full fill qty, oversold shares included. */
const volumeOf = (t: Trade) => t.events.reduce((s, e) => s + e.qty, 0);

function makeRow(kind: Row["kind"], id: string, trades: Trade[], j: Journal, order: Map<string, number>): Row {
  const sorted = [...trades].sort((a, b) => Date.parse(a.openedAt) - Date.parse(b.openedAt) || order.get(a.id)! - order.get(b.id)!);
  const last = sorted.reduce((a, b) => (instant(b) > instant(a) || (instant(b) === instant(a) && order.get(b.id)! > order.get(a.id)!) ? b : a));
  const first = sorted[0]!;
  const scored = sorted.filter(isScored);
  const scoredNet = cents(scored.reduce((s, t) => s + t.netPnl, 0));
  const open = sorted.some((t) => t.status === "open");
  const timed = !open && sorted.every((t) => t.holdMinutes !== null);
  const closedAts = sorted.map((t) => t.closedAt).filter((c): c is string => c !== null);
  const lastClose = closedAts.length ? closedAts.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a)) : null;
  const tags = [...new Set(sorted.flatMap((t) => j.tags.get(t.id)?.all ?? t.tags))];
  const notes = [...new Set(sorted.map((t) => t.note).filter((n): n is string => !!n))];
  return {
    kind, id, trades: sorted,
    date: tradeDate(last),
    firstDate: etDate(first.openedAt),
    time: instant(last),
    symbol: kind === "idea" ? (j.ideaById.get(id)?.underlying ?? first.underlying) : first.symbol,
    symbols: [...new Set(sorted.map((t) => t.symbol))],
    style: first.style,
    volume: sorted.reduce((s, t) => s + volumeOf(t), 0),
    executions: sorted.reduce((s, t) => s + t.fillIds.length, 0),
    holdMinutes: timed
      ? kind === "trade" || sorted.length === 1
        ? first.holdMinutes
        : (Date.parse(lastClose!) - Date.parse(first.openedAt)) / 60_000
      : null,
    holdDays: daysBetween(etDate(first.openedAt), lastClose && !open ? etDate(lastClose) : j.today),
    gross: cents(sorted.reduce((s, t) => s + t.grossPnl, 0)),
    net: cents(sorted.reduce((s, t) => s + t.netPnl, 0)),
    result: scored.length === 0 ? null : kind === "trade" ? first.result : scoredNet > 0 ? "win" : scoredNet < 0 ? "loss" : "breakeven",
    open,
    reviewed: j.reviews.byIdea.has(first.ideaId),
    note: notes.join(" · "),
    tags,
    order: order.get(last.id)!,
  };
}

/** Rows in default order (newest first), one per trade or one per idea. */
export function buildRows(trades: Trade[], j: Journal, count: CountMode): Row[] {
  const order = new Map(j.trades.map((t, i) => [t.id, i]));
  let rows: Row[];
  if (count === "trade") rows = trades.map((t) => makeRow("trade", t.id, [t], j, order));
  else {
    const groups = new Map<string, Trade[]>();
    for (const t of trades) groups.set(t.ideaId, [...(groups.get(t.ideaId) ?? []), t]);
    rows = [...groups].map(([id, ts]) => makeRow("idea", id, ts, j, order));
  }
  return rows.sort(byDefault);
}

/** Newest first; same-instant rows (Schwab, date only) put the later one in derived order first, like byCloseDesc. */
const byDefault = (a: Row, b: Row) => b.time - a.time || b.order - a.order;

const pnlOf = (r: Row, mode: PnlMode) => (mode === "gross" ? r.gross : r.net);

function sortValue(r: Row, key: SortKey, pnl: PnlMode): number | string | null {
  switch (key) {
    case "date": return r.time;
    case "symbol": return r.symbol;
    case "style": return r.style;
    case "volume": return r.volume;
    case "executions": return r.executions;
    case "hold": return r.holdMinutes ?? r.holdDays * 1440;
    case "pnl": return pnlOf(r, pnl);
    case "review": return r.reviewed ? 1 : 0;
    case "notes": return r.note || null;
    case "tags": return r.tags.length ? r.tags.join(" ") : null;
  }
}

/**
 * Stable sort. Equal keys keep the incoming (default) order in both directions;
 * empty values (no note, no tags) always sort last. Date sorts break same-instant
 * ties by derived order so ascending is the exact mirror of descending.
 */
export function sortRows(rows: Row[], sort: ViewState["sort"], pnl: PnlMode): Row[] {
  const dir = sort.dir === "asc" ? 1 : -1;
  return rows
    .map((r, i) => ({ r, i, v: sortValue(r, sort.key, pnl) }))
    .sort((a, b) => {
      if (a.v === null || b.v === null) return a.v === b.v ? a.i - b.i : a.v === null ? 1 : -1;
      const c = typeof a.v === "string" ? a.v.localeCompare(b.v as string) : a.v - (b.v as number);
      if (c) return dir * c;
      if (sort.key === "date") return dir * (a.r.order - b.r.order);
      return a.i - b.i;
    })
    .map(({ r }) => r);
}

/** Filter → rows → sort: exactly what the Trades table shows. */
export function viewRows(j: Journal, v: ViewState): Row[] {
  return sortRows(buildRows(filterTrades(j, v.filter), j, v.count), v.sort, v.pnl);
}

/** Trades in table order (an idea row contributes its trades oldest first), for Previous / Next. */
export const tradeOrder = (rows: Row[]): string[] => rows.flatMap((r) => r.trades.map((t) => t.id));

export function neighbors(ids: string[], id: string): { prev: string | null; next: string | null; index: number; total: number } {
  const i = ids.indexOf(id);
  if (i < 0) return { prev: null, next: null, index: -1, total: ids.length };
  return { prev: ids[i - 1] ?? null, next: ids[i + 1] ?? null, index: i, total: ids.length };
}

export interface RowSummary {
  rows: number;
  trades: number;
  wins: number;
  losses: number;
  breakevens: number;
  winRate: number | null;
  /** Realized P&L of scored trades (gross or net). */
  pnl: number;
  volume: number;
}

/** Totals over rows. In the Idea view each idea counts once, scored on its trades' combined net P&L. */
export function summarizeRows(rows: Row[], pnl: PnlMode): RowSummary {
  const count = (res: TradeResult) => rows.filter((r) => r.result === res).length;
  const wins = count("win");
  const losses = count("loss");
  const scored = rows.flatMap((r) => r.trades).filter(isScored);
  return {
    rows: rows.length,
    trades: rows.reduce((s, r) => s + r.trades.length, 0),
    wins, losses, breakevens: count("breakeven"),
    winRate: wins + losses ? wins / (wins + losses) : null,
    pnl: cents(scored.reduce((s, t) => s + (pnl === "gross" ? t.grossPnl : t.netPnl), 0)),
    volume: rows.reduce((s, r) => s + r.volume, 0),
  };
}

export function paginate<T>(rows: T[], page: number, size = PAGE_SIZE): { items: T[]; page: number; pages: number } {
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const p = Math.min(Math.max(1, page), pages);
  return { items: rows.slice((p - 1) * size, p * size), page: p, pages };
}

/** The page a trade sits on, so Back from Trade detail returns to it. */
export function pageOf(rows: Row[], tradeId: string, size = PAGE_SIZE): number {
  const i = rows.findIndex((r) => r.trades.some((t) => t.id === tradeId));
  return i < 0 ? 1 : Math.floor(i / size) + 1;
}
