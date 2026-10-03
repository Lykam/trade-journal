import { describe, expect, it } from "vitest";
import { detectBroker, guessLeveragedEtf, importFiles, mergeFills, resolveAccount } from "../src/core/normalize";
import { parseSchwab, parseSchwabDate, schwabAccountId } from "../src/core/normalize/schwab";
import { etOffset, parseMoney } from "../src/core/normalize/util";
import { parseWebull, parseWebullTime } from "../src/core/normalize/webull";
import { config, fixture, IMPORTED_AT, input, SCHWAB_A, SCHWAB_B, symbols, WEBULL_A, WEBULL_B } from "./helpers";

const wb = (rel: string) => parseWebull(fixture(rel), { account: "webull", source: "x.csv", importedAt: IMPORTED_AT });
const sc = (rel: string) => parseSchwab(fixture(rel), { account: "schwab-main", source: "x.csv", importedAt: IMPORTED_AT });

describe("helpers", () => {
  it("parses money with $, commas, sign and blanks", () => {
    expect(parseMoney("$1,234.50")).toBe(1234.5);
    expect(parseMoney("-$79.62")).toBe(-79.62);
    expect(parseMoney("")).toBe(0);
    expect(parseMoney("@2.5000000000")).toBe(2.5);
    expect(() => parseMoney("abc")).toThrow();
  });

  it("resolves the ET offset on both sides of the DST switch", () => {
    expect(etOffset("2025-03-08", "00:00:00")).toBe("-05:00");
    expect(etOffset("2025-03-10", "00:00:00")).toBe("-04:00");
    expect(etOffset("2025-11-03", "00:00:00")).toBe("-05:00");
  });

  it("detects the broker from the header row", () => {
    expect(detectBroker(fixture(WEBULL_A))).toBe("webull");
    expect(detectBroker(fixture(SCHWAB_A))).toBe("schwab"); // has a BOM
    expect(detectBroker("a,b,c\n1,2,3")).toBeNull();
  });
});

describe("Webull parser", () => {
  it("parses EDT/EST times into offsets", () => {
    expect(parseWebullTime("03/10/2025 09:31:05 EDT")).toBe("2025-03-10T09:31:05-04:00");
    expect(parseWebullTime("01/15/2025 09:45:05 EST")).toBe("2025-01-15T09:45:05-05:00");
    expect(() => parseWebullTime("01/15/2025 09:45:05 PST")).toThrow(/time zone/);
  });

  it("keeps Filled and Partial Filled rows, drops Cancelled", () => {
    const r = wb(WEBULL_A);
    expect(r.errors).toEqual([]);
    expect(r.rows).toBe(24);
    expect(r.skipped).toEqual({ cancelled: 1 });
    expect(r.fills).toHaveLength(23);
    const partial = r.fills.find((f) => f.symbol === "QXRB" && f.executedAt === "2025-03-10T10:00:00-04:00")!;
    expect(partial).toMatchObject({ qty: 3, price: 2, side: "buy", timePrecision: "second", fees: 0 });
  });

  it("orders oldest first and uses Avg Price", () => {
    const r = wb(WEBULL_A);
    expect(r.fills[0]).toMatchObject({ symbol: "PLMT", executedAt: "2025-01-15T09:45:05-05:00", price: 3 });
    expect(r.fills.find((f) => f.symbol === "RNDB" && f.side === "buy")!.price).toBe(2.1234);
  });

  it("keeps two identical fills in the same second with distinct ids and seq", () => {
    const twins = wb(WEBULL_A).fills.filter((f) => f.executedAt === "2025-03-11T09:30:01-04:00");
    expect(twins).toHaveLength(2);
    expect(twins[0]!.id).not.toBe(twins[1]!.id);
    expect(twins.map((f) => f.seq)).toEqual([0, 1]);
  });

  it("reads quoted names that contain commas", () => {
    expect(wb(WEBULL_A).fills.find((f) => f.symbol === "ORPH")!.name).toBe("ORPHAN, TEST INC");
  });

  it("gives the same ids in overlapping exports", () => {
    const a = new Set(wb(WEBULL_A).fills.map((f) => f.id));
    const b = wb(WEBULL_B).fills.map((f) => f.id);
    expect(b.filter((id) => a.has(id))).toHaveLength(a.size);
    expect(b).toHaveLength(a.size + 2);
  });
});

describe("Schwab parser", () => {
  it("uses the as-of date", () => {
    expect(parseSchwabDate("03/04/2025 as of 03/03/2025")).toBe("2025-03-03");
    expect(parseSchwabDate("03/04/2025")).toBe("2025-03-04");
  });

  it("finds the account id in the file name", () => {
    expect(schwabAccountId("Trading_XXX000_Transactions_20250315-170000.csv")).toBe("000");
    expect(schwabAccountId("export.csv")).toBeNull();
  });

  it("keeps Buy/Sell only and counts skipped rows", () => {
    const r = sc(SCHWAB_A);
    expect(r.errors).toEqual([]);
    expect(r.skipped).toEqual({ "MoneyLink Transfer": 1, "Qualified Dividend": 1 });
    expect(r.fills).toHaveLength(14);
  });

  it("dates fills at 00:00 ET with day precision and the right DST offset", () => {
    const r = sc(SCHWAB_A);
    expect(r.fills[0]).toMatchObject({ symbol: "SWGA", executedAt: "2025-03-03T00:00:00-05:00", timePrecision: "day", seq: 0 });
    expect(r.fills.find((f) => f.symbol === "BIGF")!.executedAt).toBe("2025-03-10T00:00:00-04:00");
  });

  it("strips $ and commas and reads fees", () => {
    const [buy, sell] = sc(SCHWAB_A).fills.filter((f) => f.symbol === "BIGF");
    expect(buy).toMatchObject({ price: 1234.5, fees: 0.65, side: "buy" });
    expect(sell).toMatchObject({ price: 1240, fees: 0.66, side: "sell" });
  });

  it("numbers seq oldest-first within each day", () => {
    const day = sc(SCHWAB_A).fills.filter((f) => f.executedAt.startsWith("2025-03-13"));
    expect(day.map((f) => [f.side, f.price, f.seq])).toEqual([
      ["buy", 20.2, 0], ["sell", 20, 1], ["buy", 20.5, 2], ["sell", 21, 3],
    ]);
  });
});

describe("accounts", () => {
  it("maps the Schwab file suffix through config and rejects unknown accounts", () => {
    expect(resolveAccount("schwab", "Trading_XXX000_Transactions_1.csv", config)).toBe("schwab-main");
    expect(() => resolveAccount("schwab", "Trading_XXX999_Transactions_1.csv", config)).toThrow(/999/);
    expect(resolveAccount("webull", "Webull_Orders_Records.csv", config)).toBe("webull");
  });

  it("rejects a file from an unknown account without importing it", () => {
    const r = importFiles([{ name: "Trading_XXX999_Transactions_1.csv", text: fixture(SCHWAB_A) }], [], { config, symbols, importedAt: IMPORTED_AT });
    expect(r.files[0]!.errors[0]).toMatch(/999/);
    expect(r.fills).toHaveLength(0);
  });
});

describe("dedupe", () => {
  const ctx = { config, symbols, importedAt: IMPORTED_AT };

  it("imports overlapping exports once", () => {
    const r = importFiles([input(WEBULL_A), input(WEBULL_B), input(SCHWAB_A), input(SCHWAB_B)], [], ctx);
    expect(r.files.map((f) => [f.added, f.duplicates])).toEqual([[23, 0], [2, 23], [14, 0], [5, 14]]);
    expect(r.fills).toHaveLength(44);
    expect(r.added).toHaveLength(44);
  });

  it("is idempotent on re-import", () => {
    const first = importFiles([input(WEBULL_B), input(SCHWAB_B)], [], ctx);
    const again = importFiles([input(WEBULL_A), input(WEBULL_B), input(SCHWAB_B)], first.fills, ctx);
    expect(again.added).toHaveLength(0);
    expect(again.fills).toEqual(first.fills);
  });

  it("keeps the first import's source and importedAt for duplicates", () => {
    const first = importFiles([input(WEBULL_A)], [], ctx);
    const later = importFiles([input(WEBULL_B)], first.fills, { ...ctx, importedAt: "2025-04-01T00:00:00Z" });
    const old = later.fills.find((f) => f.symbol === "PLMT")!;
    expect(old).toMatchObject({ source: "Webull_Orders_Records.csv", importedAt: IMPORTED_AT });
    expect(later.added.every((f) => f.importedAt === "2025-04-01T00:00:00Z")).toBe(true);
  });

  it("treats a Webull ticker change on past rows as the same fill and keeps the first symbol", () => {
    const r = importFiles([input(WEBULL_A), input(WEBULL_B)], [], ctx);
    expect(r.files[1]).toMatchObject({ added: 2, duplicates: 23, renames: { "PLMT → PLMN": 2 }, errors: [] });
    expect(r.fills.filter((f) => f.symbol === "PLMT")).toHaveLength(2);
    expect(r.fills.some((f) => f.symbol === "PLMN")).toBe(false);
  });

  it("uses the renamed symbol when the later export is the first one imported", () => {
    const r = importFiles([input(WEBULL_B), input(WEBULL_A)], [], ctx);
    expect(r.fills.filter((f) => f.symbol === "PLMN")).toHaveLength(2);
    expect(r.files[1]!.renames).toEqual({ "PLMN → PLMT": 2 });
  });

  it("flags the same id with different content as a conflict", () => {
    const parsed = wb(WEBULL_A).fills;
    const tampered = parsed.map((f, i) => (i === 0 ? { ...f, fees: 1 } : f));
    expect(mergeFills(parsed, tampered).conflicts).toHaveLength(1);
  });

  it("stores only contract fields", () => {
    const r = importFiles([input(WEBULL_A)], [], ctx);
    expect(Object.keys(r.fills[0]!)).not.toContain("name");
  });
});

describe("leveraged ETF detection", () => {
  it("guesses the underlying from common issuer name formats", () => {
    expect(guessLeveragedEtf("DIREXION DAILY FAKE BULL2X SHARES")).toMatchObject({ underlying: "FAKE", leverage: 2, direction: "long", issuer: "Direxion" });
    expect(guessLeveragedEtf("TRADR 2X LONG TSTX DAILYETF")).toMatchObject({ underlying: "TSTX", leverage: 2, issuer: "Tradr" });
    expect(guessLeveragedEtf("GRANITESHARES 2X LONG ABC DAILY ETF")).toMatchObject({ underlying: "ABC" });
    expect(guessLeveragedEtf("DIREXION DAILY ABC BEAR3X SHARES")).toMatchObject({ underlying: "ABC", leverage: 3, direction: "inverse" });
    expect(guessLeveragedEtf("DEFIANCE DAILY TARGET 2XLONG ABC ETF")).toMatchObject({ underlying: "ABC", leverage: 2, direction: "long", issuer: "Defiance" });
    expect(guessLeveragedEtf("LEVERAGE SHARES 2X LONG ABC DAILY ETF")).toMatchObject({ underlying: "ABC", issuer: "Leverage Shares" });
  });

  it("flags ETFs whose name doesn't say the underlying, with no guess", () => {
    expect(guessLeveragedEtf("GRANITESHARES 2X LONG TEST FUND SHARES")).toMatchObject({ underlying: null, leverage: 2 });
  });

  it("ignores ordinary names that merely contain BULL", () => {
    expect(guessLeveragedEtf("BULLDOG TEST HLDGS INC")).toBeNull();
    expect(guessLeveragedEtf("10X TEST WIDGETS INC")).toBeNull();
  });

  it("lists unmapped ETFs seen in an import", () => {
    const r = importFiles([input(SCHWAB_B), input(WEBULL_B)], [], { config, symbols, importedAt: IMPORTED_AT });
    expect(r.unmappedEtfs.map((e) => [e.symbol, e.guess.underlying])).toEqual([["TSTU", "TSTX"]]);
  });
});
