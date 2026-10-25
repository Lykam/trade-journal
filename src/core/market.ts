// When the prices workflow should run (SPEC §5.4). The clock check is pure; the
// holiday check (Yahoo's marketState) lives in build/market-open.ts.
import { addDays, dayOfWeek, etTime } from "./calendar";
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

/**
 * ET date of the latest regular session that has closed by `now` (weekdays, 16:00 ET).
 * Holidays aren't modeled (like Q21), so the day after a holiday asks for the holiday's import.
 */
export function lastSessionDate(nowIso: string): string {
  let d = etDate(nowIso);
  if (!(dayOfWeek(d) % 6 !== 0 && etTime(nowIso) >= "16:00")) d = addDays(d, -1);
  while (dayOfWeek(d) % 6 === 0) d = addDays(d, -1);
  return d;
}

/**
 * An import is behind when it happened before the latest closed session ended (that session's fills can't be in it).
 * `anyTimeThatDay` (Webull, Q71): day trades are mostly premarket, so an import at any time on the session's
 * date counts; it is behind only once that session has closed with no import that day.
 */
export function importBehind(importedAt: string, nowIso: string, opts: { anyTimeThatDay?: boolean } = {}): boolean {
  const session = lastSessionDate(nowIso);
  if (opts.anyTimeThatDay) return etDate(importedAt) < session;
  return etDate(importedAt) < session || (etDate(importedAt) === session && etTime(importedAt) < "16:00");
}
