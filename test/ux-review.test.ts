// Logic behind the UX review fixes (issues #13–#23, SPEC Q54+). Synthetic trades, fake tickers only.
import { describe, expect, it } from "vitest";
import { buyFees, daysHeld, openPositions, rangeStats, sortOpenRows } from "../src/core/dashboard/dashboard";
import { lastImports } from "../src/core/imports";
import { computeGauge, winsToFull } from "../src/core/gauge/gauge";
import { importBehind, lastSessionDate } from "../src/core/market";
import { activeFilterLabels, defaultView, emptyFilter } from "../src/core/journal/filter";
import { buildJournal, groupPnl, type Journal } from "../src/core/journal/journal";
import { buildRows, sortRows, summarizeRows } from "../src/core/journal/rows";
import { buildUnits, computeGrid } from "../src/core/reports";
import type { Fill, QuotesFile, Trade } from "../src/core/types";
import { batch, closed, ideasOf, open } from "./factory";
import { compactMoney } from "../src/app/format";
import { dateTicks } from "../src/app/components/Widgets";
import { small, smallTitle } from "../src/app/components/StatsGrid";
import { config } from "./helpers";

const q = (price: number, time = "2026-10-02T16:00:00-04:00") => ({ price, time });

function journal(trades: Trade[], quotes: QuotesFile["quotes"] = {}, today = "2026-10-04"): Journal {
  return buildJournal(
    { derived: { generated: true, generator: "test", trades, ideas: ideasOf(trades) }, symbols: {}, config, playbook: null, quotes: { asOf: "2026-10-02T20:00:00Z", quotes } },
    today,
  );
}

describe("#14 open trades and positions", () => {
  it("counts days held in ET calendar days, even late in the evening when UTC is already tomorrow", () => {
    const t = open({ symbol: "SWGA", openedAt: "2026-09-17T00:00:00-04:00" });
    // 22:40 ET on 10-04 is 02:40 UTC on 10-05; rounding milliseconds gave 18.
    expect(daysHeld(t, "2026-10-04T22:40:00-04:00")).toBe(17);
    expect(openPositions([t], {}, "2026-10-04T22:40:00-04:00")[0]!.daysHeld).toBe(17);
  });

  it("reports buy fees apart, so a fee-only realized figure says what it is", () => {
    const t = open({
      symbol: "SWGA", openedAt: "2026-09-17T00:00:00-04:00",
      events: [{ kind: "open", at: "2026-09-17T00:00:00-04:00", qty: 5, price: 10, fees: 0.65 }],
    });
    const withFee = { ...t, realizedPnl: -0.65, netPnl: -0.65 };
    expect(buyFees(withFee)).toBe(0.65);
    expect(openPositions([withFee], { SWGA: q(11) }, "2026-10-02T17:00:00-04:00")[0]).toMatchObject({ realized: -0.65, buyFees: 0.65, trims: [] });
  });

  it("sorts the Open Positions table on any column, unpriced rows last either way", () => {
    const a = open({ symbol: "SWGA", openedAt: "2026-09-10T00:00:00-04:00", qty: 10, price: 10 });
    const b = open({ symbol: "SWGB", openedAt: "2026-09-11T00:00:00-04:00", qty: 10, price: 10 });
    const c = open({ symbol: "SWGC", openedAt: "2026-09-12T00:00:00-04:00", qty: 10, price: 10 });
    const rows = openPositions([a, b, c], { SWGA: q(9), SWGC: q(12) }, "2026-10-02T17:00:00-04:00");
    const order = (key: Parameters<typeof sortOpenRows>[1], dir: 1 | -1) => sortOpenRows(rows, key, dir).map((r) => r.trade.symbol);
    expect(order("total", -1)).toEqual(["SWGC", "SWGA", "SWGB"]);
    expect(order("total", 1)).toEqual(["SWGA", "SWGC", "SWGB"]);
    expect(order("symbol", -1)).toEqual(["SWGC", "SWGB", "SWGA"]);
  });

  it("marks open trades in tables instead of showing 0.00, and says when there is no price", () => {
    const won = closed({ symbol: "SWGA", closedAt: "2026-09-20T16:00:00-04:00", net: 40 });
    const held = { ...open({ symbol: "SWGA", openedAt: "2026-09-25T00:00:00-04:00", qty: 10, price: 10 }), ideaId: won.ideaId };
    const unpriced = open({ symbol: "SWGB", openedAt: "2026-09-25T00:00:00-04:00", qty: 10, price: 10 });
    const j = journal([won, held, unpriced], { SWGA: q(11.95) });
    expect(groupPnl(j, [held], "net")).toEqual({ value: 19.5, open: true });
    // An idea with a closed trade and an open one: realized result plus the open mark, still shown as open.
    expect(groupPnl(j, [won, held], "net")).toEqual({ value: 59.5, open: true });
    expect(groupPnl(j, [unpriced], "net")).toEqual({ value: null, open: true });
    expect(groupPnl(j, [won], "gross")).toEqual({ value: 40, open: false });
  });

  it("sorts open rows after closed ones on P&L, in both directions", () => {
    const loser = closed({ symbol: "ZZTA", closedAt: "2026-09-20T16:00:00-04:00", net: -5 });
    const winner = closed({ symbol: "ZZTB", closedAt: "2026-09-21T16:00:00-04:00", net: 5 });
    const held = open({ symbol: "SWGA", openedAt: "2026-09-25T00:00:00-04:00" });
    const j = journal([loser, winner, held], { SWGA: q(99) });
    const rows = buildRows(j.trades, j, "trade");
    const syms = (dir: "asc" | "desc") => sortRows(rows, { key: "pnl", dir }, defaultView().pnl).map((r) => r.symbol);
    expect(syms("desc")).toEqual(["ZZTB", "ZZTA", "SWGA"]);
    expect(syms("asc")).toEqual(["ZZTA", "ZZTB", "SWGA"]);
  });
});

describe("#15 dashboard", () => {
  it("knows the latest closed session, skipping weekends", () => {
    expect(lastSessionDate("2026-10-03T12:00:00-04:00")).toBe("2026-10-02"); // Saturday
    expect(lastSessionDate("2026-10-05T09:00:00-04:00")).toBe("2026-10-02"); // Monday before the open
    expect(lastSessionDate("2026-10-05T16:30:00-04:00")).toBe("2026-10-05"); // Monday after the close
    expect(lastSessionDate("2026-10-02T15:59:00-04:00")).toBe("2026-10-01"); // Friday before the close
  });

  it("flags an import that can't hold the latest closed session", () => {
    const sunday = "2026-10-04T20:00:00-04:00";
    expect(importBehind("2026-10-02T17:30:00-04:00", sunday)).toBe(false);
    expect(importBehind("2026-10-01T19:00:00-04:00", sunday)).toBe(true);
    expect(importBehind("2026-10-02T15:00:00-04:00", sunday)).toBe(true); // before Friday's close
  });

  it("takes each broker's latest import from the fills", () => {
    const f = (broker: Fill["broker"], importedAt: string) => ({ broker, importedAt }) as Fill;
    expect(lastImports([f("webull", "2026-10-01T22:00:00Z"), f("webull", "2026-10-02T22:00:00Z"), f("schwab", "2026-09-30T22:00:00Z"), f("schwab", "")]))
      .toEqual({ webull: "2026-10-02T22:00:00Z", schwab: "2026-09-30T22:00:00Z" });
  });

  it("counts the wins needed to get back to full size", () => {
    // Baseline 60% (6W 4L in earlier weeks); this week 2W 3L = 40%, no backfill needed.
    const trades = [...batch("day", "2026-09-15", 6, 4), ...batch("day", "2026-09-29", 2, 3)];
    const g = computeGauge("day", { trades, config, now: "2026-09-30T18:00:00-04:00" });
    expect(g.state).toBe("quarter");
    // (2 + k) / (5 + k) >= 60% first at k = 3: 5W 3L.
    expect(winsToFull(g, config)).toEqual({ wins: 3, w: 5, l: 3 });
  });

  it("lets each new win push an earlier backfilled trade out of the window", () => {
    // Monday before any trade: the window is the 5 latest earlier trades, newest first L L L W W (40%).
    const trades = [...batch("day", "2026-09-15", 4, 1), ...batch("day", "2026-09-22", 2, 3)];
    const g = computeGauge("day", { trades, config, now: "2026-09-28T08:00:00-04:00" });
    expect(g.counts).toEqual({ week: 0, open: 0, prior: 5 });
    expect(g.baseline.winRate).toBe(0.6);
    // 1 win + L L L W = 2W 3L; 2 wins + L L L = 2W 3L; 3 wins + L L = 3W 2L = 60%.
    expect(winsToFull(g, config)).toEqual({ wins: 3, w: 3, l: 2 });
  });

  it("has no target at full size", () => {
    const trades = [...batch("day", "2026-09-15", 6, 4), ...batch("day", "2026-09-29", 5, 0)];
    expect(winsToFull(computeGauge("day", { trades, config, now: "2026-09-30T18:00:00-04:00" }), config)).toBeNull();
  });

  it("splits the 30/60/90 widgets by style on request", () => {
    const trades = [...batch("day", "2026-09-29", 2, 1), closed({ style: "swing", closedAt: "2026-09-29T16:00:00-04:00", net: 50 })];
    const now = "2026-09-30T18:00:00-04:00";
    expect(rangeStats(trades, 30, now).summary.closed).toBe(4);
    expect(rangeStats(trades, 30, now, "day").summary.closed).toBe(3);
    expect(rangeStats(trades, 30, now, "swing").summary).toMatchObject({ closed: 1, netPnl: 50 });
  });
});

describe("#16 numbers that agree", () => {
  const usd = { pnl: "net" as const, mode: "usd" as const };

  it("splits average hold by style when a grid mixes day and swing trades", () => {
    const day = [
      closed({ closedAt: "2026-09-29T10:10:00-04:00", openedAt: "2026-09-29T10:00:00-04:00", net: 5, holdMinutes: 10 }),
      closed({ closedAt: "2026-09-29T11:30:00-04:00", openedAt: "2026-09-29T11:00:00-04:00", net: -5, holdMinutes: 30 }),
    ];
    const swing = [closed({ style: "swing", openedAt: "2026-09-19T00:00:00-04:00", closedAt: "2026-09-29T00:00:00-04:00", net: 20 })];
    const mixed = computeGrid(buildUnits([...day, ...swing], "trade"), usd);
    expect(mixed.hold.byStyle).toEqual({
      day: { all: 20, winners: 10, losers: 30 },
      swing: { all: 10 * 1440, winners: 10 * 1440, losers: null },
    });
    // One style only: no split, the plain averages as before.
    expect(computeGrid(buildUnits(day, "trade"), usd).hold).toMatchObject({ all: 20, byStyle: null });
  });

  it("counts open rows apart on the Trades summary, so closed matches Reports", () => {
    const a = closed({ closedAt: "2026-09-29T10:10:00-04:00", net: 5 });
    const b = open({ openedAt: "2026-09-30T00:00:00-04:00" });
    const j = journal([a, b]);
    expect(summarizeRows(buildRows(j.trades, j, "trade"), "net")).toMatchObject({ rows: 2, open: 1, wins: 1 });
  });
});

describe("#17 phone layout", () => {
  it("shows whole dollars with a true minus in small calendar cells", () => {
    expect([16.2, 170.67, -42.5, 30.05, 1234, -12500, 0].map(compactMoney)).toEqual(["+16", "+171", "−43", "+30", "+1.2k", "−13k", "0"]);
  });
});

describe("#19 charts", () => {
  it("labels the first, middle and last date under a chart", () => {
    expect(dateTicks([])).toEqual([]);
    expect(dateTicks(["09-01", "09-02"])).toEqual(["09-01", "09-02"]);
    expect(dateTicks(["a", "b", "c", "d", "e"])).toEqual(["a", "c", "e"]);
    expect(dateTicks(["a", "b", "c", "d"])).toEqual(["a", "b", "d"]);
  });
});

describe("#20 breakdowns", () => {
  it("grays ratio stats under 10 units and says why; no losses reads as a reason, not infinity", () => {
    const g = (count: number, wins: number, pf: number | null) => ({ count, wins, profitFactor: pf }) as never;
    expect(small(g(9, 3, 2))).toBe(true);
    expect(smallTitle(g(4, 4, null))).toBe("Only 4: too few to mean much");
    expect(small(g(10, 5, 1.5))).toBe(false);
    expect(smallTitle(g(12, 12, null))).toBe("No losses");
    expect(smallTitle(g(12, 6, 1.2))).toBeUndefined();
  });
});

describe("#21 trades", () => {
  it("names each active filter for the chips on a collapsed filter bar", () => {
    const f = { ...emptyFilter(), symbols: ["ZZTA"], style: "day" as const, instrument: "leveraged_etf" as const, results: ["win" as const, "loss" as const], review: "yes" as const, preset: "week" as const };
    expect(activeFilterLabels(f, "2026-10-04")).toEqual(["ZZTA", "DAY", "ETF", "WIN + LOSS", "REVIEWED", "THIS WEEK"]);
    expect(activeFilterLabels({ ...emptyFilter(), from: "2026-09-01", to: "2026-09-30" }, "2026-10-04")).toEqual(["2026-09-01 – 2026-09-30"]);
    expect(activeFilterLabels({ ...emptyFilter(), from: "2026-09-02", to: "2026-09-02" }, "2026-10-04")).toEqual(["2026-09-02"]);
    // The calendar ignores dates, so its chips leave them out.
    expect(activeFilterLabels({ ...emptyFilter(), preset: "week" }, "2026-10-04", "monday", false)).toEqual([]);
    expect(activeFilterLabels(emptyFilter(), "2026-10-04")).toEqual([]);
  });
});
