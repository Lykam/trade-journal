import { describe, expect, it } from "vitest";
import { allInverseEtfs, searchInverseEtfs } from "../src/core/lookups/lookups";

describe("searchInverseEtfs", () => {
  it("returns every row for a blank query", () => {
    expect(searchInverseEtfs("")).toEqual(allInverseEtfs());
    expect(searchInverseEtfs("   ")).toEqual(allInverseEtfs());
  });

  it("matches the underlying, case-insensitively", () => {
    const rows = searchInverseEtfs("tsla");
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.every((r) => r.underlying === "TSLA")).toBe(true);
  });

  it("matches the ETF symbol itself", () => {
    expect(searchInverseEtfs("TSLQ")).toEqual([{ symbol: "TSLQ", underlying: "TSLA", leverage: 2, issuer: "Tradr" }]);
  });

  it("matches a substring of either column", () => {
    expect(searchInverseEtfs("SPC").every((r) => r.symbol.includes("SPC") || r.underlying.includes("SPC"))).toBe(true);
  });

  it("returns nothing for a ticker with no inverse ETF on file", () => {
    expect(searchInverseEtfs("WMT")).toEqual([]);
  });

  it("every row has a positive leverage and a non-empty issuer", () => {
    for (const r of allInverseEtfs()) {
      expect(r.leverage).toBeGreaterThan(0);
      expect(r.issuer.length).toBeGreaterThan(0);
    }
  });
});
