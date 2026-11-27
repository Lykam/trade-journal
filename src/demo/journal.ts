// Demo review-cadence entries (SPEC §6.7i), built mechanically like the demo
// reviews: fixed placeholder lines, no invented prose. Most trading days have a
// full daily entry, some only the morning, some none, so the calendar's REVIEW
// view shows every mark; ended weeks have a weekly review except every third.
import { buildEntry, entryPath, mondayOf, MOODS, QUESTIONS, type Period } from "../core/cadence/entries";
import { addDays } from "../core/calendar";
import { etDate } from "../core/normalize/util";
import type { ReviewFile } from "../core/types";

const LINE = "Demo placeholder: on the real site this holds what was written that day.";

function entry(period: Period, key: string, which: (h: string, i: number) => boolean, fields: Record<string, string> = {}): ReviewFile {
  const answers = Object.fromEntries(QUESTIONS[period].map((q, i) => [q.heading, which(q.heading, i) ? LINE : ""]));
  return { path: entryPath(period, key), markdown: buildEntry(period, key, { fields, answers }) };
}

export function demoJournal(now: string, tradingDays: string[]): ReviewFile[] {
  const today = etDate(now);
  const days = [...tradingDays].filter((d) => d <= today).sort();
  const out: ReviewFile[] = [];
  days.forEach((d, i) => {
    const kind = i % 7 === 3 ? "none" : i % 7 === 5 || d === today ? "morning" : "done";
    if (kind === "none") return;
    const mood = MOODS[i % MOODS.length]!;
    const morning = (h: string) => QUESTIONS.daily.find((q) => q.heading === h)!.part === "morning";
    out.push(kind === "done"
      ? entry("daily", d, () => true, { "Market Mood": mood, "Risk Plan Followed": i % 4 === 1 ? "NO" : "YES" })
      : entry("daily", d, morning, { "Market Mood": mood }));
  });
  const mondays = [...new Set(days.map(mondayOf))].filter((m) => addDays(m, 6) < today);
  mondays.forEach((m, i) => {
    if (i % 3 !== 1) out.push(entry("weekly", m, () => true));
  });
  const months = [...new Set(days.map((d) => d.slice(0, 7)))].filter((m) => m < today.slice(0, 7));
  for (const m of months.slice(0, -1)) out.push(entry("monthly", m, () => true));
  return out.sort((a, b) => a.path.localeCompare(b.path));
}
