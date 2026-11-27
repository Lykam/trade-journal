// Review cadence (SPEC §6.7i, Q89–Q92): daily, weekly and monthly journal
// entries in Playbook's Journal/ folder. One markdown file per period: a title,
// `**Field:**` header lines, then one `## Heading` section per question.
// Hand edits parse too, and sections the app doesn't know are kept on save.
import { addDays, weekStart } from "../calendar";
import type { ReviewFile } from "../types";

export type Period = "daily" | "weekly" | "monthly";

export const JOURNAL_DIR = "Journal/";
const DIRS: Record<Period, string> = { daily: "Journal/Daily/", weekly: "Journal/Weekly/", monthly: "Journal/Monthly/" };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** The key of a period: a date, the week's Monday, or YYYY-MM. */
export function validKey(period: Period, key: string): boolean {
  if (period === "monthly") return MONTH_RE.test(key);
  if (!DATE_RE.test(key) || Number.isNaN(Date.parse(`${key}T00:00:00Z`))) return false;
  return period === "daily" || mondayOf(key) === key;
}

/** Weeks are always keyed by their Monday, whatever weekStartsOn says (§6.7i). */
export const mondayOf = (date: string) => weekStart(date, "monday");
export const weekDays = (monday: string) => Array.from({ length: 7 }, (_, i) => addDays(monday, i));

export const entryPath = (period: Period, key: string) => `${DIRS[period]}${key}.md`;

/** The period and key of a Journal/ path, or null for anything else. */
export function entryKeyOf(path: string): { period: Period; key: string } | null {
  for (const period of ["daily", "weekly", "monthly"] as Period[]) {
    const dir = DIRS[period];
    if (!path.startsWith(dir)) continue;
    const key = path.slice(dir.length).replace(/\.md$/i, "");
    return path.toLowerCase().endsWith(".md") && validKey(period, key) ? { period, key } : null;
  }
  return null;
}

export interface Question {
  /** Section heading, written as `## <heading>`. */
  heading: string;
  hint: string;
  /** Daily only: which half of the day the question belongs to. */
  part?: "morning" | "report";
}

export const MOODS = ["STRONG", "CHOPPY", "WEAK"] as const;
export type Mood = (typeof MOODS)[number];

export const QUESTIONS: Record<Period, Question[]> = {
  daily: [
    { heading: "Market Going In", hint: "Sentiment, futures, overnight news. What were people thinking coming into the day?", part: "morning" },
    { heading: "Themes & Sectors in Play", hint: "Which themes, sectors and names are moving, and why today?", part: "morning" },
    { heading: "Expectations & Plan", hint: "What you expect, what you'll trade, and what would change the plan.", part: "morning" },
    { heading: "Best Trade & Why", hint: "What made it work? Was it the version of the setup you've studied?", part: "report" },
    { heading: "Worst Trade & See-It Moment", hint: "When should you have known? Before entry, right after, halfway to the stop?", part: "report" },
    { heading: "Missed", hint: "The best opportunity you didn't take, and why.", part: "report" },
    { heading: "Forced", hint: "Any trade that wasn't a setup: boredom, revenge, FOMO?", part: "report" },
    { heading: "Fix for Tomorrow", hint: "One thing to do differently tomorrow.", part: "report" },
  ],
  weekly: [
    { heading: "Setup That Worked", hint: "Which setup paid this week, and what did its best versions share?" },
    { heading: "Mistake That Showed Up Twice", hint: "The error that repeated. What triggers it?" },
    { heading: "What I Did Well", hint: "Winners teach you what to push." },
    { heading: "One Focus for Next Week", hint: "One thing, specific enough to check next Friday." },
  ],
  monthly: [
    { heading: "Keep", hint: "What the numbers say is working." },
    { heading: "Cut", hint: "Trades, times or habits the numbers say are costing you." },
    { heading: "Earned a Size Increase?", hint: "Has execution, edge and data earned more size anywhere? Where not?" },
    { heading: "Focus Next Month", hint: "One thing to work on." },
  ],
};

/** Header fields per period, in file order (after the period's own line). */
export const HEADER_FIELDS: Record<Period, string[]> = {
  daily: ["Market Mood", "Snapshot", "Risk Plan Followed"],
  weekly: [],
  monthly: [],
};

const KEY_FIELD: Record<Period, string> = { daily: "Date", weekly: "Week", monthly: "Month" };

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export function entryTitle(period: Period, key: string): string {
  if (period === "daily") return `Daily Journal — ${key}`;
  if (period === "weekly") return `Weekly Review — week of ${key}`;
  return `Monthly Review — ${MONTHS[Number(key.slice(5)) - 1]} ${key.slice(0, 4)}`;
}

export interface Entry {
  path: string;
  period: Period;
  key: string;
  /** Header fields by name as written (e.g. "Market Mood"), trimmed. */
  fields: Map<string, string>;
  /** Sections in file order, bodies trimmed. */
  sections: Array<{ heading: string; body: string }>;
  markdown: string;
}

const FIELD_RE = /^\*\*([^*]+?):\*\*\s*(.*)$/;
const norm = (s: string) => s.trim().toLowerCase();

export function parseEntry(file: ReviewFile): Entry | null {
  const at = entryKeyOf(file.path);
  if (!at) return null;
  const fields = new Map<string, string>();
  const sections: Entry["sections"] = [];
  let current: { heading: string; lines: string[] } | null = null;
  const close = () => {
    if (current) sections.push({ heading: current.heading, body: current.lines.join("\n").replace(/<!--[\s\S]*?-->/g, "").trim() });
  };
  for (const line of file.markdown.split(/\r?\n/)) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h && !line.startsWith("###")) {
      close();
      current = { heading: h[1]!, lines: [] };
    } else if (current) current.lines.push(line);
    else {
      const m = FIELD_RE.exec(line.trim());
      if (m) fields.set(m[1]!.trim(), m[2]!.trim());
    }
  }
  close();
  return { path: file.path, ...at, fields, sections, markdown: file.markdown };
}

/** A header field, matched case-insensitively. */
export function field(e: Entry | null | undefined, name: string): string {
  if (!e) return "";
  for (const [k, v] of e.fields) if (norm(k) === norm(name)) return v;
  return "";
}

/** A section's body, matched case-insensitively; "" when absent. */
export function answer(e: Entry | null | undefined, heading: string): string {
  return e?.sections.find((s) => norm(s.heading) === norm(heading))?.body ?? "";
}

export const moodOf = (e: Entry | null | undefined): Mood | null => {
  const v = field(e, "Market Mood").toUpperCase();
  return (MOODS as readonly string[]).includes(v) ? (v as Mood) : null;
};

export interface EntryDraft {
  fields: Record<string, string>;
  answers: Record<string, string>;
}

export function draftOf(period: Period, e: Entry | null | undefined): EntryDraft {
  return {
    fields: Object.fromEntries(HEADER_FIELDS[period].map((f) => [f, field(e, f)])),
    answers: Object.fromEntries(QUESTIONS[period].map((q) => [q.heading, answer(e, q.heading)])),
  };
}

const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ").trim();

/**
 * The whole file. Empty fields and sections are left out; sections of `before`
 * the app doesn't ask about are kept, after the known ones.
 */
export function buildEntry(period: Period, key: string, d: EntryDraft, before?: Entry | null): string {
  const lines = [`# ${entryTitle(period, key)}`, "", `**${KEY_FIELD[period]}:** ${key}`];
  for (const f of HEADER_FIELDS[period]) {
    const v = oneLine(d.fields[f] ?? "");
    if (v) lines.push(`**${f}:** ${v}`);
  }
  const known = new Set(QUESTIONS[period].map((q) => norm(q.heading)));
  const sections = [
    ...QUESTIONS[period].map((q) => ({ heading: q.heading, body: (d.answers[q.heading] ?? "").trim() })),
    ...(before?.sections.filter((s) => !known.has(norm(s.heading))) ?? []),
  ].filter((s) => s.body);
  for (const s of sections) lines.push("", `## ${s.heading}`, "", s.body.replace(/\r\n/g, "\n"));
  return `${lines.join("\n")}\n`;
}

export type DayStatus = "none" | "morning" | "done";

/** Morning once any morning field is written, done once any report-card field is (§6.7i). */
export function dayStatus(e: Entry | null | undefined): DayStatus {
  if (!e) return "none";
  const has = (part: "morning" | "report") => QUESTIONS.daily.some((q) => q.part === part && answer(e, q.heading));
  if (has("report") || field(e, "Risk Plan Followed")) return "done";
  if (has("morning") || moodOf(e)) return "morning";
  return "none";
}

/** A period's entry has anything written in it. */
export const written = (e: Entry | null | undefined) => Boolean(e && e.sections.some((s) => s.body));

export interface Entries {
  daily: Map<string, Entry>;
  weekly: Map<string, Entry>;
  monthly: Map<string, Entry>;
}

export function readEntries(files: ReviewFile[] | undefined): Entries {
  const out: Entries = { daily: new Map(), weekly: new Map(), monthly: new Map() };
  for (const f of files ?? []) {
    const e = parseEntry(f);
    if (e) out[e.period].set(e.key, e);
  }
  return out;
}
