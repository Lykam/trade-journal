import type { Fill } from "../types";

export interface MergeResult {
  fills: Fill[];
  added: Fill[];
  duplicates: number;
  /** Same id but different content: a hash collision or a changed export. Never silently merged. */
  conflicts: string[];
  warnings: string[];
}

const CONTENT_KEYS = ["broker", "account", "symbol", "side", "qty", "price", "fees", "executedAt"] as const;

export function compareFills(a: Fill, b: Fill): number {
  const ta = Date.parse(a.executedAt);
  const tb = Date.parse(b.executedAt);
  if (ta !== tb) return ta - tb;
  if (a.seq !== b.seq) return a.seq - b.seq;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Strip parser-only fields (e.g. `name`) so only the contract's fields are stored. */
export function toStoredFill(f: Fill): Fill {
  return {
    id: f.id, broker: f.broker, account: f.account, symbol: f.symbol, assetType: f.assetType,
    side: f.side, qty: f.qty, price: f.price, fees: f.fees, executedAt: f.executedAt,
    timePrecision: f.timePrecision, seq: f.seq, source: f.source, importedAt: f.importedAt,
  };
}

/**
 * Merge one parsed file into the existing fills (SPEC §4.3). Existing fills win
 * on id. `seq` is reconciled per (account, timestamp): when the incoming file
 * covers every fill already stored at that timestamp, its ordering is used for
 * all of them; otherwise new fills are appended after the stored ones.
 */
export function mergeFills(existing: Fill[], incoming: Fill[]): MergeResult {
  const byId = new Map(existing.map((f) => [f.id, { ...f }]));
  const added: Fill[] = [];
  const conflicts: string[] = [];
  const warnings: string[] = [];
  let duplicates = 0;

  const groupKey = (f: Fill) => `${f.account}|${f.executedAt}`;
  const storedByGroup = new Map<string, Fill[]>();
  for (const f of byId.values()) {
    const k = groupKey(f);
    storedByGroup.set(k, [...(storedByGroup.get(k) ?? []), f]);
  }
  const incomingByGroup = new Map<string, Fill[]>();
  for (const f of incoming) {
    const k = groupKey(f);
    incomingByGroup.set(k, [...(incomingByGroup.get(k) ?? []), f]);
  }

  for (const [k, inc] of incomingByGroup) {
    const stored = storedByGroup.get(k) ?? [];
    const incIds = new Set(inc.map((f) => f.id));
    const covered = stored.every((f) => incIds.has(f.id));
    let nextSeq = Math.max(-1, ...stored.map((f) => f.seq)) + 1;
    const newInGroup = inc.filter((f) => !byId.has(f.id));
    if (!covered && newInGroup.length > 0) {
      warnings.push(`${k.split("|")[1]}: new fills added after ${stored.length} stored fill(s) not in this file; check their order`);
    }
    for (const f of inc) {
      const prev = byId.get(f.id);
      if (prev) {
        const differs = CONTENT_KEYS.filter((key) => prev[key] !== f[key]);
        if (differs.length) {
          conflicts.push(`${f.id}: ${differs.map((d) => `${d} ${prev[d]} → ${f[d]}`).join(", ")}`);
          continue;
        }
        duplicates++;
        if (covered) prev.seq = f.seq;
        continue;
      }
      const stored = toStoredFill({ ...f, seq: covered ? f.seq : nextSeq++ });
      byId.set(f.id, stored);
      added.push(stored);
    }
  }

  return { fills: [...byId.values()].sort(compareFills), added, duplicates, conflicts, warnings };
}
