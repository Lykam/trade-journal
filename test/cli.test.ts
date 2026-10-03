import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runImport } from "../cli/import";
import { validate } from "../cli/lib/history";
import { runTrades } from "../cli/trades";
import { runVerify } from "../cli/verify";
import { FIXTURES, IMPORTED_AT, SCHWAB_A, SCHWAB_B, WEBULL_A, WEBULL_B } from "./helpers";

let dir: string;
let out: string[];
const log = (s: string) => out.push(s);
const files = [WEBULL_A, WEBULL_B, SCHWAB_A, SCHWAB_B].map((f) => join(FIXTURES, f));
const args = (...extra: string[]) => [...files, "--history-dir", dir, "--now", IMPORTED_AT, ...extra];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "trade-history-"));
  cpSync(join(FIXTURES, "history"), dir, { recursive: true });
  out = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("cli/import", () => {
  it("--dry-run previews without writing anything", () => {
    expect(runImport(args("--dry-run"), log)).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("dry run: nothing written");
    expect(text).toContain("Total: +44 new fills, 37 duplicates");
    expect(text).toMatch(/TSTU\s+TRADR 2X LONG TSTX DAILYETF\s+TSTX 2x long/);
    expect(text).toContain("UNMATCHED SELLS (2)");
    expect(readdirSync(dir).sort()).toEqual(["config.json", "overrides.json", "symbols.json"]);
  });

  it("writes fills, derived trades, schemas and raw archives that match the schemas", () => {
    expect(runImport(args(), log)).toBe(0);
    const fills = JSON.parse(readFileSync(join(dir, "fills/2025.json"), "utf8"));
    const derived = JSON.parse(readFileSync(join(dir, "derived/trades.json"), "utf8"));
    validate("fills", fills, "fills");
    validate("trades", derived, "trades");
    expect(fills.fills).toHaveLength(44);
    expect(derived).toMatchObject({ generated: true, generator: expect.stringMatching(/^trade-journal@/) });
    expect(readdirSync(join(dir, "schema"))).toHaveLength(5);
    expect(readdirSync(join(dir, "imports/raw"))).toHaveLength(4);
  });

  it("matches the golden output", async () => {
    runImport(args(), log);
    await expect(readFileSync(join(dir, "derived/trades.json"), "utf8")).toMatchFileSnapshot("fixtures/expected/trades.json");
    await expect(readFileSync(join(dir, "fills/2025.json"), "utf8")).toMatchFileSnapshot("fixtures/expected/fills-2025.json");
  });

  it("is idempotent: a second run adds nothing and rewrites nothing", () => {
    runImport(args(), log);
    out = [];
    runImport(args("--now", "2025-04-01T00:00:00Z"), log);
    const text = out.join("\n");
    expect(text).toContain("Total: +0 new fills");
    expect(text).toContain("TRADES: 0 new, 0 changed, 0 removed");
    expect(text).toContain("Wrote 0 file(s)");
  });

  it("refuses to write when a file has errors", () => {
    const bad = join(dir, "Trading_XXX999_Transactions_1.csv");
    cpSync(join(FIXTURES, SCHWAB_A), bad);
    expect(runImport([bad, "--history-dir", dir], log)).toBe(1);
    expect(out.join("\n")).toContain("Not writing");
    expect(existsSync(join(dir, "fills"))).toBe(false);
  });
});

describe("cli/trades and cli/verify", () => {
  beforeEach(() => {
    runImport(args(), () => {});
  });

  it("lists trades for a date and style", () => {
    runTrades(["--date", "2025-03-13", "--style", "swing", "--history-dir", dir], log);
    const text = out.join("\n");
    expect(text).toMatch(/FAKU→FAKE 2x/);
    expect(text).toContain("2 trades · 1W / 1L / 0BE");
    expect(text).not.toContain("HOLD"); // day trade
  });

  it("lists ideas", () => {
    runTrades(["--date", "2025-03-10", "--ideas", "--history-dir", dir], log);
    expect(out.join("\n")).toMatch(/2025-03-10\s+day\s+ZZTA\s+ZZTA\s+webull\s+2/);
  });

  it("verify passes when derived/trades.json is current", () => {
    expect(runVerify(["--history-dir", dir], log)).toBe(0);
    expect(out.join("\n")).toContain("is up to date");
  });
});
