import { describe, expect, it } from "vitest";
import {
  durationBucket, holdLabel, needsAttention, openPositions, openTotals, rangeStats, recentTrades, weekStrip,
} from "../src/core/dashboard/dashboard";
import type { Quote, Trade } from "../src/core/types";
import { batch, closed, open } from "./factory";

const NOW = "2026-09-30T15:00:00-04:00";
const q = (price: number, time = "2026-09-30T14:45:00-04:00", stale?: true): Quote => ({ price, time, ...(stale ? { stale } : {}) });

describe("open positions", () => {
  const trimmed = open({
    symbol: "SWGA", openedAt: "2026-09-25T00:00:00-04:00",
    events: [
      { kind: "open", at: "2026-09-25T00:00:00-04:00", qty: 4, price: 10 },
      { kind: "add", at: "2026-09-26T00:00:00-04:00", qty: 2, price: 13 },
      { kind: "trim", at: "2026-09-28T00:00:00-04:00", qty: 2, price: 14, realized: 6 },
    ],
  });
  const etf = open({ symbol: "FAKU", underlying: "FAKE", openedAt: "2026-09-29T00:00:00-04:00", qty: 3, price: 20 });

  it("marks each position on average cost: unrealized, realized from trims, total", () => {
    const [a] = openPositions([trimmed], { SWGA: q(12) }, NOW);
    // avg cost (4×10 + 2×13)/6 = 11; 4 sh × (12 − 11) = 4; trims realized 6.
    expect(a).toMatchObject({
      shares: 4, maxShares: 6, avgCost: 11, costBasis: 44, last: 12, marketValue: 48, unrealized: 4, realized: 6, total: 10,
      daysHeld: 5, unrealizedPct: 0.090909,
    });
    expect(a!.trims).toHaveLength(1);
  });

  it("shows — for a position without a quote and leaves it out of the P&L totals", () => {
    const rows = openPositions([trimmed, etf], { SWGA: q(12), FAKE: q(99) }, NOW);
    expect(rows[1]).toMatchObject({ quote: null, last: null, unrealized: null, total: null });
    expect(openTotals(rows)).toMatchObject({
      count: 2, priced: 1, unpriced: 1, unrealized: 4, realized: 6, total: 10, green: 1, red: 0, marketValue: 48,
    });
    expect(needsAttention([trimmed, etf], rows, NOW).unpriced.map((t) => t.symbol)).toEqual(["FAKU"]);
  });

  it("flags stale quotes", () => {
    const rows = openPositions([trimmed], { SWGA: q(12, "2026-09-25T16:00:00-04:00") }, NOW);
    expect(openTotals(rows).stale).toBe(1);
    expect(needsAttention([trimmed], rows, NOW).stale).toHaveLength(1);
  });
});

describe("recent 10", () => {
  it("takes the latest 10 closed trades of a style, newest first, streak oldest → newest", () => {
    const trades = [...batch("day", "2026-09-28", 6, 0), ...batch("day", "2026-09-29", 0, 4, 1), ...batch("swing", "2026-09-29", 1, 0)];
    const r = recentTrades(trades, "day");
    expect(r.trades).toHaveLength(10);
    expect(r.trades[0]!.result).toBe("breakeven");
    expect(r.streak.slice(-5)).toEqual(["loss", "loss", "loss", "loss", "breakeven"]);
    expect(r.summary).toMatchObject({ wins: 5, losses: 4, breakevens: 1 });
  });
});

describe("hold time and duration", () => {
  it("labels timed and date-only trades", () => {
    expect(holdLabel(closed({ closedAt: "2026-09-29T10:00:00-04:00", net: 1, holdMinutes: 2.5 }))).toBe("2m 30s");
    expect(holdLabel(closed({ closedAt: "2026-09-29T13:00:00-04:00", net: 1, holdMinutes: 185 }))).toBe("3h 05m");
    expect(holdLabel(closed({ style: "swing", openedAt: "2026-09-29T00:00:00-04:00", closedAt: "2026-09-29T00:00:00-04:00", net: 1 }))).toBe("same day");
    expect(holdLabel(closed({ style: "swing", openedAt: "2026-09-26T00:00:00-04:00", closedAt: "2026-09-29T00:00:00-04:00", net: 1 }))).toBe("3d");
  });

  it("buckets by duration, with date-only same-day trades kept apart", () => {
    const c = (o: Partial<Parameters<typeof closed>[0]>) => durationBucket(closed({ closedAt: "2026-09-29T10:00:00-04:00", net: 1, ...o }));
    expect(c({ holdMinutes: 4.9 })).toBe("< 5 min");
    expect(c({ holdMinutes: 5 })).toBe("5–30 min");
    expect(c({ holdMinutes: 119 })).toBe("30 min–2 h");
    expect(c({ holdMinutes: 300 })).toBe("2h – close");
    expect(c({ holdMinutes: null })).toBe("same day (no time)");
    expect(c({ openedAt: "2026-09-24T00:00:00-04:00" })).toBe("1–5 days");
    expect(c({ openedAt: "2026-09-08T00:00:00-04:00" })).toBe("1–4 weeks");
    expect(c({ openedAt: "2026-08-01T00:00:00-04:00" })).toBe("> 4 weeks");
  });
});

describe("week strip", () => {
  it("sums closed trades per ET day across the gauge week", () => {
    const trades = [...batch("day", "2026-09-29", 2, 1), closed({ closedAt: "2026-10-02T21:00:00-04:00", net: -3 })];
    const cards = weekStrip(trades, "2026-10-04");
    expect(cards.map((c) => c.date)).toEqual(["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"]);
    expect(cards[1]).toEqual({ date: "2026-09-29", net: 1, trades: 3 });
    expect(cards[4]).toEqual({ date: "2026-10-02", net: -3, trades: 1 });
  });
});

describe("range widgets", () => {
  const trades: Trade[] = [
    closed({ closedAt: "2026-09-01T10:00:00-04:00", net: 100 }), // outside 30D
    closed({ closedAt: "2026-09-28T10:00:00-04:00", net: 4, holdMinutes: 10 }),
    closed({ closedAt: "2026-09-28T11:00:00-04:00", net: -2, holdMinutes: 2 }),
    closed({ closedAt: "2026-09-29T10:00:00-04:00", net: 0, holdMinutes: 1 }),
    closed({ style: "swing", openedAt: "2026-09-25T00:00:00-04:00", closedAt: "2026-09-29T00:00:00-04:00", net: 6 }),
    closed({ closedAt: "2026-09-30T10:00:00-04:00", net: -5, excluded: true }),
  ];
  const r = rangeStats(trades, 30, NOW);

  it("covers the last N ET days and skips excluded trades", () => {
    expect(r).toMatchObject({ from: "2026-09-01", to: "2026-09-30" });
    const r29 = rangeStats(trades, 29, NOW);
    expect(r29.summary).toMatchObject({ wins: 2, losses: 1, breakevens: 1, netPnl: 8 });
  });

  it("builds the cumulative curve by close date", () => {
    expect(r.cumulative).toEqual([
      { date: "2026-09-01", net: 100, cum: 100 },
      { date: "2026-09-28", net: 2, cum: 102 },
      { date: "2026-09-29", net: 6, cum: 108 },
    ]);
  });

  it("computes avg win/loss, profit factor, largest, hold times and day-of-week", () => {
    expect(r).toMatchObject({ avgWin: 36.67, avgLoss: -2, profitFactor: 55 });
    expect(r.largestGain!.netPnl).toBe(100);
    expect(r.largestLoss!.netPnl).toBe(-2);
    expect(r.hold.day).toEqual({ winners: 10, losers: 2, unit: "min" });
    expect(r.hold.swing).toEqual({ winners: 4, losers: null, unit: "days" });
    expect(r.byDayOfWeek.map((b) => b.dow)).toEqual([1, 2, 3, 4, 5]);
    expect(r.byDayOfWeek[1]).toMatchObject({ dow: 2, net: 106, trades: 3 }); // 09-01 and 09-29 are Tuesdays
    expect(r.winByDay[2]).toMatchObject({ date: "2026-09-29", wins: 1, losses: 0, winRate: 1 });
  });
});
