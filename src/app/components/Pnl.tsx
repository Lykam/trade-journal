import type { GroupPnl } from "../../core/journal/journal";
import { money, pnlClass } from "../format";

/** A result in green / red, or an open position's mark in muted text ("open +19.50"), never colored as a result (#14). */
export function Pnl({ p, b }: { p: GroupPnl; b?: boolean }) {
  if (p.open) return <span className="muted" title="Still open: marked at the last price">open {money(p.value)}</span>;
  return <span className={`${pnlClass(p.value)} ${b ? "b" : ""}`}>{money(p.value)}</span>;
}
