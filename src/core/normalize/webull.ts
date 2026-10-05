import type { Fill } from "../types";
import { assignIds, type RawFill } from "./ids";
import { bump, parseCsv, parseMoney, usDateToIso, type ParseResult } from "./util";

export const WEBULL_HEADER = [
  "Name", "Symbol", "Side", "Status", "Filled", "Total Qty", "Price",
  "Avg Price", "Time-in-Force", "Placed Time", "Filled Time",
];

const TZ_OFFSETS: Record<string, string> = { EDT: "-04:00", EST: "-05:00" };

/** "09/24/2026 08:45:05 EDT" → "2026-09-24T08:45:05-04:00". */
export function parseWebullTime(raw: string): string {
  const m = /^(\d{2}\/\d{2}\/\d{4}) (\d{2}:\d{2}:\d{2}) ([A-Z]{3,4})$/.exec(raw.trim());
  if (!m) throw new Error(`bad Webull time: "${raw}"`);
  const offset = TZ_OFFSETS[m[3]!];
  if (!offset) throw new Error(`unknown time zone "${m[3]}" in "${raw}"`);
  return `${usDateToIso(m[1]!)}T${m[2]}${offset}`;
}

export interface WebullFill extends Fill {
  /** The export's Name column; used for ETF detection, not stored. */
  name: string;
  /** The order's Placed Time, part of the id; used to spot partial fills (partialFillErrors), not stored. */
  placedAt: string;
}

export function parseWebull(
  text: string,
  opts: { account: string; source: string; importedAt: string },
): ParseResult<WebullFill> {
  const { rows } = parseCsv(text);
  const skipped: Record<string, number> = {};
  const errors: string[] = [];
  const raw: (RawFill & { name: string; placedAt: string })[] = [];

  // Exports are newest-first; walk oldest-first so seq and id occurrence
  // indexes are the same in every overlapping export.
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]!;
    const line = i + 2;
    const status = (r["Status"] ?? "").trim();
    if (status !== "Filled" && status !== "Partial Filled") {
      bump(skipped, status === "Cancelled" ? "cancelled" : `status: ${status || "(blank)"}`);
      continue;
    }
    try {
      const qty = parseMoney(r["Filled"]);
      if (qty <= 0) {
        bump(skipped, "zero filled");
        continue;
      }
      const side = (r["Side"] ?? "").trim().toLowerCase();
      if (side !== "buy" && side !== "sell") throw new Error(`unsupported side "${r["Side"]}"`);
      const symbol = (r["Symbol"] ?? "").trim().toUpperCase();
      if (!symbol) throw new Error("missing symbol");
      raw.push({
        broker: "webull",
        account: opts.account,
        symbol,
        assetType: "equity",
        side,
        qty,
        price: parseMoney(r["Avg Price"]),
        fees: 0,
        executedAt: parseWebullTime(r["Filled Time"] ?? ""),
        timePrecision: "second",
        seq: 0,
        source: opts.source,
        importedAt: opts.importedAt,
        name: (r["Name"] ?? "").trim(),
        placedAt: r["Placed Time"]?.trim() ? parseWebullTime(r["Placed Time"]) : "",
      });
    } catch (e) {
      errors.push(`line ${line}: ${(e as Error).message}`);
    }
  }

  // seq orders fills that share a timestamp (oldest first).
  const perTime = new Map<string, number>();
  for (const f of raw) {
    const n = perTime.get(f.executedAt) ?? 0;
    perTime.set(f.executedAt, n + 1);
    f.seq = n;
  }

  const fills = assignIds(
    raw.map(({ name: _n, placedAt: _p, ...f }) => f),
    raw.map((f) => f.placedAt),
  ).map((f, i) => ({ ...f, name: raw[i]!.name, placedAt: raw[i]!.placedAt }));
  return { fills, rows: rows.length, skipped, errors };
}
