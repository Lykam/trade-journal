// Reports math and groupings (SPEC §6.5, Q42) on synthetic trades. Fake tickers only.
import { describe, expect, it } from "vitest";
import { etOffset } from "../src/core/normalize/util";
import {
  applyPreset, buildUnits, compareLabels,
 byDayOfWeek, byEntryPrice, byHour, byInstrument, byShares, COMPARE_PRESETS, computeGrid, daily, distribution,
  drawdownReport, drawdowns, holdOf, incompleteBeta, kelly, kRatio, maxStreaks, niceStep, parseReport, randomChance, regress,
  reportExtra, sameUnderlying, sqn, stdDev, tagGroups, topBottom, tTwoSided, valueOf, winLossDays,
} from "../src/core/reports";
import { defaultView, parseView } from "../src/core/journal/filter";
import { tradeTags } from "../src/core/journal/tags";
import type { Style, Trade } from "../src/core/types";

let n = 0;
interface Mk {
  symbol?: string;
  underlying?: string;
  style?: Style;
  /** ET wall-clock "YYYY-MM-DD HH:MM", or a bare date for date-only (Schwab) trades. */
  open: string;
  close: string;
  net: number;
  fees?: number;
  qty?: number;
  price?: number;
  idea?: string;
  tags?: string[];
  status?: Trade["status"];
  excluded?: boolean;
}

const iso = (s: string) => {
  const [d, t] = s.split(" ");
  return `${d}T${t ?? "00:00"}:00${etOffset(d!)}`;
};

/** A round trip bought at `price` × `qty`; date-only times make it a Schwab trade. */
function mk(o: Mk): Trade {
  const id = `r-${String(++n).padStart(4, "0")}`;
  const timed = o.open.includes(" ");
  const symbol = o.symbol ?? "ZZTA";
  const qty = o.qty ?? 2, price = o.price ?? 10, fees = o.fees ?? 0;
  const openedAt = iso(o.open), closedAt = iso(o.close);
  const gross = Math.round((o.net + fees) * 100) / 100;
  return {
    id, ideaId: o.idea ?? id, account: timed ? "webull" : "schwab-main", broker: timed ? "webull" : "schwab",
    symbol, underlying: o.underlying ?? symbol, instrument: o.underlying ? "leveraged_etf" : "stock", leverage: o.underlying ? 2 : 1,
    direction: "long", style: o.style ?? (timed ? "day" : "swing"), sameDay: o.open.slice(0, 10) === o.close.slice(0, 10),
    openedAt, closedAt, status: o.status ?? "closed", maxPosition: qty, openQty: 0, unmatchedQty: 0, avgEntry: price,
    avgExit: price + gross / qty, grossPnl: gross, fees, netPnl: o.net,
    result: o.status && o.status !== "closed" ? null : o.net > 0 ? "win" : o.net < 0 ? "loss" : "breakeven",
    holdMinutes: timed ? (Date.parse(closedAt) - Date.parse(openedAt)) / 60_000 : null, fillIds: [id],
    avgCost: price, realizedPnl: o.net,
    events: [
      { kind: "open", at: openedAt, qty, price },
      { kind: "close", at: closedAt, qty, price: price + gross / qty, realized: gross },
    ],
    tags: o.tags ?? [], excluded: o.excluded ?? false,
  };
}

const NET = { pnl: "net", mode: "usd" } as const;

describe("math", () => {
  const xs = [10, -5, 20, -10, 5];

  it("sample std dev and SQN (√n × mean ÷ sd)", () => {
    expect(stdDev(xs)).toBeCloseTo(11.937336, 6);
    expect(sqn(xs)).toBeCloseTo(0.749269, 6);
    expect(stdDev([5])).toBeNull();
    expect(sqn([3, 3, 3])).toBeNull();
  });

  it("two-sided Student's t p-values match t-table points", () => {
    expect(tTwoSided(1, 1)).toBeCloseTo(0.5, 12);
    expect(tTwoSided(2, 10)).toBeCloseTo(0.073388, 6);
    expect(tTwoSided(2.228139, 10)).toBeCloseTo(0.05, 6);
    expect(tTwoSided(-2.776445, 4)).toBeCloseTo(0.05, 6);
    expect(tTwoSided(0, 7)).toBeCloseTo(1, 12);
    expect(incompleteBeta(0.5, 2, 2)).toBeCloseTo(0.5, 12);
  });

  it("probability of random chance is the t-test p-value of the mean P&L", () => {
    expect(randomChance(xs)).toBeCloseTo(0.495354, 6);
    expect(randomChance([1])).toBeNull();
  });

  it("Kelly % = W − (1 − W) ÷ (avg win ÷ |avg loss|)", () => {
    expect(kelly(0.6, 100, -50)).toBeCloseTo(0.4, 12);
    expect(kelly(0.3, 50, -50)).toBeCloseTo(-0.4, 12);
    expect(kelly(1, 10, null)).toBeNull();
  });

  it("K-ratio = slope ÷ (SE of slope × n) on the cumulative curve", () => {
    // y = 1, 3, 2, 5: slope 1.1, residual SS 2.7, SE √(1.35 ÷ 5).
    expect(regress([1, 3, 2, 5])).toMatchObject({ slope: 1.1 });
    expect(regress([1, 3, 2, 5])!.slopeSe).toBeCloseTo(Math.sqrt(0.27), 12);
    expect(kRatio([1, 3, 2, 5])).toBeCloseTo(1.1 / (Math.sqrt(0.27) * 4), 12);
    expect(kRatio([2, 4, 6])).toBe(Infinity);
    expect(kRatio([1, 2])).toBeNull();
  });

  it("streaks: a breakeven ends a run; the earliest of equal runs is kept", () => {
    const s = maxStreaks(["win", "win", "loss", "loss", "loss", "breakeven", "loss", "win", "win", "win", "loss", "loss", "loss"]);
    expect(s.win).toEqual({ length: 3, start: 7, end: 9 });
    expect(s.loss).toEqual({ length: 3, start: 2, end: 4 });
    expect(maxStreaks(["breakeven"])).toEqual({ win: null, loss: null });
  });

  it("drawdowns from the running peak, starting at 0", () => {
    const dd = drawdowns([
      { date: "d1", value: 10 }, { date: "d2", value: -4 }, { date: "d3", value: -6 }, { date: "d4", value: 12 }, { date: "d5", value: -3 },
    ]);
    expect(dd.curve.map((c) => c.underwater)).toEqual([0, -4, -10, 0, -3]);
    expect(dd.periods).toEqual([
      { peakDate: "d1", peak: 10, troughDate: "d3", trough: 0, depth: 10, recoveredDate: "d4" },
      { peakDate: "d4", peak: 12, troughDate: "d5", trough: 9, depth: 3, recoveredDate: null },
    ]);
    expect(dd.max!.depth).toBe(10);
    // An opening loss is a drawdown from the start.
    expect(drawdowns([{ date: "a", value: -5 }, { date: "b", value: 5 }]).periods[0]).toMatchObject({ peakDate: "", depth: 5, recoveredDate: "b" });
  });
});

describe("units", () => {
  const a = mk({ open: "2026-03-02 09:35", close: "2026-03-02 09:50", net: 5, idea: "I1", qty: 4, price: 5 });
  const b = mk({ symbol: "ZZTU", underlying: "ZZTA", open: "2026-03-02 10:00", close: "2026-03-02 10:30", net: -8, fees: 1, idea: "I1", qty: 2, price: 20 });
  const openT = mk({ open: "2026-03-02 11:00", close: "2026-03-02 11:00", net: 0, idea: "I1", status: "open" });
  const c = mk({ open: "2026-03-02", close: "2026-03-05", net: 0 });

  it("one unit per scored trade, in close order", () => {
    const us = buildUnits([c, b, openT, a], "trade");
    expect(us.map((u) => u.id)).toEqual([a.id, b.id, c.id]);
    expect(us[1]).toMatchObject({ gross: -7, net: -8, fees: 1, cost: 40, shares: 2, volume: 4, instrument: "leveraged_etf", entryHour: 10, holdMinutes: 30 });
    expect(us[2]).toMatchObject({ result: "breakeven", holdMinutes: null, holdDays: 3, entryHour: null, broker: "schwab" });
  });

  it("an idea combines its scored trades and scores on their net (Q28)", () => {
    const [idea] = buildUnits([a, b, openT], "idea");
    expect(idea).toMatchObject({
      kind: "idea", id: "I1", net: -3, gross: -2, result: "loss", symbol: "ZZTA+ZZTU", instrument: "mixed", cost: 60, shares: 6, holdMinutes: 55,
    });
    expect(idea!.trades).toHaveLength(2);
  });

  it("values: $ gross / net, or % return on cost; result stays on net", () => {
    const [u] = buildUnits([b], "trade");
    expect(valueOf(u!, NET)).toBe(-8);
    expect(valueOf(u!, { pnl: "gross", mode: "usd" })).toBe(-7);
    expect(valueOf(u!, { pnl: "net", mode: "pct" })).toBeCloseTo(-0.2, 12);
    const gross = mk({ open: "2026-03-03 09:31", close: "2026-03-03 09:40", net: -0.5, fees: 1 });
    expect(buildUnits([gross], "trade")[0]).toMatchObject({ gross: 0.5, result: "loss" });
  });

  it("hold for averages: timed minutes, else whole days; untimed same-day has none", () => {
    const [u1, u2] = buildUnits([a, c], "trade");
    expect(holdOf(u1!)).toBe(15);
    expect(holdOf(u2!)).toBe(3 * 1440);
    expect(holdOf(buildUnits([mk({ open: "2026-03-04", close: "2026-03-04", net: 1 })], "trade")[0]!)).toBeNull();
  });
});

describe("stats grid", () => {
  // Two days. Mon: +10 (4 sh), −4 (2 sh), +6 (2 sh). Tue: −8 (2 sh), 0 (2 sh), +2 (2 sh, fees 0.50).
  const trades = [
    mk({ open: "2026-03-02 09:30", close: "2026-03-02 09:40", net: 10, qty: 4 }),
    mk({ open: "2026-03-02 10:00", close: "2026-03-02 10:20", net: -4 }),
    mk({ open: "2026-03-02 11:00", close: "2026-03-02 11:30", net: 6 }),
    mk({ open: "2026-03-03 09:30", close: "2026-03-03 10:30", net: -8 }),
    mk({ open: "2026-03-03 11:00", close: "2026-03-03 11:05", net: 0 }),
    mk({ open: "2026-03-03 12:00", close: "2026-03-03 12:50", net: 2, fees: 0.5 }),
  ];
  const units = buildUnits(trades, "trade");
  const g = computeGrid(units, NET);

  it("counts, totals and averages", () => {
    expect(g).toMatchObject({
      count: 6, wins: 3, losses: 2, breakevens: 1, winRate: 0.6, winShare: 0.5, total: 6, days: 2, avgDaily: 3, avgUnit: 1,
      avgWin: 6, avgLoss: -6, fees: 0.5,
    });
    expect(g.lossShare).toBeCloseTo(1 / 3, 12);
    // Volume is shares bought + sold: (4 + 2 + 2 + 2 + 2 + 2) × 2 over 2 days.
    expect(g.avgDailyVolume).toBe(14);
    expect(g.avgPerShare).toBeCloseTo(6 / 14, 12);
    expect(g.largestGain!.value).toBe(10);
    expect(g.largestLoss!.unit.id).toBe(trades[3]!.id);
  });

  it("hold, streaks, profit factor, expectancy, Kelly", () => {
    expect(g.hold.all).toBeCloseTo((10 + 20 + 30 + 60 + 5 + 50) / 6, 12);
    expect(g.hold.winners).toBe(30);
    expect(g.hold.losers).toBe(40);
    expect(g.streaks.win).toMatchObject({ length: 1 });
    expect(g.streaks.loss!.units.map((u) => u.id)).toEqual([trades[1]!.id]);
    expect(g.profitFactor).toBe(1.5);
    // W × avg win + (1 − W) × avg loss = 0.6 × 6 − 0.4 × 6.
    expect(g.expectancy).toBeCloseTo(1.2, 12);
    expect(g.kelly).toBeCloseTo(0.2, 12);
    expect(g.stdDev).toBeCloseTo(stdDev([10, -4, 6, -8, 0, 2])!, 12);
    expect(g.kRatio).toBeNull(); // two days only
  });

  it("daily points carry cumulative P&L, win rate and volume", () => {
    expect(daily(units, NET)).toEqual([
      { date: "2026-03-02", value: 12, cum: 12, units: 3, wins: 2, losses: 1, winRate: 2 / 3, volume: 16 },
      { date: "2026-03-03", value: -6, cum: 6, units: 3, wins: 1, losses: 1, winRate: 0.5, volume: 12 },
    ]);
  });

  it("an empty set gives empty stats", () => {
    expect(computeGrid([], NET)).toMatchObject({ count: 0, winRate: null, total: 0, avgDaily: null, largestGain: null, expectancy: null, kelly: null });
  });
});

describe("breakdowns", () => {
  const trades = [
    mk({ open: "2026-03-02 09:35", close: "2026-03-02 09:50", net: 5, price: 1.5 }), // Mon
    mk({ open: "2026-03-03 13:10", close: "2026-03-03 14:00", net: -2, price: 30 }), // Tue
    mk({ open: "2026-03-02", close: "2026-03-06", net: 9, price: 150, qty: 10 }), // Fri close, Schwab
    mk({ symbol: "FAKU", underlying: "FAKE", open: "2026-03-04 09:40", close: "2026-03-04 09:45", net: -1, price: 8 }),
    mk({ symbol: "FAKE", open: "2026-03-04 10:00", close: "2026-03-04 10:10", net: 3, price: 60 }),
  ];
  const units = buildUnits(trades, "trade");

  it("day of week (Monday first) and entry hour (timed only)", () => {
    expect(byDayOfWeek(units, NET).map((b) => [b.label, b.total])).toEqual([["MON", 5], ["TUE", -2], ["WED", 2], ["FRI", 9]]);
    const h = byHour(units, NET);
    expect(h.buckets.map((b) => [b.label, b.count])).toEqual([["09:00", 2], ["10:00", 1], ["13:00", 1]]);
    expect(h.untimed).toBe(1);
  });

  it("entry price and size buckets", () => {
    expect(byEntryPrice(units, NET).map((b) => b.label)).toEqual(["< $2", "$5–$10", "$20–$50", "$50–$100", "$100–$200"]);
    expect(byShares(units, NET).map((b) => [b.label, b.count])).toEqual([["2–5", 4], ["6–10", 1]]);
  });

  it("instrument, same underlying, top / bottom", () => {
    expect(byInstrument(units, NET).map((b) => [b.label, b.total])).toEqual([["STOCK", 15], ["ETF", -1]]);
    const same = sameUnderlying(units, NET);
    expect(same).toHaveLength(1);
    expect(same[0]).toMatchObject({ underlying: "FAKE", stock: { count: 1, total: 3 }, etf: { count: 1, total: -1 }, mixed: null });
    const tb = topBottom([{ key: "a", total: 3 }, { key: "b", total: -5 }, { key: "c", total: 1 }] as never);
    expect(tb.top.map((b) => b.key)).toEqual(["a", "c"]);
    expect(tb.bottom.map((b) => b.key)).toEqual(["b"]);
  });

  it("P&L distribution in nice bins with 0 as an edge", () => {
    expect(niceStep(11, 12)).toBe(1);
    expect(niceStep(230, 12)).toBe(20);
    const d = distribution(units, NET);
    expect(d.step).toBe(1);
    expect(d.bins[0]).toMatchObject({ from: -2, to: -1, count: 1, losses: 1 });
    expect(d.bins.reduce((s, b) => s + b.count, 0)).toBe(5);
    expect(d.bins.find((b) => b.from === 9)).toMatchObject({ count: 1, wins: 1 });
  });
});

describe("win vs loss days, drawdown, tags", () => {
  const trades = [
    mk({ open: "2026-03-02 09:30", close: "2026-03-02 09:40", net: 10, qty: 4 }), // green day
    mk({ open: "2026-03-02 10:00", close: "2026-03-02 10:20", net: -4 }),
    mk({ open: "2026-03-03 09:30", close: "2026-03-03 10:30", net: -8, tags: ["chase"] }), // red day
    mk({ open: "2026-03-04 09:30", close: "2026-03-04 09:35", net: 3, tags: ["chase"] }), // flat day
    mk({ open: "2026-03-04 09:40", close: "2026-03-04 09:45", net: -3 }),
    mk({ open: "2026-03-06 09:30", close: "2026-03-06 09:40", net: 9, style: "swing" }), // green day, recovers
  ];
  const units = buildUnits(trades, "trade");

  it("splits units by their day's net color", () => {
    const w = winLossDays(units, NET);
    expect(w.green.days).toBe(2);
    expect(w.red.days).toBe(1);
    expect(w.flatDays).toBe(1);
    expect(w.green.grid).toMatchObject({ count: 3, total: 15 });
    expect(w.green.perDay).toMatchObject({ units: 1.5, hold: 40 / 3 });
    expect(w.red.perDay).toMatchObject({ units: 1, shares: 2, cost: 20, hold: 60 });
  });

  it("drawdown: max $ and % of peak, longest, recovery", () => {
    const d = drawdownReport(units, NET);
    // Equity 10, 6, −2, 1, −2, 7: peak 10 on 03-02, trough −2, never back to 10.
    expect(d.max).toMatchObject({ peakDate: "2026-03-02", peak: 10, depth: 12, troughDate: "2026-03-03", recoveredDate: null });
    expect(d.maxPctOfPeak).toBeCloseTo(1.2, 12);
    expect(d.recoveryDays).toBeNull();
    expect(d.declineDays).toBe(1);
    expect(d.longest).toMatchObject({ days: 4 });
    expect(d.current).toBe(-3);
    expect(d.days.map((x) => [x.date, x.equity, x.underwater])).toEqual([
      ["2026-03-02", 6, -4], ["2026-03-03", -2, -12], ["2026-03-04", -2, -12], ["2026-03-06", 7, -3],
    ]);
    expect(drawdownReport(units, { pnl: "net", mode: "pct" }).maxPctOfPeak).toBeNull();
  });

  it("tag groups: manual tags, review categories and styles", () => {
    const tags = (t: Trade) => tradeTags(t, t.tags.includes("chase") ? ["Breaking news"] : null);
    const g = tagGroups(trades, tags, "trade", NET);
    expect(g.map((x) => [x.kind, x.tag, x.grid.count, x.grid.total])).toEqual([
      ["manual", "chase", 2, -5], ["category", "Breaking news", 2, -5], ["style", "Day", 5, -2], ["style", "Swing", 1, 9],
    ]);
  });
});

describe("report URL state", () => {
  it("round-trips tab, sub-tab, $ / %, compare set and tag; defaults stay out", () => {
    const p = new URLSearchParams("tab=compare&sub=price&mode=pct&b=style%3Dswing%26range%3D30d&style=day");
    const r = parseReport(p);
    expect(r).toMatchObject({ tab: "compare", sub: "price", mode: "pct", tag: null });
    expect(r.b).toMatchObject({ style: "swing", preset: "30d" });
    expect(reportExtra(r)).toEqual({ tab: "compare", sub: "price", mode: "pct", b: "style=swing&range=30d" });
    expect(reportExtra(parseReport(new URLSearchParams("tab=nope&mode=x")))).toEqual({});
    expect(reportExtra({ ...parseReport(new URLSearchParams("")), tab: "tags", tag: "chase" })).toEqual({ tab: "tags", tag: "chase" });
  });

  it("compare presets keep the rest of the current filter on both sides, but reset what presets set (#18)", () => {
    const view = { ...defaultView(), filter: { ...parseView(new URLSearchParams("symbol=ZZTA&style=day&result=win")).filter } };
    const { a, b } = applyPreset(view, COMPARE_PRESETS.find((x) => x.key === "instrument")!);
    // Symbol and result stay; style is a preset field, so a left-over DAY from DAY VS SWING doesn't carry over.
    expect(a).toMatchObject({ symbols: ["ZZTA"], results: ["win"], style: null, instrument: "stock" });
    expect(b).toMatchObject({ symbols: ["ZZTA"], results: ["win"], style: null, instrument: "leveraged_etf" });
  });

  it("compare presets don't stack: DAY VS SWING then THIS MONTH VS LAST MONTH compares all styles", () => {
    const first = applyPreset(defaultView(), COMPARE_PRESETS.find((x) => x.key === "style")!);
    // The first preset becomes the global filter (side A), as the page does.
    const second = applyPreset({ ...defaultView(), filter: first.a }, COMPARE_PRESETS.find((x) => x.key === "month")!);
    expect(second.a).toMatchObject({ style: null, preset: "month" });
    expect(second.b).toMatchObject({ style: null, preset: "lastmonth" });
  });

  it("names what tells the two Compare sides apart", () => {
    const { a, b } = applyPreset(defaultView(), COMPARE_PRESETS.find((x) => x.key === "style")!);
    expect(compareLabels(a, b, "2026-10-04")).toEqual({ a: ["DAY", "ALL DATES"], b: ["SWING", "ALL DATES"], same: false });
    const m = applyPreset(defaultView(), COMPARE_PRESETS.find((x) => x.key === "month")!);
    expect(compareLabels(m.a, m.b, "2026-10-04")).toMatchObject({ a: ["THIS MONTH"], b: ["LAST MONTH"] });
    expect(compareLabels(a, a, "2026-10-04").same).toBe(true);
  });
});

