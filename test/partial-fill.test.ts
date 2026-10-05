// A Webull order exported while partly filled, then again once filled (#2,
// Q45): the import must stop with an error instead of storing both rows.
// Synthetic exports, fake tickers.
import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runImport } from "../cli/import";
import { importFiles } from "../src/core/normalize";
import { config, FIXTURES, IMPORTED_AT, symbols } from "./helpers";

const HEADER = "Name,Symbol,Side,Status,Filled,Total Qty,Price,Avg Price,Time-in-Force,Placed Time,Filled Time";
const row = (status: string, filled: number, avg: string, placed: string, filledAt: string, side = "Buy") =>
  `PARTIAL TEST CORP,PRTQ,${side},${status},${filled},10,@${avg},${avg},DAY,03/17/2025 ${placed} EDT,03/17/2025 ${filledAt} EDT`;
const csv = (...rows: string[]) => [HEADER, ...rows].join("\n");

// Export 1, mid-session: 5 of 10 filled. Export 2, later: all 10 filled, plus an unrelated sell.
const MID = csv(row("Partial Filled", 5, "3.0000000000", "10:00:00", "10:00:04"));
const DONE = csv(
  row("Filled", 4, "3.2000000000", "11:30:00", "11:30:00", "Sell"),
  row("Filled", 10, "3.0500000000", "10:00:00", "10:12:40"),
);
const ctx = { config, symbols, importedAt: IMPORTED_AT };

describe("Webull partial fill exported mid-session", () => {
  it("is an error when the finished order arrives after the partial (one import or two)", () => {
    const together = importFiles([{ name: "Webull_Orders_Records.csv", text: MID }, { name: "Webull_Orders_Records(1).csv", text: DONE }], [], ctx);
    expect(together.files[0]!.errors).toEqual([]);
    expect(together.files[1]!.errors).toHaveLength(1);
    expect(together.files[1]!.errors[0]).toMatch(/^same order seen with a different filled qty: likely a partial fill exported mid-session/);
    expect(together.files[1]!.added).toBe(0);

    const first = importFiles([{ name: "Webull_Orders_Records.csv", text: MID }], [], ctx);
    const second = importFiles([{ name: "Webull_Orders_Records(1).csv", text: DONE }], first.fills, ctx);
    expect(second.files[0]!.errors[0]).toContain("5 stored");
    expect(second.fills).toEqual(first.fills);
  });

  it("is an error the other way round too (an old partial export after the finished one)", () => {
    const done = importFiles([{ name: "Webull_Orders_Records.csv", text: DONE }], [], ctx);
    const late = importFiles([{ name: "Webull_Orders_Records(1).csv", text: MID }], done.fills, ctx);
    expect(late.files[0]!.errors).toHaveLength(1);
  });

  it("is no error for the same partial row exported twice, or for a finished export alone", () => {
    const twice = importFiles([{ name: "Webull_Orders_Records.csv", text: MID }, { name: "Webull_Orders_Records(1).csv", text: MID }], [], ctx);
    expect(twice.files.flatMap((f) => f.errors)).toEqual([]);
    expect(twice.fills).toHaveLength(1);
    const alone = importFiles([{ name: "Webull_Orders_Records.csv", text: DONE }], [], ctx);
    expect(alone.files[0]!.errors).toEqual([]);
    expect(alone.fills).toHaveLength(2);
    expect(alone.fills.every((f) => !("placedAt" in f))).toBe(true);
  });

  describe("through the CLI", () => {
    const dir = mkdtempSync(join(tmpdir(), "tj-partial-"));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    it("prints the same error and writes nothing", () => {
      const history = join(dir, "history");
      cpSync(join(FIXTURES, "history"), history, { recursive: true });
      writeFileSync(join(dir, "Webull_Orders_Records.csv"), MID);
      writeFileSync(join(dir, "Webull_Orders_Records(1).csv"), DONE);
      const out: string[] = [];
      const code = runImport([join(dir, "Webull_Orders_Records.csv"), join(dir, "Webull_Orders_Records(1).csv"), "--history-dir", history, "--now", IMPORTED_AT], (s) => out.push(s));
      expect(code).not.toBe(0);
      expect(out.join("\n")).toContain("same order seen with a different filled qty");
      expect(readdirSync(history).sort()).toEqual(["config.json", "overrides.json", "symbols.json"]);
    });
  });
});
