// Webull partial fills exported mid-session (SPEC §4.3, Q45). A Webull export
// row is one order. While an order is working, its row shows the shares filled
// so far ("Partial Filled"); once it completes, the same row has a larger
// Filled, a new Avg Price and Filled Time, and so a different fill id. Merging
// both would double count, so the import reports an error instead.
//
// Fills don't store the order's placed time, but a Webull id hashes it (§4.3):
// a stored fill belongs to the same order as an incoming one when re-hashing
// the stored fill with the incoming placed time gives back its own id.
import type { Fill } from "../types";
import { fillIdFor } from "./ids";

/** How many identical same-file rows to try when re-hashing (the "|n" of §4.3). */
const MAX_OCCURRENCE = 4;

/**
 * Errors for incoming Webull fills whose order already has a stored fill with a
 * different id that this export no longer contains: the same order seen with a
 * different filled quantity.
 */
export function partialFillErrors(existing: Fill[], incoming: Array<Fill & { placedAt?: string }>): string[] {
  const incomingIds = new Set(incoming.map((f) => f.id));
  const existingIds = new Set(existing.map((f) => f.id));
  // Stored Webull fills this export doesn't list (a cumulative export lists every order it covers).
  const gone = existing.filter((f) => f.broker === "webull" && !incomingIds.has(f.id));
  if (!gone.length) return [];
  const errors: string[] = [];
  for (const f of incoming) {
    if (f.broker !== "webull" || !f.placedAt || existingIds.has(f.id)) continue;
    const placed = Date.parse(f.placedAt);
    const same = gone.find(
      (s) =>
        s.account === f.account && s.side === f.side && Date.parse(s.executedAt) >= placed &&
        Array.from({ length: MAX_OCCURRENCE }, (_, n) => fillIdFor(s, f.placedAt, n)).includes(s.id),
    );
    if (same) {
      errors.push(
        `same order seen with a different filled qty: likely a partial fill exported mid-session ` +
          `(${f.side} placed ${f.placedAt}: ${same.qty} stored as ${same.id}, ${f.qty} in this export). ` +
          "Remove the stored partial fill from trade-history, then import the finished export.",
      );
    }
  }
  return errors;
}
