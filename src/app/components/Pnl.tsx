import type { GroupPnl } from "../../core/journal/journal";
import { money, pnlClass } from "../format";

/** A result in green / red, or an open position's mark in muted text ("open +19.50"), never colored as a result (#14). */
export function Pnl({ p, b }: { p: GroupPnl; b?: boolean }) {
  if (p.open) return <span className="muted" title="Still open: marked at the last price">open {money(p.value)}</span>;
  return <span className={`${pnlClass(p.value)} ${b ? "b" : ""}`}>{money(p.value)}</span>;
}

/**
 * With the BOOKED filter (Q67): what the trade booked on those dates. A still-open
 * trade's amount is its trims, marked TRIM; the whole trade's figure is in the title.
 */
export function BookedPnl({ value, open, whole, b }: { value: number; open: boolean; whole: GroupPnl; b?: boolean }) {
  const all = whole.value === null ? "—" : `${whole.open ? "open " : ""}${money(whole.value)}`;
  return (
    <span className={`${pnlClass(value)} ${b ? "b" : ""}`} title={`Booked on these dates (trims and closes). Whole trade: ${all}`}>
      {money(value)}{open && <span className="muted small"> TRIM</span>}
    </span>
  );
}
