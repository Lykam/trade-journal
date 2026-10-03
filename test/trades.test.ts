import { describe, expect, it } from "vitest";
import { importFiles } from "../src/core/normalize";
import { buildTrades, heldOvernightDayTrades, markToMarket, summarize } from "../src/core/trades";
import type { Fill, Overrides, Trade } from "../src/core/types";
import { config, IMPORTED_AT, input, noOverrides, SCHWAB_B, symbols, WEBULL_B } from "./helpers";

const allFills = (): Fill[] =>
  importFiles([input(WEBULL_B), input(SCHWAB_B)], [], { config, symbols, importedAt: IMPORTED_AT }).fills;

function build(overrides: Overrides = noOverrides(), fills = allFills()) {
  return buildTrades(fills, { config, symbols, overrides });
}

const find = (trades: Trade[], symbol: string, date?: string) =>
  trades.filter((t) => t.symbol === symbol && (!date || t.openedAt.startsWith(date)));

describe("flat-to-flat trades", () => {
  const { trades } = build();

  it("keeps scale-ins and trims inside one trade, using average cost", () => {
    const [t] = find(trades, "ZZTA", "2025-03-10T09");
    expect(t).toMatchObject({
      status: "closed", maxPosition: 4, avgEntry: 1.55, avgExit: 1.725, grossPnl: 0.7, netPnl: 0.7,
      result: "win", sameDay: true, holdMinutes: 20.92, style: "day",
    });
    expect(t!.events).toEqual([
      { kind: "open", at: "2025-03-10T09:31:05-04:00", qty: 2, price: 1.5 },
      { kind: "add", at: "2025-03-10T09:35:00-04:00", qty: 2, price: 1.6 },
      { kind: "trim", at: "2025-03-10T09:40:00-04:00", qty: 1, price: 1.8, realized: 0.25 },
      { kind: "close", at: "2025-03-10T09:52:00-04:00", qty: 3, price: 1.7, realized: 0.45 },
    ]);
  });

  it("starts a new trade for each round trip", () => {
    expect(find(trades, "ZZTA")).toHaveLength(3);
  });

  it("scores a Partial Filled entry on the filled quantity", () => {
    const [t] = find(trades, "QXRB", "2025-03-10");
    expect(t).toMatchObject({ maxPosition: 3, netPnl: -0.3, result: "loss" });
  });

  it("matches two identical same-second buys against one sell", () => {
    const [t] = find(trades, "QXRB", "2025-03-11");
    expect(t).toMatchObject({ maxPosition: 2, netPnl: 0.2, result: "win" });
    expect(t!.fillIds).toHaveLength(3);
  });

  it("calls exactly $0.00 breakeven", () => {
    expect(find(trades, "ZZTA", "2025-03-10T14")[0]).toMatchObject({ netPnl: 0, result: "breakeven" });
  });

  it("rounds to the cent before scoring (+$0.0038 is breakeven)", () => {
    expect(find(trades, "RNDB")[0]).toMatchObject({ netPnl: 0, result: "breakeven" });
  });

  it("reaches exactly $0.00 across a multi-day trade with trims (Schwab swing)", () => {
    const [t] = find(trades, "SWGA");
    expect(t).toMatchObject({
      status: "closed", style: "swing", sameDay: false, holdMinutes: null, openedAt: "2025-03-03T00:00:00-05:00",
      maxPosition: 20, avgEntry: 12.5, netPnl: 0, result: "breakeven",
    });
    expect(t!.events.map((e) => [e.kind, e.qty, e.realized])).toEqual([
      ["open", 10, undefined], ["add", 10, undefined], ["trim", 5, 7.5], ["close", 15, -7.5],
    ]);
  });

  it("subtracts Schwab fees from net P&L", () => {
    expect(find(trades, "BIGF")[0]).toMatchObject({ grossPnl: 5.5, fees: 1.31, netPnl: 4.19, result: "win" });
  });

  it("uses Schwab CSV order for same-day round trips", () => {
    const faku = find(trades, "FAKU", "2025-03-13");
    expect(faku.map((t) => [t.netPnl, t.result])).toEqual([[-0.4, "loss"], [1, "win"]]);
    expect(faku.every((t) => t.style === "swing" && t.sameDay)).toBe(true);
  });

  it("moves a same-day buy ahead of a sell that would oversell", () => {
    const { trades, reorderedDays } = build();
    expect(find(trades, "SDAY")[0]).toMatchObject({ status: "closed", netPnl: 0.5 });
    expect(reorderedDays).toEqual([{ account: "schwab-main", symbol: "SDAY", date: "2025-03-14" }]);
  });

  it("marks a sell with nothing open as unmatched and leaves it out of stats", () => {
    for (const sym of ["ORPH", "OLDP"]) {
      expect(find(trades, sym)[0]).toMatchObject({ status: "unmatched", result: null, netPnl: 0 });
    }
    expect(find(trades, "OLDP")[0]!.unmatchedQty).toBe(5);
    expect(summarize(trades).unmatched).toBe(2);
  });

  it("marks an oversold trade unmatched, scoring only the matched part", () => {
    const fills = allFills();
    const sell = fills.find((f) => f.symbol === "HOLD" && f.side === "sell")!;
    const { trades } = build(noOverrides(), fills.map((f) => (f === sell ? { ...f, qty: 3 } : f)));
    expect(find(trades, "HOLD")[0]).toMatchObject({ status: "unmatched", unmatchedQty: 1, grossPnl: 0.4, result: null });
  });

  it("fixes an unmatched sell with an opening position", () => {
    const overrides: Overrides = {
      trades: {},
      openingPositions: [{ account: "schwab-main", symbol: "OLDP", qty: 5, avgPrice: 7, openedAt: "2025-02-20" }],
    };
    const [t] = find(build(overrides).trades, "OLDP");
    expect(t).toMatchObject({ status: "closed", netPnl: 5, result: "win", openedAt: "2025-02-20T00:00:00-05:00" });
    expect(t!.fillIds).toHaveLength(1); // the opening position is not a fill
  });

  it("tracks an open position with realized P&L from trims", () => {
    const [t] = find(trades, "OPSW");
    expect(t).toMatchObject({ status: "open", openQty: 2, avgCost: 9, realizedPnl: 2, closedAt: null, result: null });
    expect(markToMarket(t!, 8.5)).toEqual({ unrealized: -1, realized: 2, total: 1, marketValue: 17, costBasis: 18 });
  });
});

describe("ETF mapping", () => {
  const { trades, ideas } = build();

  it("computes the trade on the ETF but labels the underlying", () => {
    const [t] = find(trades, "FAKU", "2025-03-12");
    expect(t).toMatchObject({ underlying: "FAKE", instrument: "leveraged_etf", leverage: 2, direction: "long", netPnl: -1 });
    expect(find(trades, "FAKE")[0]).toMatchObject({ underlying: "FAKE", instrument: "stock", leverage: 1 });
  });

  it("treats unmapped symbols as plain stocks", () => {
    expect(find(trades, "TSTU")[0]).toMatchObject({ underlying: "TSTU", instrument: "stock" });
  });

  it("groups a stock and its ETF on the same day into one day idea", () => {
    const idea = ideas.find((i) => i.underlying === "FAKE" && i.date === "2025-03-12")!;
    expect(idea).toMatchObject({ style: "day", symbolsTraded: ["FAKE", "FAKU"], usedEtf: true, netPnl: -0.5 });
    expect(idea.tradeIds).toHaveLength(2);
  });
});

describe("ideas", () => {
  const { trades, ideas } = build();

  it("puts every day trade on one underlying and date in one idea", () => {
    const idea = ideas.find((i) => i.underlying === "ZZTA" && i.date === "2025-03-10")!;
    expect(idea.tradeIds).toHaveLength(2);
    expect(idea.netPnl).toBe(0.7);
    expect(ideas.find((i) => i.underlying === "ZZTA" && i.date === "2025-03-17")!.tradeIds).toHaveLength(1);
  });

  it("joins a same-day swing re-entry to the previous idea", () => {
    const faku = find(trades, "FAKU", "2025-03-13");
    expect(faku[0]!.ideaId).toBe(faku[1]!.ideaId);
    const idea = ideas.find((i) => i.id === faku[0]!.ideaId)!;
    expect(idea).toMatchObject({ style: "swing", underlying: "FAKE", netPnl: 0.6, accounts: ["schwab-main"] });
  });

  it("keeps day and swing ideas apart even on the same underlying", () => {
    const fake = ideas.filter((i) => i.underlying === "FAKE");
    expect(fake.map((i) => i.style).sort()).toEqual(["day", "swing"]);
  });

  it("marks an idea open while any trade is open", () => {
    expect(ideas.find((i) => i.underlying === "OPSW")!.status).toBe("open");
  });

  it("gives every trade an idea that lists it", () => {
    const byId = new Map(ideas.map((i) => [i.id, i]));
    for (const t of trades) expect(byId.get(t.ideaId)!.tradeIds).toContain(t.id);
  });
});

describe("style and overrides", () => {
  it("defaults style by account intent", () => {
    const { trades } = build();
    expect(new Set(trades.filter((t) => t.broker === "webull").map((t) => t.style))).toEqual(new Set(["day"]));
    expect(new Set(trades.filter((t) => t.broker === "schwab").map((t) => t.style))).toEqual(new Set(["swing"]));
  });

  it("applies per-trade style, tags, note and exclude overrides", () => {
    const id = find(build().trades, "BIGF")[0]!.id;
    const { trades } = build({ trades: { [id]: { style: "day", tags: ["news"], note: "fast", exclude: true } }, openingPositions: [] });
    expect(find(trades, "BIGF")[0]).toMatchObject({ style: "day", tags: ["news"], note: "fast", excluded: true });
    expect(summarize(find(trades, "BIGF")).wins).toBe(0);
  });

  it("flags day trades held overnight without changing them", () => {
    const { trades } = build();
    const flagged = heldOvernightDayTrades(trades, "2025-03-20").map((t) => t.symbol).sort();
    expect(flagged).toEqual(["HOLD", "OPNQ"]);
    expect(find(trades, "HOLD")[0]!.style).toBe("day");
  });
});

describe("summary", () => {
  it("leaves breakevens, open and unmatched trades out of the win rate", () => {
    const s = summarize(build().trades);
    expect(s).toMatchObject({ trades: 21, closed: 17, open: 2, unmatched: 2, breakevens: 3 });
    expect(s.winRate).toBe(s.wins / (s.wins + s.losses));
    expect(s.wins + s.losses + s.breakevens).toBe(s.closed);
  });
});
