import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CotProvider, runFetchCot } from "../build/fetch-cot";
import { addDays } from "../src/core/calendar";
import { clampBrake, computeSizing } from "../src/core/calc/sizing";
import {
  COT_BRAKE,
  COT_MARKETS,
  computeCotMarket,
  cotBrake,
  type CotMarketSnapshot,
  type CotReading,
  type CotReport,
  type DailyBar,
  LOOKBACK_WEEKS,
  rank,
  releaseDate,
  walkSignal,
  zoneOf,
} from "../src/core/cot/cot";
import type { CotFile } from "../src/core/types";

const ES = COT_MARKETS.find((m) => m.id === "ES")!;
const flatBar = (date: string, close = 100): DailyBar => ({ date, open: close, high: close + 1, low: close - 1, close });
/** `n` consecutive calendar days of flat bars from `from`. */
const flatBars = (from: string, n: number): DailyBar[] => Array.from({ length: n }, (_, i) => flatBar(addDays(from, i)));
const reading = (released: string, osc: number): CotReading => ({ report: addDays(released, -3), released, osc });

/** Weekly reports from a Tuesday; large-spec net % of OI = spec(i), small net % = small(i), commercials the other side: −(spec + small). */
function reports(n: number, spec: (i: number) => number, small: (i: number) => number = () => 0, start = "2022-01-04"): CotReport[] {
  return Array.from({ length: n }, (_, i) => ({
    date: addDays(start, 7 * i),
    openInterest: 1000,
    commercial: [500, 500 + 10 * (spec(i) + small(i))],
    largeSpec: [500 + 10 * spec(i), 500],
    small: [500 + 10 * small(i), 500],
  }));
}

describe("rank and zones", () => {
  it("ranks the latest value within the lookback, 0 to 100", () => {
    const v = Array.from({ length: LOOKBACK_WEEKS }, (_, i) => i);
    expect(rank(v, v.length - 1)).toBe(100);
    v[v.length - 1] = -5;
    expect(rank(v, v.length - 1)).toBe(0);
  });

  it("is null without a full lookback", () => {
    expect(rank([1, 2, 3], 2)).toBeNull();
  });

  it("splits 0–100 into sell ≤ 20, buy ≥ 80, neutral between", () => {
    expect([0, 20, 21, 79, 80, 100].map(zoneOf)).toEqual(["sell", "sell", "neutral", "neutral", "buy", "buy"]);
  });

  it("dates a Tuesday report's release to the Friday after", () => {
    expect(releaseDate("2026-11-03")).toBe("2026-11-06");
  });
});

describe("walkSignal", () => {
  // Ten flat bars (low 99, high 101, close 100) from 01-03, then a reversal day.
  const base = () => flatBars("2026-01-03", 10);
  const upReversal: DailyBar = { date: "2026-01-13", open: 99, high: 101, low: 97, close: 100.5 };
  const downReversal: DailyBar = { date: "2026-01-13", open: 101, high: 103, low: 99, close: 99.5 };

  it("arms in the buy zone and waits for a reversal day", () => {
    expect(walkSignal([reading("2026-01-02", 90)], [...base(), flatBar("2026-01-13")])).toMatchObject({ state: "armed", side: "long", since: "2026-01-13" });
  });

  it("confirms a long on an upside reversal, stop at its low", () => {
    const s = walkSignal([reading("2026-01-02", 90)], [...base(), upReversal, { date: "2026-01-14", open: 100, high: 101, low: 98, close: 100 }]);
    expect(s).toMatchObject({ state: "confirmed", side: "long", since: "2026-01-13", entry: 100.5, stop: 97 });
  });

  it("confirms a short on a downside reversal in the sell zone, stop at its high", () => {
    expect(walkSignal([reading("2026-01-02", 10)], [...base(), downReversal])).toMatchObject({ state: "confirmed", side: "short", stop: 103 });
  });

  it("stops out at the stop (or a worse open), then re-arms while the zone holds", () => {
    const stopped = [...base(), upReversal, { date: "2026-01-14", open: 99, high: 99, low: 96, close: 96.5 }];
    expect(walkSignal([reading("2026-01-02", 90)], stopped).state).toBe("neutral");
    const s = walkSignal([reading("2026-01-02", 90)], [...stopped, flatBar("2026-01-15", 96.5)]);
    expect(s).toMatchObject({ state: "armed", side: "long", since: "2026-01-15" });
    expect(s.last).toEqual({ kind: "stopped", side: "long", date: "2026-01-14", ret: -3.48 });
  });

  it("takes profits once the oscillator is back to 50", () => {
    const s = walkSignal(
      [reading("2026-01-02", 90), reading("2026-01-13", 45)],
      [...base(), upReversal, { date: "2026-01-14", open: 102, high: 103, low: 101, close: 102.51 }],
    );
    expect(s.state).toBe("neutral");
    expect(s.last).toEqual({ kind: "exited", side: "long", date: "2026-01-14", ret: 2 });
  });

  it("expires an armed zone that ends before a reversal confirms it", () => {
    const s = walkSignal([reading("2026-01-02", 90), reading("2026-01-13", 70)], flatBars("2026-01-03", 12));
    expect(s.state).toBe("neutral");
    expect(s.last).toMatchObject({ kind: "expired", side: "long", date: "2026-01-14" });
  });

  it("ignores a reading released more than two weeks before the bar", () => {
    const bars = [...flatBars("2026-01-20", 10), { ...upReversal, date: "2026-01-30" }];
    expect(walkSignal([reading("2026-01-02", 90)], bars).state).toBe("neutral");
  });

  it("only uses a reading from the session after its release", () => {
    // Released the same day as the reversal: not known yet.
    expect(walkSignal([reading("2026-01-13", 90)], [...base(), upReversal]).state).toBe("neutral");
  });
});

describe("computeCotMarket", () => {
  const n = LOOKBACK_WEEKS + 60;
  const lastReport = addDays("2022-01-04", 7 * (n - 1));
  const now = `${addDays(lastReport, 4)}T21:20:00.000Z`;

  it("is null without a full lookback of reports", () => {
    expect(computeCotMarket(ES, reports(LOOKBACK_WEEKS - 1, (i) => i), [], now)).toBeNull();
  });

  it("puts commercials at their most long in the buy zone, with 4-week and year-over-year readings", () => {
    const m = computeCotMarket(ES, reports(n, (i) => (i === n - 1 ? -50 : i % 20)), [], now)!;
    expect(m).toMatchObject({ osc: 100, zone: "buy", specRank: 0, report: lastReport, stale: false });
    expect(m.net.commercial).toBe(50);
    expect(m.osc4w).not.toBeNull();
    expect(m.osc1y).not.toBeNull();
    expect(m.net.largeSpec).toBe(-50);
    expect(m.net1y).not.toBeNull();
    expect(m.spark).toHaveLength(52);
  });

  it("flags small traders long while large specs are short (the 1999 setup)", () => {
    const m = computeCotMarket(ES, reports(n, (i) => -i, (i) => i), [], now)!;
    expect(m.smallRank).toBe(100);
    expect(m.specRank).toBe(0);
    expect(m.divergence).toBe("small-long-large-short");
  });

  it("marks a reading stale once its release is more than two weeks old", () => {
    const later = `${addDays(lastReport, 30)}T21:20:00.000Z`;
    expect(computeCotMarket(ES, reports(n, (i) => i), [], later)!.stale).toBe(true);
  });
});

describe("cotBrake", () => {
  const m = (id: CotMarketSnapshot["id"], osc: number, stale = false) => ({ id, osc, zone: zoneOf(osc), stale }) as CotMarketSnapshot;

  it("halves longs while an index is in the sell zone and inverse ETFs while one is in the buy zone", () => {
    expect(cotBrake([m("ES", 62), m("NQ", 8), m("YM", 16)])).toEqual({
      long: { multiplier: COT_BRAKE, against: ["NQ", "YM"] },
      short: { multiplier: 1, against: [] },
    });
    expect(cotBrake([m("ES", 88), m("NQ", 50), m("YM", 50)]).short).toEqual({ multiplier: COT_BRAKE, against: ["ES"] });
  });

  it("leaves stale markets out", () => {
    expect(cotBrake([m("NQ", 5, true)]).long.multiplier).toBe(1);
  });
});

describe("computeSizing with the COT brake", () => {
  const input = { entry: 10, stop: 9, account: 10_000, riskPct: 0.01, capPct: 0.5 };

  it("applies the brake after turnover and reports both steps", () => {
    const r = computeSizing({ ...input, cotMultiplier: 0.5 });
    expect(r.sharesBeforeCot).toBe(100);
    expect(r.cotMultiplier).toBe(0.5);
    expect(r.shares).toBe(50);
    expect(r.actualRisk).toBe(50);
  });

  it("never sizes up", () => {
    expect(computeSizing({ ...input, cotMultiplier: 2 }).shares).toBe(100);
    expect([clampBrake(), clampBrake(0), clampBrake(-1), clampBrake(1.5), clampBrake(0.5)]).toEqual([1, 1, 1, 1, 0.5]);
  });
});

describe("npm run cot", () => {
  const T0 = "2026-10-30T21:20:00.000Z";
  const T1 = "2026-11-06T21:20:00.000Z";
  let dir: string;
  let out: string;
  let logs: string[];
  const log = (s: string) => logs.push(s);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cot-"));
    out = join(dir, "cot.json");
    logs = [];
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const read = () => JSON.parse(readFileSync(out, "utf8")) as CotFile;
  const prev: CotFile = { asOf: T0, attemptedAt: T0, snapshot: { markets: [], brake: { long: { multiplier: 1, against: [] }, short: { multiplier: 1, against: [] } } } };
  const full: CotProvider = {
    name: "fake",
    reports: async (codes) => Object.fromEntries(codes.map((c) => [c, reports(LOOKBACK_WEEKS + 60, (i) => i % 30, () => 0, "2023-07-04")])),
    bars: async (symbols) => Object.fromEntries(symbols.map((s) => [s, flatBars("2026-09-01", 60)])),
  };

  it("writes a fresh snapshot for every market", async () => {
    expect(await runFetchCot(["--out", out], { provider: full, now: T1, log })).toBe(0);
    const file = read();
    expect(file).toMatchObject({ asOf: T1, attemptedAt: T1 });
    expect(file.stale).toBeUndefined();
    expect(file.snapshot.markets.map((m) => m.id)).toEqual(["ES", "NQ", "YM"]);
  });

  it("carries the previous snapshot forward, marked stale, when a market's bars are missing", async () => {
    writeFileSync(out, JSON.stringify(prev));
    const provider: CotProvider = { ...full, bars: async (symbols) => ({ [symbols[0]!]: flatBars("2026-09-01", 60) }) };
    expect(await runFetchCot(["--out", out], { provider, now: T1, log })).toBe(0);
    expect(read()).toMatchObject({ asOf: T0, attemptedAt: T1, stale: true });
  });

  it("carries forward when the whole fetch throws, and fails only without a previous snapshot", async () => {
    const provider: CotProvider = {
      name: "fake",
      reports: async () => {
        throw new Error("boom");
      },
      bars: async () => ({}),
    };
    expect(await runFetchCot(["--out", out], { provider, now: T1, log })).toBe(1);
    expect(read().stale).toBe(true);
    writeFileSync(out, JSON.stringify(prev));
    expect(await runFetchCot(["--out", out], { provider, now: T1, log })).toBe(0);
    expect(read()).toMatchObject({ asOf: T0, stale: true });
  });
});
