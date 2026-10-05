// Trades table, filter bar, calendar and bulk overrides (SPEC §6.0, §6.2, §6.3, §6.6). Synthetic trades only.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dailyTotals, monthGrid, yearView } from "../src/core/journal/calendar-view";
import {
  dateRange, defaultView, emptyFilter, parseView, queryOf, tradeMatcher, viewToParams, type TradeFilter, type ViewState,
} from "../src/core/journal/filter";
import { buildJournal, exitMissing, filterReviews, filterTrades, journalOrder, reviewAttention, type Journal } from "../src/core/journal/journal";
import { applyBulkAction, changedOverrideIds, previewOverrides } from "../src/core/journal/overrides";
import { buildRows, neighbors, pageOf, paginate, sortRows, summarizeRows, tradeOrder, viewRows } from "../src/core/journal/rows";
import type { DerivedTrades, Fill, Idea, ReviewFile, Trade } from "../src/core/types";
import { closed, ideasOf, open } from "./factory";
import { config, FIXTURES, noOverrides, symbols } from "./helpers";

const TODAY = "2025-04-10";

function journal(trades: Trade[], reviews: ReviewFile[] = [], today = TODAY): Journal {
  return buildJournal({ derived: { generated: true, generator: "test", trades, ideas: ideasOf(trades) }, symbols: {}, config, playbook: { reviews, images: [] } }, today);
}

const view = (o: Partial<Omit<ViewState, "filter">> & { filter?: Partial<TradeFilter> } = {}): ViewState => ({
  ...defaultView(), ...o, filter: { ...emptyFilter(), ...o.filter },
});

/** Give trades a shared idea. */
const sameIdea = (ts: Trade[]) => ts.map((t) => ({ ...t, ideaId: ts[0]!.id }));
const withFees = (t: Trade, fees: number): Trade => {
  const net = Math.round((t.grossPnl - fees) * 100) / 100;
  return { ...t, fees, netPnl: net, realizedPnl: net, result: net > 0 ? "win" : net < 0 ? "loss" : "breakeven" };
};

// ---------------------------------------------------------------- URL state

describe("view state in the URL", () => {
  it("round-trips every filter field, leaving defaults out", () => {
    const v = view({
      filter: {
        symbols: ["ZZB"], tags: ["Reviewed", "ETF"], tagMode: "all", style: "swing", instrument: "leveraged_etf", broker: "schwab",
        duration: "multiday", results: ["win", "breakeven"], review: "no", preset: null, from: "2025-04-01", to: "2025-04-07", flag: "overnight",
      },
      pnl: "gross", count: "idea", sort: { key: "pnl", dir: "asc" }, page: 3,
    });
    const q = queryOf(viewToParams(v));
    expect(q).toBe(
      "?symbol=ZZB&tags=Reviewed,ETF&tagmode=all&style=swing&instrument=leveraged_etf&broker=schwab&duration=multiday&result=win,breakeven&review=no&from=2025-04-01&to=2025-04-07&flag=overnight&pnl=gross&count=idea&sort=pnl&page=3",
    );
    expect(parseView(new URLSearchParams(q.slice(1)))).toEqual(v);
    expect(queryOf(viewToParams(defaultView()))).toBe("");
  });

  it("treats date= (week strip, calendar) as a one-day range, and ignores junk", () => {
    const v = parseView(new URLSearchParams("date=2025-04-02&style=nope&sort=-bogus&page=-4&symbol=zzb,zzc"));
    expect(v.filter).toMatchObject({ from: "2025-04-02", to: "2025-04-02", style: null, symbols: ["ZZB", "ZZC"] });
    expect(v.sort).toEqual(defaultView().sort);
    expect(v.page).toBe(1);
    expect(viewToParams(v).toString()).toBe("symbol=ZZB%2CZZC&date=2025-04-02");
  });

  it("resolves date presets relative to today (ET), weeks starting Monday", () => {
    const f = (preset: TradeFilter["preset"]) => dateRange({ ...emptyFilter(), preset }, "2025-04-10");
    expect(f("today")).toEqual({ from: "2025-04-10", to: "2025-04-10" });
    expect(f("week")).toEqual({ from: "2025-04-07", to: "2025-04-13" });
    expect(f("lastweek")).toEqual({ from: "2025-03-31", to: "2025-04-06" });
    expect(f("month")).toEqual({ from: "2025-04-01", to: "2025-04-30" });
    expect(f("lastmonth")).toEqual({ from: "2025-03-01", to: "2025-03-31" });
    expect(f("30d")).toEqual({ from: "2025-03-12", to: "2025-04-10" });
    expect(f("ytd")).toEqual({ from: "2025-01-01", to: "2025-04-10" });
    expect(dateRange({ ...emptyFilter(), preset: "lastmonth" }, "2025-01-15")).toEqual({ from: "2024-12-01", to: "2024-12-31" });
  });
});

// ---------------------------------------------------------------- filter

describe("filter", () => {
  const stock = closed({ symbol: "ZZB", closedAt: "2025-04-01T10:00:00-04:00", net: 1 });
  const etf = closed({ symbol: "ZZBU", underlying: "ZZB", closedAt: "2025-04-01T11:00:00-04:00", net: -1 });
  const other = closed({ symbol: "ZZC", closedAt: "2025-04-02T10:00:00-04:00", net: 0 });
  const swing = closed({ style: "swing", symbol: "ZZD", openedAt: "2025-03-28T00:00:00-04:00", closedAt: "2025-04-02T00:00:00-04:00", net: 2 });
  const sameDaySwing = closed({ style: "swing", symbol: "ZZE", openedAt: "2025-04-03T00:00:00-04:00", closedAt: "2025-04-03T00:00:00-04:00", net: -2 });
  const openNow = open({ symbol: "ZZF", openedAt: "2025-04-10T00:00:00-04:00" });
  const openOld = open({ symbol: "ZZG", openedAt: "2025-04-01T00:00:00-04:00" });
  const all = [stock, etf, other, swing, sameDaySwing, openNow, openOld];
  const reviews = [{ path: "Reviews/2025-04-02-ZZD.md", markdown: "**Date:** 2025-03-28\n**Ticker:** ZZD\n\n## Category\n\nSwing trade\n" }];
  const j = journal(all, reviews);
  const ids = (f: Partial<TradeFilter>) => filterTrades(j, { ...emptyFilter(), ...f }).map((t) => t.symbol);

  it("matches the symbol OR the underlying, so the stock's ticker finds its ETF trades", () => {
    expect(ids({ symbols: ["ZZB"] })).toEqual(["ZZB", "ZZBU"]);
    expect(ids({ symbols: ["ZZBU"] })).toEqual(["ZZBU"]);
    expect(ids({ symbols: ["zzc", "ZZD"] })).toEqual(["ZZC", "ZZD"]);
  });

  it("filters by duration: same ET date vs multi-day, by hold fact not style", () => {
    expect(ids({ duration: "intraday" })).toEqual(["ZZB", "ZZBU", "ZZC", "ZZE", "ZZF"]);
    expect(ids({ duration: "multiday" })).toEqual(["ZZD", "ZZG"]);
  });

  it("filters by has-review through the idea join", () => {
    expect(ids({ review: "yes" })).toEqual(["ZZD"]);
    expect(ids({ review: "no" })).not.toContain("ZZD");
  });

  it("filters by ET date range on the close date (open date while open)", () => {
    // 2025-04-02 01:30 UTC is still 04-01 in New York.
    const late = closed({ symbol: "ZZH", closedAt: "2025-04-02T01:30:00Z", net: 1 });
    const j2 = journal([late, other]);
    const on = (d: string) => filterTrades(j2, { ...emptyFilter(), from: d, to: d }).map((t) => t.symbol);
    expect(on("2025-04-01")).toEqual(["ZZH"]);
    expect(on("2025-04-02")).toEqual(["ZZC"]);
    expect(ids({ from: "2025-04-03" })).toEqual(["ZZE", "ZZF"]);
    expect(ids({ to: "2025-04-01" })).toEqual(["ZZB", "ZZBU", "ZZG"]);
  });

  it("filters by style, instrument, broker, result and tags (any / all)", () => {
    expect(ids({ style: "swing" })).toEqual(["ZZD", "ZZE", "ZZF", "ZZG"]);
    expect(ids({ instrument: "leveraged_etf" })).toEqual(["ZZBU"]);
    expect(ids({ broker: "webull" })).toEqual(["ZZB", "ZZBU", "ZZC"]);
    expect(ids({ results: ["breakeven"] })).toEqual(["ZZC"]);
    expect(ids({ results: ["win", "loss"] })).toEqual(["ZZB", "ZZBU", "ZZD", "ZZE"]);
    expect(ids({ tags: ["etf", "Reviewed"] })).toEqual(["ZZBU", "ZZD"]);
    expect(ids({ tags: ["Swing", "Reviewed"], tagMode: "all" })).toEqual(["ZZD"]);
    expect(ids({ tags: ["Swing trade"] })).toEqual(["ZZD"]); // review Category is an automatic tag
  });

  it("supports the dashboard's overnight flag", () => {
    const held = closed({ symbol: "ZZI", openedAt: "2025-04-01T15:50:00-04:00", closedAt: "2025-04-02T09:40:00-04:00", net: 1 });
    const j2 = journal([held, stock]);
    const m = tradeMatcher({ ...emptyFilter(), flag: "overnight" }, { today: TODAY, tagsOf: () => [], reviewed: () => false, overnight: j2.overnight });
    expect([held, stock].filter(m).map((t) => t.symbol)).toEqual(["ZZI"]);
  });
});

// ---------------------------------------------------------------- gross / net, trade / idea

describe("Gross vs Net and Trade vs Idea counting", () => {
  // One idea of two trades (+3 gross / −1 gross, $0.50 fees each) and one single-trade idea.
  const [a, b] = sameIdea([
    withFees(closed({ symbol: "ZZB", closedAt: "2025-04-01T10:00:00-04:00", net: 3 }), 0.5),
    withFees(closed({ symbol: "ZZB", closedAt: "2025-04-01T11:00:00-04:00", net: -1 }), 0.5),
  ]) as [Trade, Trade];
  const c = withFees(closed({ symbol: "ZZC", closedAt: "2025-04-01T12:00:00-04:00", net: 0.4 }), 0.5);
  const j = journal([a, b, c]);

  it("sums gross or net P&L", () => {
    const rows = buildRows(j.trades, j, "trade");
    expect(summarizeRows(rows, "gross").pnl).toBe(2.4);
    expect(summarizeRows(rows, "net").pnl).toBe(0.9);
  });

  it("scores results on net P&L in both modes (Q2): a gross winner can be a net loss", () => {
    const rows = buildRows(j.trades, j, "trade");
    const s = summarizeRows(rows, "gross");
    expect(c.grossPnl).toBeGreaterThan(0);
    expect(rows.find((r) => r.id === c.id)!.result).toBe("loss");
    expect([s.wins, s.losses]).toEqual([1, 2]);
  });

  it("counts trades or ideas", () => {
    const byTrade = summarizeRows(buildRows(j.trades, j, "trade"), "net");
    const byIdea = summarizeRows(buildRows(j.trades, j, "idea"), "net");
    expect([byTrade.rows, byTrade.trades, byTrade.wins, byTrade.losses]).toEqual([3, 3, 1, 2]);
    // The ZZB idea nets +2.50 − 1.50 = +1.00 → one winning idea; ZZC loses.
    expect([byIdea.rows, byIdea.trades, byIdea.wins, byIdea.losses]).toEqual([2, 3, 1, 1]);
    expect(byIdea.pnl).toBe(byTrade.pnl);
  });

  it("builds idea rows from the trades that pass the filter, oldest first", () => {
    const rows = buildRows(j.trades, j, "idea");
    const zzb = rows.find((r) => r.symbol === "ZZB")!;
    expect(zzb.trades.map((t) => t.id)).toEqual([a.id, b.id]);
    expect([zzb.gross, zzb.net, zzb.executions]).toEqual([2, 1, 2]);
    const winnersOnly = viewRows(j, view({ count: "idea", filter: { results: ["win"] } }));
    expect(winnersOnly.map((r) => r.trades.length)).toEqual([1]);
  });
});

// ---------------------------------------------------------------- sort, pagination, prev/next

describe("sorting", () => {
  // Three Schwab-style trades closing at the same instant, plus two with distinct times.
  const day = "2025-04-01T00:00:00-04:00";
  const ts = [
    closed({ style: "swing", symbol: "ZZA", openedAt: day, closedAt: day, net: 1 }),
    closed({ style: "swing", symbol: "ZZB", openedAt: day, closedAt: day, net: 1 }),
    closed({ style: "swing", symbol: "ZZC", openedAt: day, closedAt: day, net: 1 }),
    closed({ symbol: "ZZD", closedAt: "2025-04-02T10:00:00-04:00", net: 1 }),
    closed({ symbol: "ZZE", closedAt: "2025-03-31T10:00:00-04:00", net: -5 }),
  ];
  const j = journal(ts);
  const syms = (v: ViewState) => viewRows(j, v).map((r) => r.symbol);

  it("defaults to newest first; same-instant rows put the later derived trade first", () => {
    expect(syms(view())).toEqual(["ZZD", "ZZC", "ZZB", "ZZA", "ZZE"]);
  });

  it("mirrors exactly when the date sort is reversed", () => {
    expect(syms(view({ sort: { key: "date", dir: "asc" } }))).toEqual(["ZZE", "ZZA", "ZZB", "ZZC", "ZZD"]);
  });

  it("is stable: equal keys keep the default order in both directions", () => {
    expect(syms(view({ sort: { key: "pnl", dir: "desc" } }))).toEqual(["ZZD", "ZZC", "ZZB", "ZZA", "ZZE"]);
    expect(syms(view({ sort: { key: "pnl", dir: "asc" } }))).toEqual(["ZZE", "ZZD", "ZZC", "ZZB", "ZZA"]);
    expect(syms(view({ sort: { key: "style", dir: "asc" } }))).toEqual(["ZZD", "ZZE", "ZZC", "ZZB", "ZZA"]);
    const rows = buildRows(ts, j, "trade");
    const twice = sortRows(sortRows(rows, { key: "executions", dir: "asc" }, "net"), { key: "executions", dir: "asc" }, "net");
    expect(twice.map((r) => r.id)).toEqual(rows.map((r) => r.id));
  });

  it("sorts empty notes and tags last in both directions", () => {
    const noted = { ...ts[4]!, note: "zz note" };
    const j2 = journal([...ts.slice(0, 4), noted]);
    const order = (dir: "asc" | "desc") => sortRows(buildRows(j2.trades, j2, "trade"), { key: "notes", dir }, "net").map((r) => r.symbol);
    expect(order("asc")[0]).toBe("ZZE");
    expect(order("desc")[0]).toBe("ZZE");
  });

  it("paginates at 50 and finds a trade's page", () => {
    const many = Array.from({ length: 120 }, (_, i) => closed({ symbol: "ZZP", closedAt: `2025-04-01T10:${String(i % 60).padStart(2, "0")}:00-04:00`, openedAt: `2025-04-01T09:00:00-04:00`, net: i }));
    const jm = journal(many);
    const rows = viewRows(jm, view());
    expect(paginate(rows, 3).items).toHaveLength(20);
    expect(paginate(rows, 9).page).toBe(3);
    expect(pageOf(rows, rows[75]!.id)).toBe(2);
  });
});

describe("previous / next under a filter", () => {
  const ts = [
    closed({ symbol: "ZZA", closedAt: "2025-04-01T10:00:00-04:00", net: 1 }),
    closed({ symbol: "ZZB", closedAt: "2025-04-01T11:00:00-04:00", net: -1 }),
    closed({ symbol: "ZZA", closedAt: "2025-04-01T12:00:00-04:00", net: 2 }),
    closed({ symbol: "ZZB", closedAt: "2025-04-01T13:00:00-04:00", net: 3 }),
    closed({ symbol: "ZZA", closedAt: "2025-04-01T14:00:00-04:00", net: -2 }),
  ];
  const [a1, , a2, , a3] = ts as [Trade, Trade, Trade, Trade, Trade];
  const j = journal(ts);

  it("steps only through trades that pass the filter, in table order", () => {
    const order = tradeOrder(viewRows(j, view({ filter: { symbols: ["ZZA"] } })));
    expect(order).toEqual([a3.id, a2.id, a1.id]);
    expect(neighbors(order, a2.id)).toEqual({ prev: a3.id, next: a1.id, index: 1, total: 3 });
    expect(neighbors(order, a3.id).prev).toBeNull();
    expect(neighbors(order, a1.id).next).toBeNull();
  });

  it("follows the sort", () => {
    const order = tradeOrder(viewRows(j, view({ filter: { symbols: ["ZZA"] }, sort: { key: "pnl", dir: "desc" } })));
    expect(order).toEqual([a2.id, a1.id, a3.id]);
  });

  it("walks an idea's trades oldest first in the Idea view", () => {
    const grouped = journal(sameIdea(ts));
    expect(tradeOrder(viewRows(grouped, view({ count: "idea" })))).toEqual(ts.map((t) => t.id));
  });

  it("reports a trade outside the filter as not found", () => {
    const order = tradeOrder(viewRows(j, view({ filter: { symbols: ["ZZA"] } })));
    expect(neighbors(order, ts[1]!.id)).toEqual({ prev: null, next: null, index: -1, total: 3 });
  });
});

// ---------------------------------------------------------------- calendar

describe("calendar", () => {
  it("buckets by ET date and totals Mon–Sun weeks across the spring DST switch", () => {
    // DST starts Sun 2025-03-09. 23:30 ET on Mar 8 (EST) is 04:30Z on Mar 9; 23:30 ET on Mar 9 (EDT) is 03:30Z on Mar 10.
    const ts = [
      closed({ style: "swing", symbol: "ZZA", closedAt: "2025-03-09T04:30:00Z", net: 1 }),
      closed({ style: "swing", symbol: "ZZB", closedAt: "2025-03-10T03:30:00Z", net: 2 }),
      closed({ symbol: "ZZC", closedAt: "2025-03-10T09:30:00-04:00", net: -4 }),
      closed({ symbol: "ZZD", closedAt: "2025-03-31T15:00:00-04:00", net: 8 }),
    ];
    const days = dailyTotals(ts, "net");
    expect(days.get("2025-03-08")?.pnl).toBe(1);
    expect(days.get("2025-03-09")?.pnl).toBe(2);
    expect(days.get("2025-03-10")?.pnl).toBe(-4);

    const { weeks, total } = monthGrid(ts, "2025-03", { pnl: "net", reviewDates: new Set(["2025-03-10"]) });
    expect(weeks.map((w) => w.start)).toEqual(["2025-02-24", "2025-03-03", "2025-03-10", "2025-03-17", "2025-03-24", "2025-03-31"]);
    expect(weeks[1]).toMatchObject({ pnl: 3, trades: 2 }); // Mon 03-03 … Sun 03-09
    expect(weeks[2]).toMatchObject({ pnl: -4, trades: 1 });
    expect(weeks[2]!.days[0]).toMatchObject({ date: "2025-03-10", review: true, inMonth: true });
    expect(weeks[5]!.days.map((d) => d.inMonth)).toEqual([true, false, false, false, false, false, false]);
    expect(total).toEqual({ pnl: 7, trades: 4, ideas: 4 });
  });

  it("keeps the fall-back day (25 hours) as one ET date", () => {
    // DST ends Sun 2025-11-02 at 02:00 EDT → 01:00 EST. 00:30 EDT and 23:30 EST are both Nov 2.
    const ts = [
      closed({ style: "swing", symbol: "ZZA", closedAt: "2025-11-02T04:30:00Z", net: 1 }),
      closed({ style: "swing", symbol: "ZZB", closedAt: "2025-11-03T04:30:00Z", net: 2 }),
      closed({ symbol: "ZZC", closedAt: "2025-11-03T05:30:00Z", net: 4 }),
    ];
    const days = dailyTotals(ts, "net");
    expect(days.get("2025-11-02")).toEqual({ pnl: 3, trades: 2, ideas: 2 });
    expect(days.get("2025-11-03")).toEqual({ pnl: 4, trades: 1, ideas: 1 });
    const w = monthGrid(ts, "2025-11", { pnl: "net" }).weeks.find((x) => x.start === "2025-10-27")!;
    expect(w).toMatchObject({ pnl: 3, trades: 2 }); // Nov 2 is the Sunday of that Mon–Sun week
  });

  it("uses gross or net P&L, counts ideas once per day and week, and skips unscored trades", () => {
    const [a, b] = sameIdea([
      withFees(closed({ symbol: "ZZA", closedAt: "2025-04-01T10:00:00-04:00", net: 2 }), 0.5),
      withFees(closed({ symbol: "ZZA", closedAt: "2025-04-02T10:00:00-04:00", net: 2 }), 0.5),
    ]) as [Trade, Trade];
    const excluded = { ...closed({ symbol: "ZZX", closedAt: "2025-04-01T11:00:00-04:00", net: 9 }), excluded: true };
    const ts = [a, b, excluded, open({ symbol: "ZZO", openedAt: "2025-04-01T00:00:00-04:00" })];
    expect(dailyTotals(ts, "gross").get("2025-04-01")).toEqual({ pnl: 2, trades: 1, ideas: 1 });
    expect(dailyTotals(ts, "net").get("2025-04-01")).toEqual({ pnl: 1.5, trades: 1, ideas: 1 });
    const wk = monthGrid(ts, "2025-04", { pnl: "net" }).weeks[0]!;
    expect([wk.trades, wk.ideas]).toEqual([2, 1]);
  });

  it("lays out a year of months aligned to the week start", () => {
    const y = yearView([closed({ symbol: "ZZA", closedAt: "2025-02-03T10:00:00-05:00", net: 1 })], 2025, { pnl: "net" });
    expect(y).toHaveLength(12);
    expect(y[1]).toMatchObject({ month: "2025-02", lead: 5, pnl: 1, trades: 1, green: 1, red: 0 }); // Feb 1 2025 is a Saturday
    expect(y[1]!.days).toHaveLength(28);
    expect(yearView([], 2025, { pnl: "net", startsOn: "sunday" })[1]!.lead).toBe(6);
  });
});

// ---------------------------------------------------------------- tags & attention

describe("tags and review checks", () => {
  it("merges automatic tags (style, ETF, Reviewed, Category) with manual tags", () => {
    const t = { ...closed({ symbol: "ZZBU", underlying: "ZZB", closedAt: "2025-04-01T10:00:00-04:00", net: 1 }), tags: ["imbalance", "etf"] };
    const j = journal([t], [{ path: "Reviews/2025-04-01-ZZB.md", markdown: "**Date:** 2025-04-01\n**Ticker:** ZZB\n\n## Category\n\nBreaking news\n" }]);
    expect(j.tags.get(t.id)).toEqual({ auto: ["Day", "ETF", "Reviewed", "Breaking news"], manual: ["imbalance"], all: ["Day", "ETF", "Reviewed", "Breaking news", "imbalance"] });
    expect(j.allTags).toEqual(["Breaking news", "Day", "ETF", "Reviewed", "imbalance"]);
  });

  it("flags OPEN swing reviews whose idea has closed, unmatched reviews and duplicate reviews", () => {
    const fixtures = JSON.parse(readFileSync(join(FIXTURES, "expected", "trades.json"), "utf8")) as DerivedTrades;
    const dir = join(FIXTURES, "playbook", "Reviews");
    const names = ["2025-03-14-SDAY.md", "2025-03-14-OPSW.md", "2025-03-18-NOPE.md", "2025-03-10-ZZTA.md", "2025-03-10-ZZTA-2.md"];
    const reviews = names.map((n) => ({ path: `Reviews/${n}`, markdown: readFileSync(join(dir, n), "utf8") }));
    const j = buildJournal({ derived: fixtures, symbols, config, playbook: { reviews, images: [] } }, "2025-03-20");
    const a = reviewAttention(j);
    expect(a.openButClosed.map((r) => r.id)).toEqual(["2025-03-14-SDAY"]); // OPSW is still open
    expect(a.unmatched.map((r) => r.id)).toEqual(["2025-03-18-NOPE"]);
    expect(a.multiple.map((m) => m.reviews.length)).toEqual([2]);
  });
});

describe("journal list filter", () => {
  const fixtures = JSON.parse(readFileSync(join(FIXTURES, "expected", "trades.json"), "utf8")) as DerivedTrades;
  const dir = join(FIXTURES, "playbook", "Reviews");
  const names = ["2025-03-13-FAKU.md", "2025-03-12-FAKU.md", "2025-03-18-NOPE.md", "2025-03-10-ZZTA.md"];
  const reviews = names.map((n) => ({ path: `Reviews/${n}`, markdown: readFileSync(join(dir, n), "utf8") }));
  const j = buildJournal({ derived: fixtures, symbols, config, playbook: { reviews, images: [] } }, "2025-03-20");
  const ids = (f: Partial<TradeFilter>) => filterReviews(j, { ...emptyFilter(), ...f }).map((r) => r.id);

  it("shows a review when any trade in its idea passes; unmatched reviews only for symbol/date filters", () => {
    expect(ids({})).toEqual(["2025-03-18-NOPE", "2025-03-13-FAKU", "2025-03-12-FAKU", "2025-03-10-ZZTA"]);
    expect(ids({ symbols: ["FAKE"] })).toEqual(["2025-03-13-FAKU", "2025-03-12-FAKU"]);
    expect(ids({ style: "swing" })).toEqual(["2025-03-13-FAKU"]);
    expect(ids({ instrument: "stock", symbols: ["FAKE"] })).toEqual(["2025-03-12-FAKU"]); // the day idea also traded the stock
    expect(ids({ symbols: ["NOPE"] })).toEqual(["2025-03-18-NOPE"]);
    expect(ids({ from: "2025-03-18", to: "2025-03-18" })).toEqual(["2025-03-18-NOPE"]);
    expect(ids({ results: ["win"], symbols: ["NOPE"] })).toEqual([]);
  });
});

// ---------------------------------------------------------------- bulk overrides

describe("bulk overrides (preview only until milestone 5)", () => {
  const fills = JSON.parse(readFileSync(join(FIXTURES, "expected", "fills-2025.json"), "utf8")) as { fills: Fill[] };
  const derived = JSON.parse(readFileSync(join(FIXTURES, "expected", "trades.json"), "utf8")) as DerivedTrades;
  const byId = (id: string) => derived.trades.find((t) => t.id === id)!;
  const zzta = byId("wb-4fa89f0bc78f");
  const swing = byId("sc-fced7b6d3790");

  it("adds and removes tags case-insensitively, keeping other fields", () => {
    let ov = noOverrides();
    ov.trades[zzta.id] = { note: "keep me" };
    ov = applyBulkAction(ov, [zzta, swing], { kind: "addTag", tag: " imbalance " }, config);
    ov = applyBulkAction(ov, [zzta], { kind: "addTag", tag: "IMBALANCE" }, config);
    expect(ov.trades).toEqual({ [zzta.id]: { note: "keep me", tags: ["imbalance"] }, [swing.id]: { tags: ["imbalance"] } });
    ov = applyBulkAction(ov, [zzta, swing], { kind: "removeTag", tag: "Imbalance" }, config);
    expect(ov.trades).toEqual({ [zzta.id]: { note: "keep me" } });
  });

  it("drops a style override that matches the account default, and toggles exclude", () => {
    let ov = applyBulkAction(noOverrides(), [zzta], { kind: "setStyle", style: "swing" }, config);
    expect(ov.trades[zzta.id]).toEqual({ style: "swing" });
    ov = applyBulkAction(ov, [zzta], { kind: "setStyle", style: "day" }, config);
    expect(ov.trades).toEqual({});
    ov = applyBulkAction(ov, [zzta], { kind: "exclude", exclude: true }, config);
    expect(ov.trades[zzta.id]).toEqual({ exclude: true });
    expect(changedOverrideIds(noOverrides(), ov)).toEqual([zzta.id]);
    expect(applyBulkAction(ov, [zzta], { kind: "exclude", exclude: false }, config).trades).toEqual({});
  });

  it("never mutates its input", () => {
    const ov = noOverrides();
    applyBulkAction(ov, [zzta], { kind: "addTag", tag: "x" }, config);
    expect(ov).toEqual(noOverrides());
  });

  it("previews the re-derived result, including ideas a style change regroups", () => {
    const ctx = { config, symbols };
    const tagged = applyBulkAction(noOverrides(), [zzta], { kind: "addTag", tag: "x" }, config);
    expect(previewOverrides(fills.fills, ctx, noOverrides(), tagged)).toMatchObject({ entries: 1, trades: 1, ideasChanged: 0 });
    // ZZTA's two day trades form one idea; making the first one a swing splits it.
    const restyled = applyBulkAction(noOverrides(), [zzta], { kind: "setStyle", style: "swing" }, config);
    const p = previewOverrides(fills.fills, ctx, noOverrides(), restyled);
    expect(p.trades).toBeGreaterThanOrEqual(1);
    expect(p.ideasAfter).toBe(p.ideasBefore + 1);
    expect(p.ideasChanged).toBeGreaterThan(0);
  });
});

describe("journal list order (#22)", () => {
  it("puts a review whose exit is missing (OPEN review, closed idea) first, the rest as given", () => {
    const fixtures = JSON.parse(readFileSync(join(FIXTURES, "expected", "trades.json"), "utf8")) as DerivedTrades;
    const dir = join(FIXTURES, "playbook", "Reviews");
    const names = ["2025-03-14-OPSW.md", "2025-03-10-ZZTA.md", "2025-03-14-SDAY.md"];
    const reviews = names.map((n) => ({ path: `Reviews/${n}`, markdown: readFileSync(join(dir, n), "utf8") }));
    const j = buildJournal({ derived: fixtures, symbols, config, playbook: { reviews, images: [] } }, "2025-03-20");
    const list = j.reviews.reviews.filter((r) => names.includes(`${r.id}.md`));
    expect(list.filter((r) => exitMissing(j, r)).map((r) => r.id)).toEqual(["2025-03-14-SDAY"]);
    const ordered = journalOrder(j, list).map((r) => r.id);
    expect(ordered[0]).toBe("2025-03-14-SDAY");
    expect(ordered.slice(1)).toEqual(list.map((r) => r.id).filter((id) => id !== "2025-03-14-SDAY"));
  });
});
