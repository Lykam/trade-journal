import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RegimeProvider, runFetchRegime } from "../build/fetch-regime";
import { ALL_REGIME_SYMBOLS, type Bar, computeRegime, REGIME_SYMBOLS } from "../src/core/regime/regime";
import type { RegimeFile } from "../src/core/types";

const T0 = "2026-09-30T14:00:00.000Z";
const T1 = "2026-10-01T21:20:00.000Z";

const bar = (date: string, close: number, volume = 1_000_000): Bar => ({ date, close, volume });
const flat = (n: number, price = 100): Bar[] => Array.from({ length: n }, (_, i) => bar(`d${i}`, price));
const ramp = (n: number, from: number, to: number): Bar[] => Array.from({ length: n }, (_, i) => bar(`d${i}`, from + ((to - from) * i) / (n - 1)));

/** Flat, 260-session series for every basket symbol: a neutral baseline tests override from. */
function baseBars(): Record<string, Bar[]> {
  const bars: Record<string, Bar[]> = {};
  for (const s of ALL_REGIME_SYMBOLS) bars[s] = flat(260);
  return bars;
}

/** Down on higher volume every other session: enough distribution days in the trailing 25 to cluster. */
function clusteredDown(n: number): Bar[] {
  const bars: Bar[] = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    const down = i % 2 === 1;
    price *= down ? 0.99 : 1.011;
    bars.push(bar(`d${i}`, price, down ? 2_000_000 : 1_000_000));
  }
  return bars;
}

describe("computeRegime: trend", () => {
  it("scores +1 when SPY/QQQ sit above a rising 50/200dma", () => {
    const bars = baseBars();
    bars.SPY = ramp(260, 100, 200);
    bars.QQQ = ramp(260, 100, 200);
    expect(computeRegime(bars).indicators.find((i) => i.id === "trend")).toMatchObject({ score: 1 });
  });

  it("scores −1 when SPY/QQQ sit below a falling 50dma with 10<20dma both falling", () => {
    const bars = baseBars();
    bars.SPY = ramp(260, 200, 100);
    bars.QQQ = ramp(260, 200, 100);
    expect(computeRegime(bars).indicators.find((i) => i.id === "trend")).toMatchObject({ score: -1 });
  });

  it("is neutral on a flat market", () => {
    expect(computeRegime(baseBars()).indicators.find((i) => i.id === "trend")).toMatchObject({ score: 0 });
  });
});

describe("computeRegime: breadth", () => {
  it("scores +1 when the equal-weight proxy leads and holds its 50dma", () => {
    const bars = baseBars();
    bars.RSP = ramp(60, 100, 112);
    bars.SPY = ramp(60, 100, 103);
    expect(computeRegime(bars).indicators.find((i) => i.id === "breadth")).toMatchObject({ score: 1 });
  });

  it("scores −1 on the mirror case", () => {
    const bars = baseBars();
    bars.RSP = ramp(60, 100, 88);
    bars.SPY = ramp(60, 100, 97);
    expect(computeRegime(bars).indicators.find((i) => i.id === "breadth")).toMatchObject({ score: -1 });
  });
});

describe("computeRegime: leadership", () => {
  it("scores +1 when offensive groups beat defensive ones by more than 1.5pt", () => {
    const bars = baseBars();
    for (const s of REGIME_SYMBOLS.offensive) bars[s] = ramp(60, 100, 112);
    for (const s of REGIME_SYMBOLS.defensive) bars[s] = ramp(60, 100, 101);
    expect(computeRegime(bars).indicators.find((i) => i.id === "leadership")).toMatchObject({ score: 1 });
  });

  it("scores −1 when defensive groups lead", () => {
    const bars = baseBars();
    for (const s of REGIME_SYMBOLS.offensive) bars[s] = ramp(60, 100, 99);
    for (const s of REGIME_SYMBOLS.defensive) bars[s] = ramp(60, 100, 108);
    expect(computeRegime(bars).indicators.find((i) => i.id === "leadership")).toMatchObject({ score: -1 });
  });
});

describe("computeRegime: high-beta vs low-beta", () => {
  it("scores +1 when SPHB beats SPLV by more than 2pt", () => {
    const bars = baseBars();
    bars.SPHB = ramp(60, 100, 110);
    bars.SPLV = ramp(60, 100, 101);
    expect(computeRegime(bars).indicators.find((i) => i.id === "beta")).toMatchObject({ score: 1 });
  });
});

describe("computeRegime: distribution days", () => {
  it("scores −1 when down-on-higher-volume sessions cluster", () => {
    const bars = baseBars();
    const clustered = clusteredDown(30);
    bars.SPY = clustered;
    bars.QQQ = clustered;
    expect(computeRegime(bars).indicators.find((i) => i.id === "distribution")).toMatchObject({ score: -1 });
  });

  it("scores +1 on a flat tape with no distribution days", () => {
    expect(computeRegime(baseBars()).indicators.find((i) => i.id === "distribution")).toMatchObject({ score: 1 });
  });
});

describe("computeRegime: state", () => {
  it("stays UNSURE on a flat market even though one indicator alone nudges it positive", () => {
    const r = computeRegime(baseBars());
    expect(r.score).toBe(1); // distribution's lone +1 (no down days); everything else neutral
    expect(r.state).toBe("unsure");
  });

  it("is RISK-ON once the score clears +2", () => {
    const bars = baseBars();
    bars.SPY = ramp(260, 100, 200);
    bars.QQQ = ramp(260, 100, 200);
    bars.RSP = ramp(260, 100, 260); // breadth proxy rising faster than SPY
    expect(computeRegime(bars).state).toBe("risk-on");
  });

  it("is RISK-OFF once the score clears −2", () => {
    const bars = baseBars();
    bars.SPY = ramp(260, 200, 100);
    bars.QQQ = ramp(260, 200, 100);
    bars.RSP = ramp(260, 100, 20); // breadth proxy falling faster than SPY
    for (const s of REGIME_SYMBOLS.offensive) bars[s] = ramp(60, 100, 99);
    for (const s of REGIME_SYMBOLS.defensive) bars[s] = ramp(60, 100, 108);
    expect(computeRegime(bars).state).toBe("risk-off");
  });
});

describe("npm run regime", () => {
  let dir: string;
  let out: string;
  let logs: string[];
  const log = (s: string) => logs.push(s);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "regime-"));
    out = join(dir, "regime.json");
    logs = [];
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const args = () => ["--out", out];
  const read = () => JSON.parse(readFileSync(out, "utf8")) as RegimeFile;
  const fullBars = (): Record<string, Bar[]> => {
    const bars: Record<string, Bar[]> = {};
    for (const s of ALL_REGIME_SYMBOLS) bars[s] = flat(260);
    return bars;
  };

  it("computes and writes a fresh snapshot when every symbol is fetched", async () => {
    const provider: RegimeProvider = { name: "fake", fetch: async () => fullBars() };
    expect(await runFetchRegime(args(), { provider, now: T1, log })).toBe(0);
    const file = read();
    expect(file).toMatchObject({ asOf: T1, attemptedAt: T1 });
    expect(file.stale).toBeUndefined();
    expect(file.snapshot.indicators).toHaveLength(5);
  });

  it("carries the previous snapshot forward, marked stale, when a symbol is missing", async () => {
    writeFileSync(out, JSON.stringify({ asOf: T0, attemptedAt: T0, snapshot: { state: "risk-on", score: 3, indicators: [] } }));
    const provider: RegimeProvider = {
      name: "fake",
      fetch: async (symbols) => {
        const bars = fullBars();
        delete bars[symbols[0]!];
        return bars;
      },
    };
    expect(await runFetchRegime(args(), { provider, now: T1, log })).toBe(0);
    const file = read();
    expect(file).toMatchObject({ asOf: T0, attemptedAt: T1, stale: true });
    expect(file.snapshot.state).toBe("risk-on");
  });

  it("carries forward, marked stale, when the whole fetch throws", async () => {
    writeFileSync(out, JSON.stringify({ asOf: T0, attemptedAt: T0, snapshot: { state: "unsure", score: 0, indicators: [] } }));
    const provider: RegimeProvider = {
      name: "fake",
      fetch: async () => {
        throw new Error("boom");
      },
    };
    expect(await runFetchRegime(args(), { provider, now: T1, log })).toBe(0);
    expect(read()).toMatchObject({ asOf: T0, attemptedAt: T1, stale: true });
  });

  it("returns 1 only when there is no previous snapshot to fall back to", async () => {
    const provider: RegimeProvider = { name: "fake", fetch: async () => ({}) };
    expect(await runFetchRegime(args(), { provider, now: T1, log })).toBe(1);
    expect(read().stale).toBe(true);
  });

  it("prints no counts in public-log mode (the workflows, Q35)", async () => {
    const provider: RegimeProvider = { name: "fake", fetch: async () => fullBars() };
    expect(await runFetchRegime(args(), { provider, now: T1, log, publicLog: true })).toBe(0);
    expect(logs.join("\n")).not.toMatch(/\d+ symbols/);
  });
});
