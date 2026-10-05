// The public demo's synthetic data generator (#8, Q49).
import { describe, expect, it } from "vitest";
import { validate } from "../cli/lib/history";
import { addDays } from "../src/core/calendar";
import { computeGauges } from "../src/core/gauge/gauge";
import { dailyTotals } from "../src/core/journal/calendar-view";
import { buildJournal, reviewAttention } from "../src/core/journal/journal";
import { etDate } from "../src/core/normalize/util";
import { resolvePlaybookPath } from "../src/core/reviews/images";
import { joinReviews, readReviews } from "../src/core/reviews/join";
import { heldOvernightDayTrades } from "../src/core/trades/stats";
import { DEMO_SEED, generateDemo } from "../src/demo/generate";
import { ALL_DEMO_SYMBOLS } from "../src/demo/tickers";

// A Wednesday afternoon in the session, a Monday before the open, and a Sunday.
const NOWS = ["2026-10-07T18:30:00Z", "2026-10-05T12:00:00Z", "2026-10-04T16:00:00Z"];

describe.each(NOWS)("demo data as of %s", (now) => {
  const { bundle, images } = generateDemo(now);
  const trades = bundle.derived.trades;

  it("is the same for the same seed and time", () => {
    expect(generateDemo(now)).toEqual({ bundle, images });
    expect(DEMO_SEED).toBe(20261004);
  });

  it("has nothing dated after now", () => {
    const t = Date.parse(now);
    for (const f of bundle.fills) expect(Date.parse(f.executedAt)).toBeLessThanOrEqual(t);
    for (const x of trades) expect(Date.parse(x.closedAt ?? x.openedAt)).toBeLessThanOrEqual(t);
    for (const q of Object.values(bundle.quotes!.quotes)) expect(Date.parse(q.time)).toBeLessThanOrEqual(t);
    expect(Date.parse(bundle.quotes!.asOf)).toBeLessThanOrEqual(t);
    for (const r of bundle.playbook!.reviews) expect(r.path.slice(8, 18) <= etDate(now)).toBe(true);
  });

  it("validates against the trade-history schemas", () => {
    validate("config", bundle.config, "config");
    validate("symbols", bundle.symbols, "symbols");
    validate("overrides", bundle.overrides, "overrides");
    validate("fills", { schemaVersion: 1, fills: bundle.fills }, "fills");
    validate("trades", bundle.derived, "trades");
  });

  it("is about six months of day and swing trading with 6–8 open positions", () => {
    const closed = (style: string) => trades.filter((t) => t.style === style && t.status === "closed");
    expect(closed("day").length).toBeGreaterThan(200);
    expect(closed("swing").length).toBeGreaterThanOrEqual(40);
    const open = trades.filter((t) => t.status === "open");
    expect(open.length).toBeGreaterThanOrEqual(6);
    expect(open.length).toBeLessThanOrEqual(8);
    expect(trades.filter((t) => t.status === "unmatched")).toEqual([]);
    const rate = (s: string) => {
      const c = closed(s);
      return c.filter((t) => t.result === "win").length / c.filter((t) => t.result !== "breakeven").length;
    };
    expect(rate("day")).toBeGreaterThan(0.5);
    expect(rate("day")).toBeLessThan(0.65);
    expect(rate("swing")).toBeGreaterThan(0.35);
    expect(rate("swing")).toBeLessThan(0.55);
    expect(closed("day").concat(closed("swing")).reduce((s, t) => s + t.netPnl, 0)).toBeGreaterThan(0);
  });

  it("uses fake tickers only, with a 2x ETF on two underlyings, an inverse ETF and a mixed stock/ETF idea", () => {
    for (const s of new Set(trades.map((t) => t.symbol))) expect(ALL_DEMO_SYMBOLS).toContain(s);
    expect(Object.values(bundle.symbols).filter((s) => s.leverage === 2 && s.direction === "long").length).toBeGreaterThanOrEqual(2);
    expect(Object.values(bundle.symbols).some((s) => s.direction === "inverse")).toBe(true);
    expect(bundle.derived.ideas.some((i) => i.usedEtf && i.symbolsTraded.length > 1)).toBe(true);
  });

  it("shows the scripted gauges: Day below average, Swing at full size", () => {
    const g = computeGauges({ trades, config: bundle.config, now, quotes: bundle.quotes!.quotes });
    expect(["half", "quarter"]).toContain(g.day.state);
    expect(g.swing.state).toBe("full");
    expect(Object.values(bundle.quotes!.quotes).filter((q) => q.stale)).toHaveLength(1);
  });

  it("has the overrides: tags, notes, one exclusion, one style change, one day trade held overnight", () => {
    const ov = Object.values(bundle.overrides.trades);
    expect(new Set(ov.flatMap((o) => o.tags ?? [])).size).toBeGreaterThanOrEqual(5);
    expect(ov.filter((o) => o.note).length).toBeGreaterThanOrEqual(2);
    expect(trades.filter((t) => t.excluded)).toHaveLength(1);
    expect(ov.filter((o) => o.style)).toHaveLength(1);
    expect(heldOvernightDayTrades(trades, etDate(now)).length).toBeGreaterThanOrEqual(1);
  });

  it("joins every review to an idea, and every chart path resolves", () => {
    const reviews = readReviews(bundle.playbook!.reviews, bundle.symbols);
    expect(reviews.length).toBeGreaterThanOrEqual(8);
    expect(reviews.length).toBeLessThanOrEqual(10);
    const join = joinReviews(reviews, bundle.derived);
    expect(join.ideaOf.size).toBe(reviews.length);
    expect([...join.method.values()].every((m) => m === "idea-id")).toBe(true);
    const status = reviews.map((r) => r.header.status);
    expect(status).toContain("open");
    expect(status).toContain("closed");
    const j = buildJournal(bundle, etDate(now));
    expect(reviewAttention(j).openButClosed).toHaveLength(1);
    expect(reviewAttention(j).unmatched).toEqual([]);
    for (const r of bundle.playbook!.reviews) {
      for (const m of r.markdown.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) {
        const p = resolvePlaybookPath(r.path, m[1]!);
        expect(p && images[p]).toMatch(/^data:image\/svg\+xml/);
      }
    }
    expect(bundle.playbook!.images.every((p) => images[p])).toBe(true);
  });

  it("fills the calendar for most weekdays", () => {
    expect(dailyTotals(trades, "net").size).toBeGreaterThan(100);
  });
});

describe("demo dates", () => {
  it("a week later is the same history shifted by a week", () => {
    const a = generateDemo("2026-10-07T18:30:00Z").bundle.derived.trades;
    const b = generateDemo("2026-10-14T18:30:00Z").bundle.derived.trades;
    const key = (t: (typeof a)[number], shift: number) => `${t.symbol} ${addDays(etDate(t.openedAt), shift)} ${t.netPnl} ${t.status}`;
    expect(b.map((t) => key(t, 0))).toEqual(a.map((t) => key(t, 7)));
  });

  it("is fast enough to run in the browser at load", () => {
    generateDemo("2026-10-08T15:00:00Z");
    const t0 = performance.now();
    generateDemo("2026-10-09T15:00:00Z");
    expect(performance.now() - t0).toBeLessThan(1000); // ~100 ms on a laptop; CI runners are slower
  });
});
