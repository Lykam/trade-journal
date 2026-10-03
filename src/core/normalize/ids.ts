import type { Fill } from "../types";
import { shortHash } from "./util";

export type RawFill = Omit<Fill, "id">;

const PREFIX: Record<Fill["broker"], string> = { webull: "wb", schwab: "sc" };

/**
 * The fields that identify a fill (SPEC §4.3).
 * - Schwab: account|symbol|side|qty|price|executedAt. Rows have no time, so
 *   the symbol is needed to tell same-day fills apart.
 * - Webull: account|side|qty|price|executedAt|placedAt, without the symbol,
 *   because Webull rewrites the symbol on past rows after a ticker change
 *   (Q18). Placed + filled time to the second already pins the order.
 */
function identity(f: RawFill, placedAt?: string): string {
  return f.broker === "webull"
    ? [f.account, f.side, f.qty, f.price, f.executedAt, placedAt ?? ""].join("|")
    : [f.account, f.symbol, f.side, f.qty, f.price, f.executedAt].join("|");
}

/**
 * Give each fill its stable id: broker prefix + hash of its identity plus n,
 * where n counts otherwise identical rows in the same file. `raw` must be in
 * oldest-first order so that n is the same in every overlapping export.
 */
export function assignIds(raw: RawFill[], placedAt: Array<string | undefined> = []): Fill[] {
  const seen = new Map<string, number>();
  return raw.map((f, i) => {
    const key = identity(f, placedAt[i]);
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    return { id: `${PREFIX[f.broker]}-${shortHash(`${key}|${n}`)}`, ...f };
  });
}
