import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runImport } from "../cli/import";
import { findTradervueExports, runImportTradervue } from "../cli/import-tradervue";
import { validate } from "../cli/lib/history";
import { runVerify } from "../cli/verify";
import { cleanNote, parseTradervue, splitTags, truncateNote } from "../src/core/tradervue/parse";
import { etDateTime } from "../src/core/tradervue/match";
import { FIXTURES, IMPORTED_AT, SCHWAB_A, SCHWAB_B, WEBULL_A, WEBULL_B, fixture } from "./helpers";

const TV = join(FIXTURES, "tradervue/trades.csv");
const PLMT = "wb-64128e3c0583"; // first Webull fixture trade
const NOW = "2025-03-21T22:00:00Z";

describe("tradervue/parse", () => {
  it("reads the trades export and skips short trades", () => {
    const r = parseTradervue(fixture("tradervue/trades.csv"));
    expect(r.errors).toEqual([]);
    expect(r.skipped).toEqual({ short: 1 });
    expect(r.trades).toHaveLength(16);
    const open = r.trades.find((t) => t.symbol === "OPSW")!;
    expect(open).toMatchObject({ closedAt: null, dateOnly: true, shares: null });
    const timed = r.trades.find((t) => t.symbol === "PLMT")!;
    expect(timed).toMatchObject({ dateOnly: false, shares: 5, tags: ["Momo"], note: "Fake note: waited for the & open." });
  });

  it("rejects other CSVs and reports bad rows without their values", () => {
    expect(parseTradervue("Date,Action,Symbol\n").errors[0]).toMatch(/not a Tradervue trades export/);
    const header = fixture("tradervue/trades.csv").split("\n")[0];
    const r = parseTradervue(`${header}\n2025-01-02 10:00:00,,SECRETX,L,3,2,1,1,abc,,false,,,,,,,,,,,\n`);
    expect(r.errors).toEqual(["row 1: bad Gross P&L"]);
    expect(r.errors.join()).not.toContain("SECRETX");
  });

  it("cleans notes, splits tags and truncates at a word boundary", () => {
    expect(cleanNote("<p>One&nbsp;&amp;<br>two &#8212; &#x41;</p>\n<p>three</p>")).toBe("One & two — A three");
    expect(splitTags(" Momo, gap ,MOMO,,Gap")).toEqual(["Momo", "gap"]);
    expect(truncateNote("short", 10)).toBe("short");
    expect(truncateNote("alpha beta gamma delta", 15)).toBe("alpha beta…");
    expect(truncateNote("alpha beta gamma delta", 15).length).toBeLessThanOrEqual(15);
  });

  it("formats ET wall-clock like Tradervue", () => {
    expect(etDateTime("2025-03-10T13:31:05Z")).toBe("2025-03-10 09:31:05");
    expect(etDateTime("2025-01-15T20:59:59Z")).toBe("2025-01-15 15:59:59");
  });
});

describe("cli/import-tradervue", () => {
  let dir: string;
  let out: string[];
  const log = (s: string) => out.push(s);
  const run = (...extra: string[]) => runImportTradervue([TV, "--history-dir", dir, "--now", NOW, "--limit", "100", ...extra], log);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "trade-history-"));
    cpSync(join(FIXTURES, "history"), dir, { recursive: true });
    // An existing manual tag Tradervue doesn't have, to show it would be removed.
    writeFileSync(join(dir, "overrides.json"), JSON.stringify({ trades: { [PLMT]: { tags: ["old-tag"] } }, openingPositions: [] }));
    const files = [WEBULL_A, WEBULL_B, SCHWAB_A, SCHWAB_B].map((f) => join(FIXTURES, f));
    expect(runImport([...files, "--history-dir", dir, "--now", IMPORTED_AT], () => {})).toBe(0);
    out = [];
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("--dry-run previews matching, tags, style, notes and discrepancies without writing", () => {
    const before = readFileSync(join(dir, "overrides.json"), "utf8");
    expect(run("--dry-run")).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("dry run: nothing written");
    expect(text).toContain("EXPORT: 16 trades (15 closed, 1 open), 9 date-only, 7 timed");
    expect(text).toContain("skipped short: 1");
    expect(text).toContain("FILLS ADDED: 0");
    expect(text).toContain("MATCHING: 12 journal trades matched by 13 Tradervue rows (1 duplicate copies of 1 trades)");
    expect(text).toContain("matched by time): ZZTA → ZZTN (1)");
    expect(text).toMatch(/UNMATCHED TRADERVUE TRADES \(3\)/);
    expect(text).toMatch(/EARLY .*\[before broker fills\]/);
    expect(text).toMatch(/NOPE .*\[no journal trade\]/);
    expect(text).toMatch(/RNDB .*\[split or quantity differs\]/);
    expect(text).toContain("by reason: no Tradervue trade 8, split or quantity differs 1");
    expect(text).toMatch(/STYLE CHANGES \(2\)[\s\S]*swing\s+HOLD[\s\S]*day\s+SDAY/);
    expect(text).toMatch(/JOURNAL TAGS THAT WOULD BE REMOVED \(1\).*\nPLMT .*old-tag/);
    expect(text).toContain("NOTES: 3 set, 0 replaced, 1 cut to 500 characters");
    expect(text).toContain("gross P&L equal after rounding to the cent: 1");
    expect(text).toContain("same-day lots paired differently (day total agrees): 2");
    expect(text).toContain("gross P&L differs (closed trades): 1");
    expect(text).toContain("execution count differs: 1");
    expect(text).toContain("Tradervue duplicate copies: 1 rows on 1 trades, 1 with different tags");
    expect(text).toContain("GAUGE 90-DAY BASELINES");
    expect(readFileSync(join(dir, "overrides.json"), "utf8")).toBe(before);
  });

  it("writes overrides (Tradervue wins) and a derived file verify accepts, idempotently", () => {
    expect(run()).toBe(0);
    const ov = JSON.parse(readFileSync(join(dir, "overrides.json"), "utf8"));
    validate("overrides", ov, "overrides");
    const trades = JSON.parse(readFileSync(join(dir, "derived/trades.json"), "utf8")).trades as Array<{ id: string; symbol: string; account: string; style: string; tags: string[]; note?: string }>;
    const by = (sym: string, account?: string) => trades.filter((t) => t.symbol === sym && (!account || t.account === account));
    expect(ov.trades[PLMT]).toEqual({ tags: ["Momo"], note: "Fake note: waited for the & open." });
    expect(by("HOLD")[0]).toMatchObject({ style: "swing", tags: ["Momo"] }); // Webull trade tagged Swing
    expect(by("SDAY")[0]).toMatchObject({ style: "day", tags: [] }); // Schwab trade without it
    expect(by("ZZTA")[0]!.tags).toEqual(["Momo", "Gap"]); // tags of both copies combined
    expect(by("BIGF")[0]).toMatchObject({ style: "swing", tags: ["Fade"] }); // "Swing" is automatic, not stored
    expect(by("BULF")[0]!.note!.length).toBeLessThanOrEqual(500);
    expect(by("RNDB")[0]!.tags).toEqual([]); // unmatched journal trades are left alone
    expect(JSON.stringify(ov)).not.toMatch(/"Swing"/);
    expect(out.join("\n")).toMatch(/Suggested commit message: Import Tradervue 2025-03-21: tags on \d+ trades, 2 style changes, 3 notes/);

    out = [];
    expect(runVerify(["--history-dir", dir], log)).toBe(0);
    out = [];
    expect(run()).toBe(0);
    expect(out.join("\n")).toContain("Wrote 0 file(s)");
  });

  it("archives the export once under imports/raw", () => {
    run();
    expect(readFileSync(join(dir, "imports/raw/2025-03-21-trades.csv"), "utf8")).toBe(fixture("tradervue/trades.csv"));
  });

  it("finds the export in a folder by its header", () => {
    const d = mkdtempSync(join(tmpdir(), "downloads-"));
    try {
      writeFileSync(join(d, "other.csv"), "Date,Action\n");
      writeFileSync(join(d, "trades.csv"), fixture("tradervue/trades.csv"));
      expect(findTradervueExports(d).map((p) => p.split(/[\\/]/).pop())).toEqual(["trades.csv"]);
      writeFileSync(join(d, "trades (1).csv"), fixture("tradervue/trades.csv"));
      expect(runImportTradervue(["--downloads", d, "--history-dir", dir, "--dry-run"], log)).toBe(1);
      expect(out.join("\n")).toContain("Several Tradervue exports");
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});
