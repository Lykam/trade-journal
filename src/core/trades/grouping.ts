import { compareFills } from "../normalize/dedupe";
import { cents, etDate, etOffset, round, shortHash } from "../normalize/util";
import type {
  Config, Fill, Idea, OpeningPosition, Overrides, SymbolsMap, Trade, TradeEvent,
} from "../types";

const EPS = 1e-9;
const qtyRound = (n: number) => round(n, 6);

interface Ctx {
  config: Config;
  overrides: Overrides;
  symbols: SymbolsMap;
}

export interface GroupingResult {
  trades: Trade[];
  ideas: Idea[];
  /** Same-day Schwab fills moved so a buy precedes a sell that would otherwise oversell. */
  reorderedDays: Array<{ account: string; symbol: string; date: string }>;
}

/** A buy that comes from overrides.openingPositions rather than a broker fill. */
interface Step {
  fill: Fill;
  synthetic: boolean;
}

function openingStep(p: OpeningPosition): Step {
  const executedAt = `${p.openedAt}T00:00:00${etOffset(p.openedAt, "00:00:00")}`;
  return {
    synthetic: true,
    fill: {
      id: `op-${shortHash([p.account, p.symbol, p.qty, p.avgPrice, p.openedAt].join("|"))}`,
      broker: "schwab", // placeholder: the trade's broker comes from brokerOf(account) when it is built
      account: p.account, symbol: p.symbol, assetType: "equity", side: "buy",
      qty: p.qty, price: p.avgPrice, fees: 0, executedAt, timePrecision: "day",
      seq: -1, source: "overrides.json", importedAt: "",
    },
  };
}

/**
 * Day-precision fills have no times. Within one day, keep CSV order but pull a
 * later buy forward whenever the next sell would take the position below zero
 * (SPEC §4.2: buys before sells when flat; safe because the account is long only).
 */
function orderSteps(steps: Step[], onReorder: (date: string) => void): Step[] {
  const out: Step[] = [];
  let pos = 0;
  let i = 0;
  while (i < steps.length) {
    const s = steps[i]!;
    if (s.fill.timePrecision !== "day") {
      out.push(s);
      pos += s.fill.side === "buy" ? s.fill.qty : -s.fill.qty;
      i++;
      continue;
    }
    // Collect the whole day-precision block for this timestamp.
    let j = i;
    while (j < steps.length && steps[j]!.fill.executedAt === s.fill.executedAt && steps[j]!.fill.timePrecision === "day") j++;
    const day = steps.slice(i, j);
    let moved = false;
    while (day.length) {
      let k = 0;
      const first = day[0]!;
      if (first.fill.side === "sell" && first.fill.qty > pos + EPS) {
        const b = day.findIndex((d) => d.fill.side === "buy");
        if (b > 0) {
          k = b;
          moved = true;
        }
      }
      const [next] = day.splice(k, 1);
      out.push(next!);
      pos = qtyRound(pos + (next!.fill.side === "buy" ? next!.fill.qty : -next!.fill.qty));
      if (pos < 0) pos = 0; // an unmatched sell resets the position
    }
    if (moved) onReorder(etDate(s.fill.executedAt));
    i = j;
  }
  return out;
}

class TradeBuilder {
  steps: Step[] = [];
  events: TradeEvent[] = [];
  pos = 0;
  avgCost = 0;
  maxPos = 0;
  buyQty = 0;
  buyCost = 0;
  sellQty = 0;
  sellValue = 0;
  gross = 0;
  fees = 0;
  buyFees = 0;
  unmatchedQty = 0;
  closedAt: string | null = null;

  constructor(readonly first: Step) {}

  buy(s: Step) {
    const { qty, price, fees, executedAt } = s.fill;
    this.steps.push(s);
    // Buy fees are part of realized P&L (realizedPnl), so the event keeps them for positionAt.
    this.events.push({ kind: this.pos > EPS ? "add" : "open", at: executedAt, qty, price, ...(fees ? { fees } : {}) });
    this.avgCost = (this.avgCost * this.pos + price * qty) / (this.pos + qty);
    this.pos = qtyRound(this.pos + qty);
    this.maxPos = Math.max(this.maxPos, this.pos);
    this.buyQty += qty;
    this.buyCost += price * qty;
    this.fees += fees;
    this.buyFees += fees;
  }

  /** Returns true when the trade is finished (flat or unmatched). */
  sell(s: Step): boolean {
    const { qty, price, fees, executedAt } = s.fill;
    this.steps.push(s);
    const matched = Math.min(qty, this.pos);
    const gross = (price - this.avgCost) * matched;
    this.gross += gross;
    this.fees += fees;
    this.sellQty += qty;
    this.sellValue += price * qty;
    if (qty > this.pos + EPS) this.unmatchedQty = qtyRound(qty - this.pos);
    this.pos = qtyRound(Math.max(0, this.pos - qty));
    const done = this.pos <= EPS;
    this.events.push({ kind: done ? "close" : "trim", at: executedAt, qty, price, realized: cents(gross - fees) });
    if (done) this.closedAt = executedAt;
    return done;
  }

  build(ctx: Ctx, broker: Fill["broker"]): Trade {
    const f0 = this.first.fill;
    const ov = ctx.overrides.trades[f0.id] ?? {};
    const info = ctx.symbols[f0.symbol];
    const style = ov.style ?? ctx.config.styleByAccount[f0.account];
    if (!style) throw new Error(`config.json styleByAccount has no entry for "${f0.account}"`);
    const status = this.unmatchedQty > 0 ? "unmatched" : this.closedAt ? "closed" : "open";
    const grossPnl = cents(this.gross);
    const fees = cents(this.fees);
    const netPnl = cents(this.gross - this.fees);
    const lastStep = this.steps[this.steps.length - 1]!;
    const timed = this.first.fill.timePrecision === "second" && lastStep.fill.timePrecision === "second";
    const trade: Trade = {
      id: f0.id,
      ideaId: "",
      account: f0.account,
      broker,
      symbol: f0.symbol,
      underlying: info?.underlying ?? f0.symbol,
      instrument: info ? "leveraged_etf" : "stock",
      leverage: info?.leverage ?? 1,
      direction: info?.direction ?? "long",
      style,
      sameDay: this.closedAt !== null && etDate(f0.executedAt) === etDate(this.closedAt),
      openedAt: f0.executedAt,
      closedAt: this.closedAt,
      status,
      maxPosition: this.maxPos,
      openQty: status === "open" ? this.pos : 0,
      unmatchedQty: this.unmatchedQty,
      avgEntry: this.buyQty > 0 ? round(this.buyCost / this.buyQty, 6) : 0,
      avgExit: this.sellQty > 0 ? round(this.sellValue / this.sellQty, 6) : null,
      grossPnl,
      fees,
      netPnl,
      result: status !== "closed" ? null : netPnl > 0 ? "win" : netPnl < 0 ? "loss" : "breakeven",
      holdMinutes:
        timed && this.closedAt ? round((Date.parse(this.closedAt) - Date.parse(f0.executedAt)) / 60000, 2) : null,
      fillIds: this.steps.filter((s) => !s.synthetic).map((s) => s.fill.id),
      avgCost: round(this.avgCost, 6),
      realizedPnl: cents(this.gross - this.fees),
      events: this.events,
      tags: ov.tags ?? [],
      excluded: ov.exclude ?? false,
    };
    if (ov.note) trade.note = ov.note;
    if (ov.ideaId) trade.ideaId = ov.ideaId;
    return trade;
  }
}

function groupTradesForSymbol(steps: Step[], ctx: Ctx, broker: Fill["broker"]): Trade[] {
  const trades: Trade[] = [];
  let cur: TradeBuilder | null = null;
  for (const s of steps) {
    if (s.fill.side === "buy") {
      cur ??= new TradeBuilder(s);
      cur.buy(s);
    } else {
      cur ??= new TradeBuilder(s); // a sell with nothing open: unmatched
      if (cur.sell(s)) {
        trades.push(cur.build(ctx, broker));
        cur = null;
      }
    }
  }
  if (cur) trades.push(cur.build(ctx, broker));
  return trades;
}

/** Group trades into ideas (SPEC §4.4). Mutates trade.ideaId. */
export function assignIdeas(trades: Trade[]): Idea[] {
  // Stable sort: same-instant trades keep the caller's order.
  const sorted = [...trades].sort((a, b) => Date.parse(a.openedAt) - Date.parse(b.openedAt));
  const dayIdeas = new Map<string, string>();
  const swingByUnderlying = new Map<string, Trade[]>();

  for (const t of sorted) {
    if (t.ideaId) continue; // set by an override
    const openDate = etDate(t.openedAt);
    if (t.style === "day") {
      const key = `${t.underlying}|${openDate}`;
      t.ideaId = dayIdeas.get(key) ?? t.id;
      dayIdeas.set(key, t.ideaId);
    } else {
      const prior = swingByUnderlying.get(t.underlying) ?? [];
      const reentryOf = prior
        .filter((p) => p.closedAt && etDate(p.closedAt) === openDate && Date.parse(p.closedAt) <= Date.parse(t.openedAt))
        .sort((a, b) => Date.parse(a.closedAt!) - Date.parse(b.closedAt!))
        .pop();
      t.ideaId = reentryOf?.ideaId ?? t.id;
      prior.push(t);
      swingByUnderlying.set(t.underlying, prior);
    }
  }

  const ideas = new Map<string, Idea>();
  for (const t of sorted) {
    let idea = ideas.get(t.ideaId);
    if (!idea) {
      idea = {
        id: t.ideaId, underlying: t.underlying, accounts: [], symbolsTraded: [], usedEtf: false,
        style: t.style, date: etDate(t.openedAt), tradeIds: [], netPnl: 0, status: "closed",
      };
      ideas.set(t.ideaId, idea);
    }
    if (!idea.accounts.includes(t.account)) idea.accounts.push(t.account);
    if (!idea.symbolsTraded.includes(t.symbol)) idea.symbolsTraded.push(t.symbol);
    idea.usedEtf ||= t.instrument === "leveraged_etf";
    idea.tradeIds.push(t.id);
    idea.netPnl = cents(idea.netPnl + t.netPnl);
    if (t.status === "open") idea.status = "open";
  }
  for (const idea of ideas.values()) {
    idea.accounts.sort();
    idea.symbolsTraded.sort();
  }
  return [...ideas.values()];
}

/** fills + overrides + symbols → flat-to-flat trades and ideas. Pure and deterministic. */
export function buildTrades(fills: Fill[], ctx: Ctx): GroupingResult {
  const bySymbol = new Map<string, Step[]>();
  const brokerOf = new Map<string, Fill["broker"]>();
  const key = (account: string, symbol: string) => `${account}|${symbol}`;
  for (const f of fills) {
    const k = key(f.account, f.symbol);
    bySymbol.set(k, [...(bySymbol.get(k) ?? []), { fill: f, synthetic: false }]);
    brokerOf.set(f.account, f.broker);
  }
  for (const p of ctx.overrides.openingPositions) {
    const k = key(p.account, p.symbol);
    bySymbol.set(k, [openingStep(p), ...(bySymbol.get(k) ?? [])]);
  }

  const reorderedDays: GroupingResult["reorderedDays"] = [];
  const trades: Trade[] = [];
  for (const [k, steps] of [...bySymbol].sort(([a], [b]) => a.localeCompare(b))) {
    const [account, symbol] = k.split("|") as [string, string];
    const broker = brokerOf.get(account) ?? (account.startsWith("webull") ? "webull" : "schwab");
    steps.sort((a, b) => compareFills(a.fill, b.fill));
    const ordered = orderSteps(steps, (date) => reorderedDays.push({ account, symbol, date }));
    trades.push(...groupTradesForSymbol(ordered, ctx, broker));
  }

  // Same-instant trades (Schwab, date only) keep the broker's row order.
  const rank = new Map([...fills].sort(compareFills).map((f, i) => [f.id, i]));
  const order = (t: Trade) => rank.get(t.fillIds[0] ?? "") ?? -1;
  trades.sort((a, b) => Date.parse(a.openedAt) - Date.parse(b.openedAt) || order(a) - order(b) || (a.id < b.id ? -1 : 1));
  const ideas = assignIdeas(trades);
  return { trades, ideas, reorderedDays };
}
