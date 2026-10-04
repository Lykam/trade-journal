import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runFetchQuotes, type QuoteProvider } from "../build/fetch-quotes";
import { mergeQuotes, openSymbols } from "../src/core/quotes";
import type { DerivedTrades, Quote, QuotesFile } from "../src/core/types";
import { closed, open } from "./factory";
import { FIXTURES } from "./helpers";

const T0 = "2026-09-30T14:00:00.000Z";
const T1 = "2026-09-30T14:15:00.000Z";
const quote = (price: number, time = T0): Quote => ({ price, time, marketState: "REGULAR" });

describe("openSymbols", () => {
  it("lists each open position's own symbol (the ETF held, not the underlying)", () => {
    const trades = [
      open({ symbol: "FAKU", underlying: "FAKE", openedAt: "2026-09-20T00:00:00-04:00" }),
      open({ symbol: "SWGA", openedAt: "2026-09-21T00:00:00-04:00" }),
      open({ symbol: "SWGA", openedAt: "2026-09-22T00:00:00-04:00" }),
      closed({ symbol: "ZZTA", closedAt: "2026-09-22T10:00:00-04:00", net: 1 }),
    ];
    expect(openSymbols(trades)).toEqual(["FAKU", "SWGA"]);
  });
});

describe("mergeQuotes", () => {
  const prev: QuotesFile = { asOf: T0, quotes: { SWGA: quote(10), SWGB: quote(20), GONE: quote(5) } };

  it("takes fresh quotes and drops symbols no longer held", () => {
    const m = mergeQuotes(prev, { SWGA: quote(11, T1), SWGB: quote(21, T1) }, ["SWGA", "SWGB"], T1);
    expect(m).toEqual({ asOf: T1, attemptedAt: T1, quotes: { SWGA: quote(11, T1), SWGB: quote(21, T1) } });
  });

  it("keeps the previous quote, marked stale, for a symbol the fetch missed", () => {
    const m = mergeQuotes(prev, { SWGA: quote(11, T1) }, ["SWGA", "SWGB"], T1);
    expect(m.quotes.SWGB).toEqual({ ...quote(20), stale: true });
    expect(m.quotes.SWGA!.stale).toBeUndefined();
  });

  it("keeps everything, stale, when the whole fetch fails, and does not move asOf", () => {
    const m = mergeQuotes(prev, {}, ["SWGA", "SWGB", "SWGN"], T1);
    expect(m.asOf).toBe(T0);
    expect(m.attemptedAt).toBe(T1);
    expect(Object.keys(m.quotes)).toEqual(["SWGA", "SWGB"]);
    expect(Object.values(m.quotes).every((q) => q.stale)).toBe(true);
  });

  it("clears the stale flag once a fetch succeeds again", () => {
    const stale = mergeQuotes(prev, {}, ["SWGA"], T1);
    expect(mergeQuotes(stale, { SWGA: quote(12, T1) }, ["SWGA"], T1).quotes.SWGA).toEqual(quote(12, T1));
  });
});

describe("npm run quotes", () => {
  let dir: string;
  let out: string;
  let logs: string[];
  const log = (s: string) => logs.push(s);
  const SYMBOLS = ["FAKU", "SWGA", "SWGB"];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "trade-history-"));
    cpSync(join(FIXTURES, "history"), dir, { recursive: true });
    const derived: DerivedTrades = {
      generated: true, generator: "test", ideas: [],
      trades: [
        open({ symbol: "FAKU", underlying: "FAKE", openedAt: "2026-09-20T00:00:00-04:00" }),
        open({ symbol: "SWGA", openedAt: "2026-09-21T00:00:00-04:00" }),
        open({ symbol: "SWGB", openedAt: "2026-09-21T00:00:00-04:00" }),
        closed({ symbol: "ZZTA", closedAt: "2026-09-22T10:00:00-04:00", net: 1 }),
      ],
    };
    mkdirSync(join(dir, "derived"));
    writeFileSync(join(dir, "derived", "trades.json"), JSON.stringify(derived));
    out = join(dir, "quotes.json");
    logs = [];
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const args = () => ["--history-dir", dir, "--out", out];
  const read = () => JSON.parse(readFileSync(out, "utf8")) as QuotesFile;

  it("requests only the open symbols and writes quotes.json", async () => {
    let asked: string[] = [];
    const provider: QuoteProvider = {
      name: "fake",
      async fetch(symbols) {
        asked = symbols;
        return { FAKU: quote(11, T1), SWGA: quote(12, T1) };
      },
    };
    expect(await runFetchQuotes(args(), { provider, now: T1, log, publicLog: false })).toBe(0);
    expect(asked).toEqual(SYMBOLS);
    expect(Object.keys(read().quotes)).toEqual(["FAKU", "SWGA"]);
    expect(logs.join("\n")).toContain("3 open symbols · 2 priced · 0 stale · 1 missing");
  });

  it("keeps previous quotes, marked stale, when the provider throws", async () => {
    writeFileSync(out, JSON.stringify({ asOf: T0, quotes: { FAKU: quote(10), SWGA: quote(11) } }));
    const provider: QuoteProvider = {
      name: "fake",
      async fetch(symbols) {
        throw new TypeError(`request failed for ${symbols.join(",")}`);
      },
    };
    expect(await runFetchQuotes(args(), { provider, now: T1, log })).toBe(0);
    const file = read();
    expect(file.asOf).toBe(T0);
    expect(file.quotes.FAKU).toMatchObject({ price: 10, stale: true });
    expect(logs.join("\n")).toContain("fetch failed (TypeError)");
  });

  it("never prints a symbol", async () => {
    const provider: QuoteProvider = { name: "fake", fetch: async () => { throw new Error("FAKU SWGA SWGB"); } };
    await runFetchQuotes(args(), { provider, now: T1, log });
    await runFetchQuotes(args(), { provider: { name: "fake", fetch: async () => ({ SWGA: quote(1) }) }, now: T1, log });
    const text = logs.join("\n");
    for (const s of [...SYMBOLS, "FAKE", "ZZTA"]) expect(text).not.toContain(s);
  });

  it("prints no counts in public-log mode (the workflows, Q35)", async () => {
    const provider: QuoteProvider = { name: "fake", fetch: async () => ({ FAKU: quote(11, T1) }) };
    expect(await runFetchQuotes(args(), { provider, now: T1, log, publicLog: true })).toBe(0);
    const text = logs.join("\n");
    expect(text).toContain("some open positions not freshly priced");
    expect(text).not.toMatch(/\d/);
  });
});
