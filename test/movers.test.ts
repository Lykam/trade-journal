import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MoversPage } from "../src/app/pages/MoversPage";
import type { DataBundle } from "../src/core/types";
import { lastCompleteFriday } from "../build/fetch-movers";
import { computeMovers, filterMovers, moverRows, moversCsv, moversFile, NO_FILTER, parseMoversFile, type Bar, type Day, type Split } from "../src/core/movers/movers";
import { demoMovers } from "../src/demo/movers";

const bar = (c: number, v = 20e6, extra: Partial<Bar> = {}): Bar => ({ o: c, h: c, l: c, c, v, ...extra });
const day = (date: string, bars: Record<string, Bar>): Day => ({ date, bars: new Map(Object.entries(bars)) });
const all = () => true;

// Fri 2026-11-06 is the base; the week of Mon 2026-11-09 is measured.
const WEEK = ["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13"];
function weekOf(prev: Record<string, Bar>, each: (i: number) => Record<string, Bar>): Day[] {
  return [day("2026-11-06", prev), ...WEEK.map((d, i) => day(d, each(i)))];
}

describe("computeMovers", () => {
  it("finds 50%+ moves either way on the close, measured from the prior week's close", () => {
    const days = weekOf({ UP: bar(10), DN: bar(20), FLAT: bar(10) }, (i) => ({
      UP: bar(10 + (i + 1) * 1.5),
      DN: bar(20 - (i + 1) * 2.2),
      FLAT: bar(10.5),
    }));
    const [w] = computeMovers(days, [], all);
    expect(w!.week).toBe("2026-11-09");
    expect(w!.end).toBe("2026-11-13");
    expect(w!.movers.map((m) => [m.ticker, m.dir, m.basis, m.chg])).toEqual([
      ["UP", "up", "close", 75],
      ["DN", "down", "close", -55],
    ]);
  });

  it("flags a move that only the week's high reached as intraweek", () => {
    const days = weekOf({ FADE: bar(10) }, (i) => ({ FADE: i === 1 ? bar(14, 20e6, { h: 16.2 }) : bar(12) }));
    const m = computeMovers(days, [], all)[0]!.movers[0]!;
    expect([m.dir, m.basis, m.chg, m.hi]).toEqual(["up", "intraweek", 20, 62]);
  });

  it("adjusts for a split inside the week so it isn't a fake move", () => {
    // 1-for-10 reverse split on Wednesday: $1 becomes $10, then it drifts to $11.
    const days = weekOf({ RS: bar(1, 300e6) }, (i) => ({ RS: i < 2 ? bar(1, 300e6) : bar(i === 4 ? 11 : 10, 30e6) }));
    const splits: Split[] = [{ ticker: "RS", date: "2026-11-11", from: 10, to: 1 }];
    expect(computeMovers(days, splits, all)[0]!.movers).toEqual([]);
    // Without the split it would look like +1000%.
    expect(computeMovers(days, [], all)[0]!.movers[0]!.chg).toBe(1000);
  });

  it("needs a price over $5 at the start or the end", () => {
    const days = weekOf({ CHEAP: bar(2, 100e6), CRASH: bar(12) }, () => ({ CHEAP: bar(4, 100e6), CRASH: bar(4, 60e6) }));
    expect(computeMovers(days, [], all)[0]!.movers.map((m) => m.ticker)).toEqual(["CRASH"]);
  });

  it("needs $100M average daily dollar volume over the week or the trailing 30 days", () => {
    // THIN trades $50M a day; BURST trades $50M but one $400M day ($110M avg); vw is used when present.
    const days = weekOf({ THIN: bar(10, 5e6), BURST: bar(10, 5e6) }, (i) => ({
      THIN: bar(16, 5e6 / 1.6),
      BURST: bar(16, i === 2 ? 25e6 : 3.125e6, { vw: 16 }),
    }));
    const [w] = computeMovers(days, [], all);
    expect(w!.movers.map((m) => [m.ticker, m.dv5, m.dvMax])).toEqual([["BURST", 120e6, 400e6]]);
  });

  it("drops what isn't a stock and needs a prior close", () => {
    const days = weekOf({ ETF: bar(10) }, () => ({ ETF: bar(20), NEW: bar(20) }));
    expect(computeMovers(days, [], (t) => t !== "ETF")[0]!.movers).toEqual([]);
  });

  it("writes a CSV, newest week first", () => {
    const days = weekOf({ UP: bar(10) }, () => ({ UP: bar(20) }));
    const csv = moversCsv(computeMovers(days, [], all));
    expect(csv.split("\n")[1]).toMatch(/^2026-11-13,UP,up,close,100,100,100,10,20,/);
  });
});

describe("lastCompleteFriday", () => {
  it("is the Friday before today", () => {
    expect(lastCompleteFriday("2026-11-22")).toBe("2026-11-20"); // Sunday
    expect(lastCompleteFriday("2026-11-20")).toBe("2026-11-13"); // Friday itself isn't complete yet
    expect(lastCompleteFriday("2026-11-24")).toBe("2026-11-20");
  });
});

describe("movers.json and the page helpers", () => {
  // UP and FADE were liquid before the week; DN was quiet ($0.2M) until it fell on $104M a day.
  const days = weekOf({ UP: bar(10, 20e6), DN: bar(20, 0.01e6), FADE: bar(10, 20e6) }, (i) => ({
    UP: bar(20, 20e6),
    DN: bar(8, 13e6),
    FADE: i === 0 ? bar(16, 20e6) : bar(12, 20e6),
  }));
  const file = moversFile(computeMovers(days, [], all));

  it("round-trips and rejects anything else", () => {
    expect(file.through).toBe("2026-11-13");
    expect(parseMoversFile(JSON.stringify(file))).toEqual(file);
    expect(parseMoversFile("{}")).toBeNull();
    expect(parseMoversFile("not json")).toBeNull();
    expect(parseMoversFile(undefined)).toBeNull();
  });

  it("lists rows newest week first and filters by ticker, direction, basis and liquidity", () => {
    const rows = moverRows(file);
    expect(rows.map((r) => [r.ticker, r.weekEnd, r.repeats])).toEqual([["UP", "2026-11-13", 1], ["DN", "2026-11-13", 1], ["FADE", "2026-11-13", 1]]);
    expect(filterMovers(rows, { ...NO_FILTER, q: "up" }).map((r) => r.ticker)).toEqual(["UP"]);
    expect(filterMovers(rows, { ...NO_FILTER, dir: "down" }).map((r) => r.ticker)).toEqual(["DN"]);
    expect(filterMovers(rows, { ...NO_FILTER, basis: "intraweek" }).map((r) => r.ticker)).toEqual(["FADE"]);
    expect(filterMovers(rows, { ...NO_FILTER, liquidity: "before" }).map((r) => r.ticker)).toEqual(["UP", "FADE"]);
    expect(filterMovers(rows, { ...NO_FILTER, liquidity: "move" }).map((r) => r.ticker)).toEqual(["DN"]);
  });

  it("gives the demo half a year of weeks ending the Friday before now", () => {
    const d = demoMovers("2026-11-22T15:00:00Z", 1);
    expect(d.weeks).toHaveLength(26);
    expect(d.through).toBe("2026-11-20");
    expect(parseMoversFile(JSON.stringify(d))).not.toBeNull();
    expect(d.weeks.flatMap((w) => w.movers).every((m) => Math.abs(m.chg) >= 10 && m.start > 5)).toBe(true);
  });
});

describe("MoversPage", () => {
  const render = (movers: DataBundle["movers"], trades: unknown[] = []) =>
    renderToStaticMarkup(createElement(MoversPage, { data: { movers, derived: { trades } } as unknown as DataBundle }));

  it("shows an empty state before movers.json exists", () => {
    expect(render(null)).toContain("No movers yet");
  });

  it("lists every week newest first and marks a ticker traded that week", () => {
    const file = demoMovers("2026-11-22T15:00:00Z", 7);
    const latest = [...file.weeks].reverse().find((w) => w.movers.length)!;
    const m = latest.movers[0]!;
    const html = render(file, [{ id: "T-1", underlying: m.ticker, openedAt: `${latest.end}T14:00:00Z`, closedAt: null }]);
    const n = file.weeks.reduce((k, w) => k + w.movers.length, 0);
    expect(html).toContain(`${n} MOVER`);
    expect(html.indexOf(latest.end)).toBeGreaterThan(-1);
    expect(html).toContain(`href="#/trade/T-1"`);
    expect((html.match(/<tr/g) ?? []).length).toBe(Math.min(n, 150) + 1);
  });
});
