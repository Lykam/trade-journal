import type { Fill } from "../types";
import { assignIds, type RawFill } from "./ids";
import { bump, etOffset, parseCsv, parseMoney, usDateToIso, type ParseResult } from "./util";

export const SCHWAB_HEADER = [
  "Date", "Action", "Symbol", "Description", "Quantity", "Price", "Fees & Comm", "Amount",
];

/** Account id embedded in a Schwab export name: Trading_XXX123_Transactions_… → "123". */
export function schwabAccountId(fileName: string): string | null {
  return /Trading_[A-Za-z]*(\d+)_Transactions/.exec(fileName)?.[1] ?? null;
}

/** "05/19/2026 as of 05/18/2026" → "2026-05-18" (the trade date). */
export function parseSchwabDate(raw: string): string {
  const parts = raw.split(/\s+as of\s+/i);
  return usDateToIso((parts[1] ?? parts[0] ?? "").trim());
}

export interface SchwabFill extends Fill {
  /** The export's Description column; used for ETF detection, not stored. */
  name: string;
}

export function parseSchwab(
  text: string,
  opts: { account: string; source: string; importedAt: string },
): ParseResult<SchwabFill> {
  const { rows } = parseCsv(text);
  const skipped: Record<string, number> = {};
  const errors: string[] = [];
  const raw: (RawFill & { name: string })[] = [];

  // Exports are newest-first; walk oldest-first (SPEC §4.2).
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]!;
    const line = i + 2;
    const action = (r["Action"] ?? "").trim();
    // Schwab appends a "Transactions Total" footer row to some exports.
    if (/total/i.test(r["Date"] ?? "")) {
      bump(skipped, "total row");
      continue;
    }
    if (action !== "Buy" && action !== "Sell") {
      bump(skipped, action || "(blank action)");
      continue;
    }
    try {
      const date = parseSchwabDate(r["Date"] ?? "");
      const symbol = (r["Symbol"] ?? "").trim().toUpperCase();
      if (!symbol) throw new Error("missing symbol");
      const qty = parseMoney(r["Quantity"]);
      if (qty <= 0) throw new Error(`bad quantity "${r["Quantity"]}"`);
      raw.push({
        broker: "schwab",
        account: opts.account,
        symbol,
        assetType: "equity",
        side: action === "Buy" ? "buy" : "sell",
        qty,
        price: parseMoney(r["Price"]),
        fees: Math.abs(parseMoney(r["Fees & Comm"])),
        executedAt: `${date}T00:00:00${etOffset(date, "00:00:00")}`,
        timePrecision: "day",
        seq: 0,
        source: opts.source,
        importedAt: opts.importedAt,
        name: (r["Description"] ?? "").trim(),
      });
    } catch (e) {
      errors.push(`line ${line}: ${(e as Error).message}`);
    }
  }

  // No times: seq is the oldest-first position within the trade date.
  const perDay = new Map<string, number>();
  for (const f of raw) {
    const n = perDay.get(f.executedAt) ?? 0;
    perDay.set(f.executedAt, n + 1);
    f.seq = n;
  }

  const fills = assignIds(raw.map(({ name: _n, ...f }) => f)).map((f, i) => ({ ...f, name: raw[i]!.name }));
  return { fills, rows: rows.length, skipped, errors };
}
