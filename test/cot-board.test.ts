import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CotProvider, runFetchCot } from "../build/fetch-cot";
import { addDays } from "../src/core/calendar";
import {
  BOARD_MARKETS,
  BOARD_WEEKS,
  boardMarket,
  buildWeeks,
  computeBoard,
  computeBoardMarket,
  decodeRow,
  encodeWeek,
  mondayOf,
  rankSeries,
  summarize,
  type BoardWeek,
} from "../src/core/cot/board";
import type { CotReport, DailyBar } from "../src/core/cot/cot";
import type { CotFile } from "../src/core/types";
import { generateDemo } from "../src/demo/generate";

/** Weekly Tuesday reports: large-spec net = spec(i) contracts, small net = small(i), OI 1000, commercials the other side. */
function reports(n: number, spec: (i: number) => number, small: (i: number) => number = () => 0, start = "2022-01-04"): CotReport[] {
  return Array.from({ length: n }, (_, i) => ({
    date: addDays(start, 7 * i),
    openInterest: 1000,
    largeSpec: [500 + Math.max(0, spec(i)), 500 + Math.max(0, -spec(i))],
    small: [100 + Math.max(0, small(i)), 100 + Math.max(0, -small(i))],
    commercial: [400 + Math.max(0, -spec(i) - small(i)), 400 + Math.max(0, spec(i) + small(i))],
  }));
}
const weeklyBars = (from: string, n: number, close = (i: number) => 100 + i): DailyBar[] =>
  Array.from({ length: n }, (_, i) => ({ date: addDays(from, 7 * i), open: close(i) - 1, high: close(i) + 2, low: close(i) - 2, close: close(i) }));

const SI = boardMarket("SI")!;
const NOW = "2026-11-19T21:20:00.000Z";
/** 200 weekly reports ending Tue 2026-11-10, fresh at NOW. */
const START = addDays("2026-11-10", -7 * 199);

describe("board market list", () => {
  it("has unique ids, codes and Yahoo symbols", () => {
    for (const key of ["id", "code", "yahoo"] as const) expect(new Set(BOARD_MARKETS.map((m) => m[key])).size).toBe(BOARD_MARKETS.length);
  });

  it("carries the index futures the dashboard gauge reads, with the same CFTC codes", () => {
    expect(["ES", "NQ", "YM"].map((id) => boardMarket(id)?.code)).toEqual(["13874A", "209742", "124603"]);
  });
});

describe("buildWeeks", () => {
  it("dates weeks by their Monday", () => {
    expect(["2026-11-10", "2026-11-16", "2026-11-22"].map(mondayOf)).toEqual(["2026-11-09", "2026-11-16", "2026-11-16"]);
  });

  it("merges each report with its week's bar and keeps the current week's bar without a report", () => {
    const reps = reports(3, (i) => 10 * i, () => 0, "2026-10-27");
    const weeks = buildWeeks(reps, weeklyBars("2026-10-26", 4));
    expect(weeks.map((w) => [w.w, w.d, w.spec, w.c])).toEqual([
      ["2026-10-26", "2026-10-27", 0, 100],
      ["2026-11-02", "2026-11-03", 10, 101],
      ["2026-11-09", "2026-11-10", 20, 102],
      ["2026-11-16", null, null, 103],
    ]);
    expect(weeks[2]!.comm).toBe(-20);
  });

  it("keeps the last n reported weeks and drops bars from before the first report", () => {
    const reps = reports(10, (i) => i, () => 0, "2026-01-06");
    const weeks = buildWeeks(reps, weeklyBars("2025-12-01", 16), 4);
    expect(weeks.filter((w) => w.d).length).toBe(4);
    expect(weeks[0]!.d).toBe(reps[6]!.date);
  });

  it("round-trips through the stored tuple", () => {
    const w: BoardWeek = { w: "2026-11-09", d: "2026-11-10", oi: 5, spec: 1, comm: -2, small: 1, c: 1.5 };
    expect(decodeRow(encodeWeek(w))).toEqual(w);
    expect(decodeRow(encodeWeek({ ...w, d: null }))).toEqual({ ...w, d: null });
  });
});

describe("rankSeries", () => {
  const weeks = buildWeeks(reports(30, (i) => i), []);

  it("ranks each report in the trailing lookback, null before a full one", () => {
    const r = rankSeries(weeks, "spec", 26, "contracts");
    expect(r[24]).toBeNull();
    expect(r[25]).toBe(100);
    expect(rankSeries(weeks, "comm", 26, "contracts")[29]).toBe(0);
  });

  it("carries the last rank through a week without a report", () => {
    const withCurrent = [...weeks, { ...weeks.at(-1)!, w: "2099-01-05", d: null, spec: null }];
    const r = rankSeries(withCurrent, "spec", 26, "contracts");
    expect(r.at(-1)).toBe(r.at(-2));
  });

  it("can rank on % of open interest, which differs from contracts when OI moves", () => {
    const reps = reports(30, () => 100).map((r, i) => ({ ...r, openInterest: i === 29 ? 500 : 1000 }));
    const w = buildWeeks(reps, []);
    expect(rankSeries(w, "spec", 26, "contracts")[29]).toBe(50);
    expect(rankSeries(w, "spec", 26, "pct")[29]).toBe(100);
  });
});

describe("summarize: the heads-up", () => {
  const data = (spec: (i: number) => number, small: (i: number) => number = () => 0) =>
    computeBoardMarket(SI, reports(200, spec, small, START), weeklyBars(addDays(START, -1), 202), [], NOW);

  it("calls a crowded short a buy zone", () => {
    const s = summarize(SI, data((i) => (i === 199 ? -500 : (i % 20) * 10)), 156, "contracts");
    expect(s.spec.rank).toBe(0);
    expect(s.zone).toBe("buy");
    expect(s.heads[0]).toMatchObject({ tone: "buy", text: expect.stringContaining("CROWDED SHORT") });
    expect(s.priority).toBeGreaterThanOrEqual(3);
  });

  it("flags near a zone, the small traders against the specs, and a fast 4-week shift", () => {
    const near = summarize(SI, data((i) => (i === 199 ? 43 : (i % 20) * 10 - 100)), 156, "contracts");
    expect(near.heads.map((h) => h.text)).toContain("NEAR SELL ZONE (5 AWAY)");
    const div = summarize(SI, data((i) => (i >= 195 ? -500 : (i % 20) * 10), (i) => (i === 199 ? 400 : 0)), 156, "contracts");
    const texts = div.heads.map((h) => h.text);
    expect(texts).toContain("SMALL TRADERS LONG VS SPECS");
    const fast = summarize(SI, data((i) => (i === 199 ? 500 : i >= 190 ? -500 : (i % 20) * 10)), 156, "contracts");
    expect(fast.heads.map((h) => h.text)).toContain("FAST MOVE 0 → 100 IN 4W");
  });

  it("reports the weekly price change and the specs' net change", () => {
    const s = summarize(SI, data((i) => i), 156, "contracts");
    expect(s.price).toBe(301);
    expect(s.priceChg).toBeCloseTo((100 * 1) / 300, 6);
    expect(s.spec).toMatchObject({ net: 199, chg: 1 });
  });

  it("puts a live signal ahead of a zone", () => {
    const d = data((i) => i);
    d.signal = { state: "armed", side: "long", since: "2026-11-12", entry: null, stop: null, last: null, trigger: 40, lastClose: 42 };
    const s = summarize(SI, d, 156, "contracts");
    expect(s.heads[0]!.text).toBe("ARMED LONG · TRIGGER < 40.00");
    expect(s.priority).toBeGreaterThanOrEqual(4);
  });
});

describe("computeBoard", () => {
  it("keeps a market missing this time from the previous board, marked stale", () => {
    const reps = reports(200, (i) => i, () => 0, "2023-01-03");
    const prev = computeBoard({ [SI.code]: reps }, {}, {}, NOW);
    expect(prev.markets.map((m) => m.id)).toEqual(["SI"]);
    const next = computeBoard({}, {}, {}, NOW, prev);
    expect(next.markets[0]).toMatchObject({ id: "SI", stale: true });
  });

  it("marks a market stale when its last report is over two weeks old", () => {
    const old = computeBoardMarket(SI, reports(400, (i) => i, () => 0, "2018-01-02"), [], [], NOW);
    expect(old.stale).toBe(true);
    expect(old.rows.length).toBe(BOARD_WEEKS);
  });
});

describe("npm run cot writes the board", () => {
  const T1 = "2026-11-06T21:20:00.000Z";
  let dir: string;
  let out: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cot-board-"));
    out = join(dir, "cot.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const read = () => JSON.parse(readFileSync(out, "utf8")) as CotFile;

  const provider: CotProvider = {
    name: "fake",
    reports: async (codes) => Object.fromEntries(codes.map((c) => [c, reports(220, (i) => i % 30, () => 0, "2022-08-02")])),
    bars: async (symbols) => Object.fromEntries(symbols.map((s) => [s, weeklyBars("2026-08-03", 60).map((b, i) => ({ ...b, date: addDays("2026-08-03", i) }))])),
    weekly: async (symbols) => Object.fromEntries(symbols.map((s) => [s, weeklyBars("2022-08-01", 225)])),
  };

  it("adds every board market, with prices, and takes the indices' signals from the gauge", async () => {
    expect(await runFetchCot(["--out", out], { provider, now: T1, log: () => {} })).toBe(0);
    const f = read();
    expect(f.board!.markets.map((m) => m.id)).toEqual(BOARD_MARKETS.map((m) => m.id));
    expect(f.board!.markets.find((m) => m.id === "SI")!.rows.at(-1)![6]).not.toBeNull();
    const es = f.board!.markets.find((m) => m.id === "ES")!;
    expect(es.signalOn).toBe("SPY");
    expect(es.signal).toEqual(f.snapshot.markets.find((m) => m.id === "ES")!.signal);
  });

  it("carries the previous board over when no report came back", async () => {
    await runFetchCot(["--out", out], { provider, now: T1, log: () => {} });
    const before = read().board!;
    const failing: CotProvider = { ...provider, reports: async () => ({}) };
    await runFetchCot(["--out", out], { provider: failing, now: T1, log: () => {} });
    expect(read().board).toEqual({ ...before, stale: true });
  });

  it("leaves the board out when there was never one to carry", async () => {
    writeFileSync(out, JSON.stringify({ asOf: T1, snapshot: { markets: [], brake: {} } }));
    await runFetchCot(["--out", out], { provider: { ...provider, reports: async () => ({}) }, now: T1, log: () => {} });
    expect(read().board).toBeUndefined();
  });
});

describe("demo board", () => {
  it("covers every market and shows a buy zone, a sell zone and a live signal", () => {
    const b = generateDemo("2026-11-19T15:00:00.000Z").bundle.cot!.board!;
    expect(b.markets.length).toBe(BOARD_MARKETS.length);
    const sums = b.markets.map((d) => summarize(boardMarket(d.id)!, d, 156, "pct"));
    expect(sums.some((s) => s.zone === "buy")).toBe(true);
    expect(sums.some((s) => s.zone === "sell")).toBe(true);
    expect(sums.some((s) => s.data.signal?.state === "confirmed")).toBe(true);
  });
});

import { TICKER_NOTES, TRADE_IDEAS, tradeIdeas } from "../src/core/cot/board";

describe("trade ideas: stocks and ETFs per market", () => {
  it("has an entry for every market, explaining any empty side", () => {
    for (const m of BOARD_MARKETS) {
      const t = TRADE_IDEAS[m.id];
      expect(t, m.id).toBeDefined();
      if (!t!.long.length) expect(t!.note, m.id).toBeTruthy();
    }
  });

  it("notes every inverse and leveraged ETF it lists", () => {
    for (const t of Object.values(TRADE_IDEAS)) for (const s of t.short.filter((x) => x !== "UUP")) expect(TICKER_NOTES[s], s).toBeTruthy();
  });

  it("acts on the zone's side: buy side for a crowded short, inverse for a crowded long", () => {
    const d = (spec: (i: number) => number) => computeBoardMarket(SI, reports(200, spec, () => 0, START), [], [], NOW);
    expect(summarize(SI, d((i) => (i === 199 ? -500 : (i % 20) * 10)), 156, "contracts").side).toBe("long");
    expect(summarize(SI, d((i) => (i === 199 ? 500 : (i % 20) * 10)), 156, "contracts").side).toBe("short");
    expect(summarize(SI, d((i) => (i % 20) * 10 + (i === 199 ? -95 : 0)), 156, "contracts").side).toBeNull();
    expect(tradeIdeas("SI")).toMatchObject({ long: ["SLV", "SIL", "PAAS", "AG"], short: ["ZSL"] });
  });
});
