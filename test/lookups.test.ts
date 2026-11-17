import { describe, expect, it } from "vitest";
import { schemaTexts, validate } from "../cli/lib/history";
import type { HistorySnapshot } from "../src/core/history/files";
import {
  STARTER_TABLE, applyLookupsChange, inverseEtfFromDraft, planLookupsCommit, rowsOf, searchInverseEtfs, tableOf,
  type InverseEtfTable,
} from "../src/core/lookups/lookups";
import type { LookupsFile } from "../src/core/types";

const ALL = rowsOf(STARTER_TABLE);

describe("searchInverseEtfs", () => {
  it("returns every row for a blank query", () => {
    expect(searchInverseEtfs(ALL, "")).toEqual(ALL);
    expect(searchInverseEtfs(ALL, "   ")).toEqual(ALL);
  });

  it("matches the underlying, case-insensitively", () => {
    const rows = searchInverseEtfs(ALL, "tsla");
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.every((r) => r.underlying === "TSLA")).toBe(true);
  });

  it("matches the ETF symbol itself", () => {
    expect(searchInverseEtfs(ALL, "TSLQ")).toEqual([{ symbol: "TSLQ", underlying: "TSLA", leverage: 2, issuer: "Tradr" }]);
  });

  it("returns nothing for a ticker with no inverse ETF on file", () => {
    expect(searchInverseEtfs(ALL, "WMT")).toEqual([]);
  });

  it("the starter list passes the lookups schema", () => {
    expect(() => validate("lookups", { schemaVersion: 1, inverseEtfs: STARTER_TABLE }, "starter")).not.toThrow();
  });
});

describe("tableOf", () => {
  it("uses trade-history's table once it exists, else the starter list", () => {
    const mine: LookupsFile = { schemaVersion: 1, inverseEtfs: { ABCD: { underlying: "ABC", leverage: 1, issuer: "X" } } };
    expect(tableOf(mine)).toBe(mine.inverseEtfs);
    expect(tableOf(null)).toBe(STARTER_TABLE);
    expect(tableOf(undefined)).toBe(STARTER_TABLE);
  });
});

describe("inverseEtfFromDraft", () => {
  it("upper-cases tickers and reads 2x as 2", () => {
    expect(inverseEtfFromDraft({ symbol: " tslq ", underlying: "tsla", leverage: "2x", issuer: " Tradr " }))
      .toEqual({ symbol: "TSLQ", underlying: "TSLA", leverage: 2, issuer: "Tradr" });
  });

  it("says what's wrong", () => {
    expect(inverseEtfFromDraft({ symbol: "", underlying: "TSLA", leverage: "2", issuer: "T" })).toMatch(/ETF symbol/);
    expect(inverseEtfFromDraft({ symbol: "TS LQ", underlying: "TSLA", leverage: "2", issuer: "T" })).toMatch(/isn't a ticker/);
    expect(inverseEtfFromDraft({ symbol: "TSLQ", underlying: "", leverage: "2", issuer: "T" })).toMatch(/underlying/);
    expect(inverseEtfFromDraft({ symbol: "TSLQ", underlying: "TSLA", leverage: "-1", issuer: "T" })).toMatch(/leverage/);
    expect(inverseEtfFromDraft({ symbol: "TSLQ", underlying: "TSLA", leverage: "2", issuer: "" })).toMatch(/issuer/);
  });
});

describe("applyLookupsChange", () => {
  const table: InverseEtfTable = {
    AAAD: { underlying: "AAA", leverage: 1, issuer: "X" },
    BBBD: { underlying: "BBB", leverage: 2, issuer: "Y" },
    CCCD: { underlying: "CCC", leverage: 2, issuer: "Z" },
  };

  it("removes several and adds several at once, keys sorted, input untouched", () => {
    const e = applyLookupsChange(table, {
      remove: ["AAAD", "CCCD"],
      add: [{ symbol: "ZZZD", underlying: "ZZZ", leverage: 2, issuer: "Q" }, { symbol: "ABCD", underlying: "ABC", leverage: 1, issuer: "Q" }],
    });
    expect(Object.keys(e.table)).toEqual(["ABCD", "BBBD", "ZZZD"]);
    expect(e.removed.map((r) => r.symbol)).toEqual(["AAAD", "CCCD"]);
    expect(e.added.map((r) => r.symbol)).toEqual(["ZZZD", "ABCD"]);
    expect(table.AAAD).toBeDefined();
  });

  it("skips a removal that is already gone", () => {
    const e = applyLookupsChange(table, { remove: ["AAAD", "NOPE"], add: [] });
    expect(e.gone).toEqual(["NOPE"]);
    expect(e.removed).toHaveLength(1);
  });

  it("an add over an existing symbol is a replacement; an identical one is no change", () => {
    expect(applyLookupsChange(table, { remove: [], add: [{ symbol: "BBBD", underlying: "BBB", leverage: 3, issuer: "Y" }] }).replaced).toHaveLength(1);
    const same = applyLookupsChange(table, { remove: [], add: [{ symbol: "BBBD", underlying: "BBB", leverage: 2, issuer: "Y" }] });
    expect(same.replaced).toHaveLength(0);
    expect(same.added).toHaveLength(0);
  });

  it("refuses a symbol added twice", () => {
    const r = { symbol: "ZZZD", underlying: "ZZZ", leverage: 2, issuer: "Q" };
    expect(() => applyLookupsChange(table, { remove: [], add: [r, r] })).toThrow(/twice/);
  });
});

describe("planLookupsCommit", () => {
  const ctx = { schemas: schemaTexts() };
  const snap = (lookups: LookupsFile | null): HistorySnapshot => ({
    config: { accounts: [] } as never, symbols: {}, overrides: { trades: {}, openingPositions: [] }, fills: [], derived: null,
    sayings: { schemaVersion: 1, sayings: [] }, lookups,
  });

  it("first commit creates lookups.json from the starter list, minus the removals", () => {
    const [a, b] = Object.keys(STARTER_TABLE);
    const p = planLookupsCommit(snap(null), { remove: [a!, b!], add: [] }, ctx, validate);
    expect(p.creating).toBe(true);
    expect(p.files.map((f) => f.path)).toEqual(["lookups.json", "schema/lookups.schema.json"]);
    const written = JSON.parse(p.files[0]!.content as string) as LookupsFile;
    expect(Object.keys(written.inverseEtfs)).toHaveLength(Object.keys(STARTER_TABLE).length - 2);
    expect(written.inverseEtfs[a!]).toBeUndefined();
    expect(p.message).toBe(`Lookups: remove ${a}, ${b}`);
  });

  it("edits the existing file and writes nothing when nothing changes", () => {
    const file: LookupsFile = { schemaVersion: 1, inverseEtfs: { AAAD: { underlying: "AAA", leverage: 1, issuer: "X" } } };
    const p = planLookupsCommit(snap(file), { remove: [], add: [{ symbol: "BBBD", underlying: "BBB", leverage: 2, issuer: "Y" }] }, ctx, validate);
    expect(p.creating).toBe(false);
    expect(p.message).toBe("Lookups: add BBBD");
    expect(Object.keys(p.lookups.inverseEtfs)).toEqual(["AAAD", "BBBD"]);
    expect(planLookupsCommit(snap(file), { remove: ["GONE"], add: [] }, ctx, validate).files).toEqual([]);
  });
});
