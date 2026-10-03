import type { Fill } from "../types";
import { shortHash } from "./util";

export type RawFill = Omit<Fill, "id">;

const PREFIX: Record<Fill["broker"], string> = { webull: "wb", schwab: "sc" };

/**
 * Give each fill its stable id (SPEC §4.3): broker prefix + hash of
 * account|symbol|side|qty|price|executedAt|n, where n counts otherwise
 * identical rows in the same file. `raw` must be in oldest-first order so
 * that n is the same in every overlapping export.
 */
export function assignIds(raw: RawFill[]): Fill[] {
  const seen = new Map<string, number>();
  return raw.map((f) => {
    const key = [f.account, f.symbol, f.side, f.qty, f.price, f.executedAt].join("|");
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    return { id: `${PREFIX[f.broker]}-${shortHash(`${key}|${n}`)}`, ...f };
  });
}
