// When the prices workflow should run (SPEC §5.4). The clock check is pure; the
// holiday check (Yahoo's marketState) lives in build/market-open.ts.
import { dayOfWeek, etTime } from "./calendar";
import { etDate } from "./normalize/util";

export type MarketWindow = "regular" | "post-close" | "closed";

/** Regular session: weekdays 09:30–16:00 ET. Post-close: weekdays 16:00–17:00 ET, for the run that captures the close. */
export function marketWindow(nowIso: string): MarketWindow {
  const dow = dayOfWeek(etDate(nowIso));
  if (dow === 0 || dow === 6) return "closed";
  const t = etTime(nowIso);
  if (t >= "09:30" && t < "16:00") return "regular";
  if (t >= "16:00" && t < "17:00") return "post-close";
  return "closed";
}

/**
 * Should a scheduled prices run go ahead? `state` / `lastTradeIso` come from a
 * reference quote (null when the lookup failed, in which case the clock decides,
 * since a wasted run is cheaper than a missed one).
 */
export function shouldPrice(
  mode: "regular" | "post-close",
  nowIso: string,
  ref: { state: string | null; lastTradeIso: string | null } | null,
): { run: boolean; why: string } {
  const w = marketWindow(nowIso);
  if (w !== mode) return { run: false, why: mode === "regular" ? "outside regular hours" : "not the post-close window" };
  if (!ref) return { run: true, why: "market status unknown; running on the clock" };
  if (mode === "regular") return ref.state === "REGULAR" ? { run: true, why: "market open" } : { run: false, why: "market closed today (holiday?)" };
  return ref.lastTradeIso && etDate(ref.lastTradeIso) === etDate(nowIso)
    ? { run: true, why: "post-close run" }
    : { run: false, why: "no session today (holiday?)" };
}
