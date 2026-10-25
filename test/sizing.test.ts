import { describe, expect, it } from "vitest";
import { computeSizing, floorToTenth } from "../src/core/calc/sizing";

describe("floorToTenth", () => {
  it("floors to a tenth of a share", () => {
    expect(floorToTenth(12.34)).toBe(12.3);
    expect(floorToTenth(12.39)).toBe(12.3);
    expect(floorToTenth(0.09)).toBe(0);
  });
  it("doesn't nudge an exact tenth down (floating point)", () => {
    expect(floorToTenth(1.2)).toBe(1.2);
    expect(floorToTenth(2.1)).toBe(2.1);
  });
  it("floors non-positive input to 0", () => {
    expect(floorToTenth(0)).toBe(0);
    expect(floorToTenth(-5)).toBe(0);
  });
});

describe("computeSizing", () => {
  it("picks the risk rule when it's the tighter cap", () => {
    // $500 account, 1% risk = $5, 3% cap = $15. Entry 10, stop 9.50 → risk/share 0.50.
    // By risk: 5 / 0.50 = 10 sh. By capital: 15 / 10 = 1.5 sh. Capital wins here.
    const r = computeSizing({ entry: 10, stop: 9.5, account: 500, riskPct: 0.01, capPct: 0.03 });
    expect(r.maxRiskDollars).toBe(5);
    expect(r.maxCapitalDollars).toBe(15);
    expect(r.sharesByRisk).toBe(10);
    expect(r.sharesByCapital).toBe(1.5);
    expect(r.shares).toBe(1.5);
    expect(r.limitedBy).toBe("capital");
    expect(r.positionCost).toBe(15);
    expect(r.actualRisk).toBe(0.75);
  });

  it("picks the capital rule when risk is the tighter cap", () => {
    // Same account, a wider stop makes risk/share bigger so risk binds first.
    const r = computeSizing({ entry: 10, stop: 5, account: 500, riskPct: 0.01, capPct: 0.03 });
    expect(r.sharesByRisk).toBe(1); // 5 / 5
    expect(r.sharesByCapital).toBe(1.5); // 15 / 10
    expect(r.shares).toBe(1);
    expect(r.limitedBy).toBe("risk");
  });

  it("rounds the final share count down to a tenth", () => {
    const r = computeSizing({ entry: 7, stop: 6.9, account: 500, riskPct: 0.01, capPct: 0.03 });
    // risk/share 0.10 → by risk: 5 / 0.10 = 50; by capital: 15 / 7 = 2.142857…
    expect(r.sharesByCapital).toBe(2.1);
    expect(r.shares).toBe(2.1);
  });

  it("can land on a tie", () => {
    // riskPerShare / entry = riskPct / capPct (0.5 here) makes both rules give the same share count.
    const r = computeSizing({ entry: 10, stop: 5, account: 1000, riskPct: 0.01, capPct: 0.02 });
    expect(r.sharesByRisk).toBe(2);
    expect(r.sharesByCapital).toBe(2);
    expect(r.limitedBy).toBe("tie");
  });

  it("rejects a stop at or above entry", () => {
    expect(() => computeSizing({ entry: 10, stop: 10, account: 500, riskPct: 0.01, capPct: 0.03 })).toThrow(/stop/i);
    expect(() => computeSizing({ entry: 10, stop: 11, account: 500, riskPct: 0.01, capPct: 0.03 })).toThrow(/stop/i);
  });

  it("rejects non-positive inputs", () => {
    expect(() => computeSizing({ entry: 0, stop: -1, account: 500, riskPct: 0.01, capPct: 0.03 })).toThrow(/entry/i);
    expect(() => computeSizing({ entry: 10, stop: 9, account: 0, riskPct: 0.01, capPct: 0.03 })).toThrow(/account/i);
    expect(() => computeSizing({ entry: 10, stop: 9, account: 500, riskPct: 0, capPct: 0.03 })).toThrow(/risk/i);
    expect(() => computeSizing({ entry: 10, stop: 9, account: 500, riskPct: 0.01, capPct: 0 })).toThrow(/capital/i);
  });
});
