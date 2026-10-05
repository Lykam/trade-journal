import { describe, expect, it } from "vitest";
import { sessionsBetween, weekStart } from "../src/core/calendar";
import { computeGauge, isOpenAt, positionAt, quoteStatus, sizeState } from "../src/core/gauge/gauge";
import type { Quote, Trade } from "../src/core/types";
import { batch, closed, closeLater, open } from "./factory";
import { config } from "./helpers";

// Wednesday of the week Mon 2026-09-28 – Sun 2026-10-04. Baseline: 2026-06-30 – 2026-09-27.
const NOW = "2026-09-30T15:00:00-04:00";
const bands = config.gauge.bands;
const q = (price: number, time = "2026-09-30T14:45:00-04:00", extra: Partial<Quote> = {}): Quote => ({
  price, time, marketState: "REGULAR", ...extra,
});

/** A 60% day baseline (6W/4L) in the baseline period. */
const baseline60 = () => [...batch("day", "2026-09-10", 3, 2), ...batch("day", "2026-08-20", 3, 2)];

describe("size bands", () => {
  it("is full at exactly Δ = 0", () => {
    expect(sizeState(0, bands)).toBe("full");
  });
  it("is ½ just below 0 and at exactly Δ = −10", () => {
    expect(sizeState(-0.01, bands)).toBe("half");
    expect(sizeState(-10, bands)).toBe("half");
  });
  it("is ¼ below −10", () => {
    expect(sizeState(-10.01, bands)).toBe("quarter");
  });

  it("lands exactly on the edges with real win rates (60% vs 60%, 50% vs 60%)", () => {
    const atAverage = computeGauge("day", { trades: [...baseline60(), ...batch("day", "2026-09-29", 3, 2)], config, now: NOW });
    expect(atAverage.stats.winRate).toBe(0.6);
    expect(atAverage.baseline.winRate).toBe(0.6);
    expect(atAverage).toMatchObject({ delta: 0, state: "full" });

    const tenBelow = computeGauge("day", { trades: [...baseline60(), ...batch("day", "2026-09-29", 3, 3)], config, now: NOW });
    expect(tenBelow).toMatchObject({ delta: -10, state: "half" });
    expect(tenBelow.message).toContain("half size");

    const wellBelow = computeGauge("day", { trades: [...baseline60(), ...batch("day", "2026-09-29", 2, 3)], config, now: NOW });
    expect(wellBelow.state).toBe("quarter");
  });

  it("uses the configured bands", () => {
    const wide = { ...config, gauge: { ...config.gauge, bands: { halfSizeBelowPts: 5, quarterSizeBelowPts: 20 } } };
    const g = computeGauge("day", { trades: [...baseline60(), ...batch("day", "2026-09-29", 3, 3)], config: wide, now: NOW });
    expect(g.state).toBe("half");
    expect(sizeState(-4, wide.gauge.bands)).toBe("full");
  });
});

describe("backfill", () => {
  it("pads the day window to 5 with the most recent earlier trades and labels it", () => {
    const thisWeek = batch("day", "2026-09-29", 2, 1);
    const older = closed({ closedAt: "2026-09-21T10:00:00-04:00", net: 5 });
    const prev1 = closed({ closedAt: "2026-09-25T11:00:00-04:00", net: -2 });
    const prev2 = closed({ closedAt: "2026-09-25T15:00:00-04:00", net: 3 });
    const g = computeGauge("day", { trades: [older, prev1, prev2, ...thisWeek], config, now: NOW });
    expect(g.label).toBe("3 this week + 2 prior");
    expect(g.counts).toEqual({ week: 3, open: 0, prior: 2 });
    expect(g.items.filter((i) => i.source === "prior").map((i) => i.trade.id)).toEqual([prev2.id, prev1.id]);
    expect(g.stats).toMatchObject({ wins: 3, losses: 2, winRate: 0.6 });
  });

  it("does not pad when the week already has enough", () => {
    const g = computeGauge("day", { trades: [...batch("day", "2026-09-22", 4, 0), ...batch("day", "2026-09-29", 3, 2)], config, now: NOW });
    expect(g.label).toBe("5 this week");
  });

  it("pads the swing window to 3, counting open positions first", () => {
    const pos = open({ openedAt: "2026-09-15T00:00:00-04:00", price: 10, qty: 2 });
    const thisWeek = closed({ style: "swing", closedAt: "2026-09-29T00:00:00-04:00", net: 4 });
    const prior = batch("swing", "2026-09-18", 1, 2);
    const g = computeGauge("swing", { trades: [...prior, pos, thisWeek], config, now: NOW, quotes: { SWGA: q(11) } });
    expect(g.label).toBe("1 closed + 1 open + 1 prior");
    expect(g.counts).toEqual({ week: 1, open: 1, prior: 1 });
  });

  it("ignores later trades when computed for an earlier now", () => {
    const g = computeGauge("day", { trades: [...batch("day", "2026-09-29", 3, 2), ...batch("day", "2026-10-01", 0, 5)], config, now: NOW });
    expect(g.stats).toMatchObject({ wins: 3, losses: 2 });
  });
});

describe("swing mark-to-market", () => {
  const closedWin = closed({ style: "swing", closedAt: "2026-09-28T00:00:00-04:00", net: 1.2 });
  const closedLoss = closed({ style: "swing", closedAt: "2026-09-29T00:00:00-04:00", net: -0.4 });

  it("scores open positions on realized + unrealized at the latest quote", () => {
    const trimmed = open({
      symbol: "SWGA", openedAt: "2026-09-10T00:00:00-04:00",
      events: [
        { kind: "open", at: "2026-09-10T00:00:00-04:00", qty: 4, price: 10 },
        { kind: "trim", at: "2026-09-12T00:00:00-04:00", qty: 2, price: 11, realized: 2 },
      ],
    });
    const loser = open({ symbol: "SWGB", openedAt: "2026-09-24T00:00:00-04:00", qty: 3, price: 20 });
    const g = computeGauge("swing", {
      trades: [closedWin, closedLoss, trimmed, loser], config, now: NOW,
      quotes: { SWGA: q(9.5), SWGB: q(19) },
    });
    // SWGA: 2 × (9.5 − 10) + 2 realized = +1 (win). SWGB: 3 × (19 − 20) = −3 (loss).
    const opens = g.items.filter((i) => i.source === "open");
    expect(opens.map((i) => [i.trade.symbol, i.pnl, i.result])).toEqual([["SWGA", 1, "win"], ["SWGB", -3, "loss"]]);
    expect(g.stats).toMatchObject({
      wins: 2, losses: 2, winRate: 0.5, realized: 2.8, unrealized: -4,
      closed: { wins: 1, losses: 1 }, open: { wins: 1, losses: 1 },
    });
    expect(g.label).toBe("2 closed + 2 open");
    expect(g.pricesAsOf).toBe("2026-09-30T14:45:00-04:00");
  });

  it("leaves out a position with no quote and counts it as unpriced", () => {
    const priced = open({ symbol: "SWGA", openedAt: "2026-09-20T00:00:00-04:00", price: 10 });
    const missing = open({ symbol: "SWGC", openedAt: "2026-09-21T00:00:00-04:00", price: 10 });
    const g = computeGauge("swing", { trades: [closedWin, closedLoss, priced, missing], config, now: NOW, quotes: { SWGA: q(12) } });
    expect(g.unpriced.map((t) => t.symbol)).toEqual(["SWGC"]);
    expect(g.items.some((i) => i.trade.symbol === "SWGC")).toBe(false);
    expect(g.counts.open).toBe(1);
  });

  it("prices the ETF actually held, never its underlying", () => {
    const etf = open({ symbol: "FAKU", underlying: "FAKE", openedAt: "2026-09-20T00:00:00-04:00", price: 10 });
    const g = computeGauge("swing", { trades: [etf], config, now: NOW, quotes: { FAKE: q(50) } });
    expect(g.unpriced.map((t) => t.symbol)).toEqual(["FAKU"]);
    const g2 = computeGauge("swing", { trades: [etf], config, now: NOW, quotes: { FAKU: q(11) } });
    expect(g2.items[0]).toMatchObject({ pnl: 1, result: "win" });
  });

  it("still counts a stale quote but labels it", () => {
    const pos = open({ symbol: "SWGA", openedAt: "2026-09-20T00:00:00-04:00", price: 10 });
    // Last priced Monday's close; Tuesday's full session has passed by Wednesday 15:00.
    const g = computeGauge("swing", { trades: [closedWin, closedLoss, pos], config, now: NOW, quotes: { SWGA: q(11, "2026-09-28T16:00:00-04:00") } });
    expect(g.stale.map((t) => t.symbol)).toEqual(["SWGA"]);
    expect(g.items.find((i) => i.source === "open")).toMatchObject({ result: "win", quote: { isStale: true } });
  });

  it("treats a carried-over quote from a failed fetch as stale", () => {
    expect(quoteStatus(q(11, "2026-09-30T14:30:00-04:00", { stale: true }), NOW).isStale).toBe(true);
    expect(quoteStatus(q(11, "2026-09-30T14:30:00-04:00"), NOW).isStale).toBe(false);
  });

  it("calls Friday's close fresh over the weekend and Monday morning, stale by Tuesday", () => {
    const fri = q(11, "2026-10-02T16:00:00-04:00");
    expect(quoteStatus(fri, "2026-10-04T12:00:00-04:00").isStale).toBe(false);
    expect(quoteStatus(fri, "2026-10-05T11:00:00-04:00").isStale).toBe(false);
    expect(quoteStatus(fri, "2026-10-05T16:00:00-04:00").isStale).toBe(true);
  });

  it("drops open positions when swingIncludesOpenPositions is off", () => {
    const off = { ...config, gauge: { ...config.gauge, swingIncludesOpenPositions: false } };
    const pos = open({ openedAt: "2026-09-20T00:00:00-04:00" });
    const g = computeGauge("swing", { trades: [closedWin, pos], config: off, now: NOW, quotes: { SWGA: q(11) } });
    expect(g.items.some((i) => i.source === "open")).toBe(false);
    expect(g.label).toBe("1 this week");
  });
});

describe("open positions count in every week until closed", () => {
  const opened = open({
    symbol: "SWGA", openedAt: "2026-09-08T00:00:00-04:00",
    events: [
      { kind: "open", at: "2026-09-08T00:00:00-04:00", qty: 4, price: 10 },
      { kind: "trim", at: "2026-09-15T00:00:00-04:00", qty: 1, price: 12, realized: 2 },
    ],
  });
  const later = closeLater(opened, "2026-09-30T00:00:00-04:00", 13); // closes Wednesday of week 4
  const filler = [...batch("swing", "2026-08-10", 2, 2)];
  const weeks = ["2026-09-09T12:00:00-04:00", "2026-09-16T12:00:00-04:00", "2026-09-23T12:00:00-04:00"];

  it("is an open window item in each week it is held", () => {
    for (const now of weeks) {
      const g = computeGauge("swing", { trades: [...filler, later], config, now, quotes: { SWGA: q(11, now) } });
      expect(g.items.find((i) => i.trade.id === later.id)?.source).toBe("open");
    }
  });

  it("rebuilds the position as of each week (before and after the trim)", () => {
    expect(positionAt(later, weeks[0]!)).toEqual({ shares: 4, avgCost: 10, realized: 0 });
    expect(positionAt(later, weeks[1]!)).toEqual({ shares: 3, avgCost: 10, realized: 2 });
    const g = computeGauge("swing", { trades: [...filler, later], config, now: weeks[1]!, quotes: { SWGA: q(11, weeks[1]) } });
    expect(g.items.find((i) => i.trade.id === later.id)).toMatchObject({ pnl: 5, unrealized: 3, realized: 2 });
  });

  it("is a closed item in the week it closes, and not open after", () => {
    const closeWeek = computeGauge("swing", { trades: [...filler, later], config, now: "2026-10-01T12:00:00-04:00" });
    expect(closeWeek.items.find((i) => i.trade.id === later.id)?.source).toBe("week");
    expect(isOpenAt(later, "2026-10-01T12:00:00-04:00")).toBe(false);
    const after = computeGauge("swing", { trades: [...filler, ...batch("swing", "2026-10-06", 3, 0), later], config, now: "2026-10-07T12:00:00-04:00" });
    expect(after.items.some((i) => i.trade.id === later.id)).toBe(false);
  });

  it("still open now: counted with the trade's own fields", () => {
    const g = computeGauge("swing", { trades: [opened], config, now: NOW, quotes: { SWGA: q(9) } });
    // 3 × (9 − 10) + 2 = −1
    expect(g.items[0]).toMatchObject({ source: "open", pnl: -1, result: "loss" });
  });

  it("never enters the baseline while open", () => {
    const g = computeGauge("swing", { trades: [opened, ...filler], config, now: NOW, quotes: { SWGA: q(11) } });
    expect(g.baseline).toMatchObject({ wins: 2, losses: 2 });
  });
});

describe("breakevens", () => {
  it("are left out of the window win rate and do not fill the minimum", () => {
    const g = computeGauge("day", {
      trades: [...batch("day", "2026-09-25", 1, 0), ...batch("day", "2026-09-29", 3, 1, 2)], config, now: NOW,
    });
    expect(g.stats).toMatchObject({ wins: 4, losses: 1, breakevens: 2, winRate: 0.8 });
    expect(g.label).toBe("4 this week + 1 prior");
  });

  it("are left out of the baseline", () => {
    const g = computeGauge("day", { trades: [...batch("day", "2026-09-10", 1, 1, 5), ...batch("day", "2026-09-29", 5, 0)], config, now: NOW });
    expect(g.baseline).toMatchObject({ wins: 1, losses: 1, breakevens: 5, winRate: 0.5 });
  });

  it("an open position marked at exactly $0.00 is left out", () => {
    const pos = open({ openedAt: "2026-09-20T00:00:00-04:00", price: 10 });
    const g = computeGauge("swing", { trades: [pos], config, now: NOW, quotes: { SWGA: q(10) } });
    expect(g.items[0]).toMatchObject({ result: "breakeven" });
    expect(g.stats.winRate).toBeNull();
  });
});

describe("week boundaries (ET)", () => {
  it("weeks run Monday–Sunday in ET", () => {
    expect(weekStart("2026-09-28")).toBe("2026-09-28");
    expect(weekStart("2026-10-04")).toBe("2026-09-28");
    expect(weekStart("2026-10-05")).toBe("2026-10-05");
    expect(weekStart("2026-10-04", "sunday")).toBe("2026-10-04");
  });

  it("uses the ET date, not UTC, for late-evening closes and for now", () => {
    // 21:00 EDT Friday is Saturday in UTC: still this week. Sunday 23:30 EDT is Monday in UTC: still this week.
    const fri = closed({ closedAt: "2026-10-02T21:00:00-04:00", net: 1 });
    const g = computeGauge("day", { trades: [fri], config, now: "2026-10-05T03:30:00Z" });
    expect(g.week).toEqual({ start: "2026-09-28", end: "2026-10-04" });
    expect(g.items[0]).toMatchObject({ source: "week" });
  });

  it("handles the fall-back switch (Sun 2026-11-01)", () => {
    const sundayNight = closed({ closedAt: "2026-11-01T23:30:00-05:00", net: 1 }); // 04:30Z Monday
    const mondayMidnight = closed({ closedAt: "2026-11-02T00:00:00-05:00", net: -1 });
    const g = computeGauge("day", { trades: [sundayNight, mondayMidnight], config, now: "2026-11-02T04:45:00Z" });
    expect(g.week).toEqual({ start: "2026-10-26", end: "2026-11-01" });
    expect(g.items.filter((i) => i.source === "week").map((i) => i.trade.id)).toEqual([sundayNight.id]);
    const next = computeGauge("day", { trades: [sundayNight, mondayMidnight], config, now: "2026-11-02T05:00:00Z" });
    expect(next.week.start).toBe("2026-11-02");
    expect(next.items.filter((i) => i.source === "week").map((i) => i.trade.id)).toEqual([mondayMidnight.id]);
  });

  it("handles the spring-forward switch (Sun 2026-03-08)", () => {
    const g = computeGauge("day", { trades: [], config, now: "2026-03-09T03:59:00Z" }); // Sun 23:59 EDT
    expect(g.week.start).toBe("2026-03-02");
    const h = computeGauge("day", { trades: [], config, now: "2026-03-09T04:00:00Z" }); // Mon 00:00 EDT
    expect(h.week.start).toBe("2026-03-09");
  });

  it("counts sessions across the DST switch", () => {
    // Fri 10-30 close → Mon 11-02 16:00 EST: exactly Monday's session.
    expect(sessionsBetween("2026-10-30T16:00:00-04:00", "2026-11-02T16:00:00-05:00")).toBe(1);
    expect(sessionsBetween("2026-10-30T16:00:00-04:00", "2026-11-02T15:59:00-05:00")).toBe(0);
  });

  it("baseline is the 90 days before this week", () => {
    const edgeIn = closed({ closedAt: "2026-06-30T10:00:00-04:00", net: 1 });
    const edgeOut = closed({ closedAt: "2026-06-29T10:00:00-04:00", net: 1 });
    const lastSunday = closed({ closedAt: "2026-09-27T10:00:00-04:00", net: -1 });
    const g = computeGauge("day", { trades: [edgeIn, edgeOut, lastSunday, ...batch("day", "2026-09-29", 5, 0)], config, now: NOW });
    expect(g.baseline).toMatchObject({ from: "2026-06-30", to: "2026-09-27", wins: 1, losses: 1 });
  });
});

describe("window stats, baseline note and sparkline", () => {
  it("computes avg win/loss, profit factor and expectancy", () => {
    const t = (net: number, d: string) => closed({ closedAt: `2026-09-29T${d}:00-04:00`, net });
    const g = computeGauge("day", { trades: [t(3, "10:00"), t(1, "10:01"), t(-2, "10:02"), t(2, "10:03"), t(-1, "10:04")], config, now: NOW });
    expect(g.stats).toMatchObject({ net: 3, realized: 3, unrealized: 0, avgWin: 2, avgLoss: -1.5, profitFactor: 2, expectancy: 0.6 });
  });

  it("flags a low-confidence baseline under 20 trades", () => {
    const thin = computeGauge("day", { trades: baseline60(), config, now: NOW });
    expect(thin.baseline.lowConfidence).toBe(true);
    const solid = computeGauge("day", { trades: [...batch("day", "2026-09-01", 12, 8)], config, now: NOW });
    expect(solid.baseline.lowConfidence).toBe(false);
  });

  it("reports no state without a baseline or window", () => {
    expect(computeGauge("day", { trades: [], config, now: NOW })).toMatchObject({ state: null, delta: null });
    expect(computeGauge("day", { trades: batch("day", "2026-09-29", 1, 0), config, now: NOW }).message).toContain("No baseline");
  });

  it("shows 8 weeks of closed-trade win rates, oldest first, ending this week", () => {
    const trades: Trade[] = [...batch("day", "2026-08-05", 1, 1), ...batch("day", "2026-09-29", 3, 1)];
    trades.push(open({ style: "day", openedAt: "2026-09-29T10:00:00-04:00" }));
    const g = computeGauge("day", { trades, config, now: NOW });
    expect(g.sparkline).toHaveLength(8);
    expect(g.sparkline[0]).toMatchObject({ weekStart: "2026-08-10" });
    expect(g.sparkline[7]).toMatchObject({ weekStart: "2026-09-28", wins: 3, losses: 1, winRate: 0.75, current: true });
    expect(g.sparkline.slice(0, 7).every((p) => p.winRate === null)).toBe(true);
  });

  it("skips excluded trades", () => {
    const ex = closed({ closedAt: "2026-09-29T10:00:00-04:00", net: -5, excluded: true });
    const g = computeGauge("day", { trades: [ex, ...batch("day", "2026-09-29", 5, 0)], config, now: NOW });
    expect(g.stats.losses).toBe(0);
  });
});
