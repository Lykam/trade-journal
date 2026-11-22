// Plays (SPEC §6.7e, Q84): the owner's playbook of setups, one markdown file per
// play in Playbook's Plays/ folder, written from the PLAYS page. Pure: parsing,
// building and path picking only. The commits live in ./commit.ts, so the demo
// build never pulls in GitHub code.
//
//   # Gap and Go
//
//   **Created:** 2026-11-21
//   **Markets:** US small caps, Premarket gappers
//   **Timeframes:** 1m, 5m
//   **Credit:** Jane Trader            (only on someone else's play, Q87)
//   **Source:** https://youtu.be/…     (optional, with a credit)
//   **Entry Tactics:**
//   - First 1m candle to make a new high
//   - Break of premarket high on volume
//
//   ## Write-up
//
//   Long description… ![chart](../Images/plays/gap-and-go/2026-11-21-1.png)
//
//   ## Update — 2026-12-03 · Works better in a strong tape
//
//   More notes and images, appended one at a time.
import { IMAGE_EXT_RE, UPLOAD_TYPES } from "../reviews/images";
import type { ReviewFile } from "../types";

export const PLAYS_DIR = "Plays/";
export const PLAY_IMAGES_DIR = "Images/plays/";
export const WRITEUP_TITLE = "Write-up";

/**
 * Plays and routines (Q88), the owner's and other traders' (LIBRARY, Q87),
 * share one file shape and one page; a kind names the folder, the image folder
 * and the labels of the three header lists (stored in PlayHeader as markets,
 * timeframes and tactics).
 */
export interface PlayKind {
  id: "plays" | "routines" | "library" | "library-routines";
  /** For commit messages: "Add library play: …". */
  noun: string;
  dir: string;
  imagesDir: string;
  labels: readonly [string, string, string];
  /** Steps are written "1. …" (order matters); entry tactics "- …". */
  ordered: boolean;
  /** "never": the owner's (PLAYS tab). "always": another trader's, credited (LIBRARY tab). */
  credit: "never" | "always";
}

export const PLAYS: PlayKind = { id: "plays", noun: "play", dir: PLAYS_DIR, imagesDir: PLAY_IMAGES_DIR, labels: ["Markets", "Timeframes", "Entry Tactics"], ordered: false, credit: "never" };
export const LIBRARY: PlayKind = { id: "library", noun: "library play", dir: "Library/", imagesDir: "Images/library/", labels: ["Markets", "Timeframes", "Entry Tactics"], ordered: false, credit: "always" };
export const ROUTINES: PlayKind = { id: "routines", noun: "routine", dir: "Routines/", imagesDir: "Images/routines/", labels: ["When", "Tools", "Steps"], ordered: true, credit: "never" };
export const LIBRARY_ROUTINES: PlayKind = { id: "library-routines", noun: "library routine", dir: "Library/Routines/", imagesDir: "Images/library-routines/", labels: ["When", "Tools", "Steps"], ordered: true, credit: "always" };

export interface PlayHeader {
  name: string;
  markets: string[];
  timeframes: string[];
  tactics: string[];
  /** Someone else's play or routine: who it's from (Q87). Absent on the owner's own. */
  credit?: string;
  /** Where it's from, for someone else's play: a link (a YouTube video, a post) or text (a book). */
  source?: string;
}

/** A play credited to someone else. */
export const isTheirs = (h: PlayHeader) => Boolean(h.credit?.trim());

/** Source text split into plain text and links, so the URLs can be shown clickable. */
export function sourceParts(source: string): Array<{ text: string; url: boolean }> {
  return source
    .split(/(https?:\/\/[^\s<>()]+)/)
    .filter(Boolean)
    .map((text) => ({ text, url: /^https?:\/\//.test(text) }));
}

export interface PlaySection {
  /** The heading as written, without "## ". */
  title: string;
  /** "Write-up" for the first section; an update's YYYY-MM-DD from its heading; else null. */
  kind: "writeup" | "update" | "other";
  date: string | null;
  /** The update's own label after the date ("Update — 2026-12-03 · <label>"), if any. */
  label: string | null;
  body: string;
}

export interface Play {
  path: string;
  slug: string;
  header: PlayHeader;
  created: string | null;
  sections: PlaySection[];
  /** The newest date among Created and the updates: the list's LAST UPDATED. */
  updated: string | null;
  markdown: string;
}

const FIELD_RE = /^\*\*([^*:]+):\*\*[ \t]*(.*)$/;
const DATE_RE = /\d{4}-\d{2}-\d{2}/;
/** A list item: "- ", "* ", "+ " or "1. " / "1) ". */
const ITEM_RE = /^\s*(?:[-*+]|\d+[.)])\s+/;
const UPDATE_RE =/^Update\s*[—–-]\s*(\d{4}-\d{2}-\d{2})(?:\s*[·:|—–-]\s*(.+))?$/i;

/** "Plays/gap-and-go.md" → "gap-and-go". */
export const playSlugOf = (path: string) => (path.split("/").pop() ?? path).replace(/\.md$/i, "");

const splitList = (v: string) => v.split(",").map((s) => s.trim()).filter(Boolean);

/** Trim, drop blanks and case-insensitive repeats, keeping the first spelling. */
export function cleanList(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    const s = raw.replace(/\s+/g, " ").trim();
    if (!s || seen.has(s.toLowerCase())) continue;
    seen.add(s.toLowerCase());
    out.push(s);
  }
  return out;
}

/** Markets and timeframes are written comma-separated, so a comma can't be inside one. */
export const parseCommaList = (v: string) => cleanList(splitList(v));



export function parsePlay(file: ReviewFile, kind: PlayKind = PLAYS): Play {
  const [aKey, bKey, listKey] = kind.labels.map((l) => l.toLowerCase());
  const lines = file.markdown.replace(/\r\n?/g, "\n").split("\n");
  const firstSection = lines.findIndex((l) => /^## /.test(l));
  const head = firstSection < 0 ? lines : lines.slice(0, firstSection);
  const header: PlayHeader = { name: "", markets: [], timeframes: [], tactics: [] };
  let created: string | null = null;
  for (let i = 0; i < head.length; i++) {
    const l = head[i]!;
    const title = /^# (.+)$/.exec(l);
    if (title && !header.name) header.name = title[1]!.trim();
    const f = FIELD_RE.exec(l.trim());
    if (!f) continue;
    const key = f[1]!.trim().toLowerCase();
    const value = f[2]!.trim();
    if (key === aKey) header.markets = parseCommaList(value);
    else if (key === bKey) header.timeframes = parseCommaList(value);
    else if (key === "created") created = DATE_RE.exec(value)?.[0] ?? null;
    else if ((key === "credit" || key === "source") && value) header[key] = value;
    else if (key === listKey) {
      const tactics = value ? [value] : [];
      while (i + 1 < head.length && ITEM_RE.test(head[i + 1]!)) tactics.push(head[++i]!.replace(ITEM_RE, ""));
      header.tactics = cleanList(tactics);
    }
  }
  if (!header.name) header.name = playSlugOf(file.path);

  const sections: PlaySection[] = [];
  if (firstSection >= 0) {
    let cur: { title: string; body: string[] } | null = null;
    const flush = () => {
      if (cur) sections.push(sectionOf(cur.title, cur.body.join("\n").trim()));
    };
    for (const l of lines.slice(firstSection)) {
      const h = /^## (.+)$/.exec(l);
      if (h) {
        flush();
        cur = { title: h[1]!.trim(), body: [] };
      } else cur!.body.push(l);
    }
    flush();
  }
  const dates = [created, ...sections.map((s) => s.date)].filter((d): d is string => d !== null).sort();
  return { path: file.path, slug: playSlugOf(file.path), header, created, sections, updated: dates.at(-1) ?? null, markdown: file.markdown };
}

function sectionOf(title: string, body: string): PlaySection {
  if (title.toLowerCase() === WRITEUP_TITLE.toLowerCase()) return { title, kind: "writeup", date: null, label: null, body };
  const u = UPDATE_RE.exec(title);
  if (u) return { title, kind: "update", date: u[1]!, label: u[2]?.trim() || null, body };
  return { title, kind: "other", date: DATE_RE.exec(title)?.[0] ?? null, label: null, body };
}

/** Every play, newest update first, then by name. */
export function readPlays(files: ReviewFile[] | undefined, kind: PlayKind = PLAYS): Play[] {
  return (files ?? [])
    .map((f) => parsePlay(f, kind))
    .sort((a, b) => (b.updated ?? "").localeCompare(a.updated ?? "") || a.header.name.localeCompare(b.header.name));
}

/** Markets used across plays, most used first, for the form's suggestions. */
export function marketCounts(plays: Play[]): Array<{ market: string; n: number }> {
  const m = new Map<string, { market: string; n: number }>();
  for (const p of plays) for (const x of p.header.markets) {
    const k = x.toLowerCase();
    const e = m.get(k) ?? { market: x, n: 0 };
    e.n++;
    m.set(k, e);
  }
  return [...m.values()].sort((a, b) => b.n - a.n || a.market.localeCompare(b.market));
}

/** Whose plays to list: all, the owner's, everyone else's, or one person's ("by:<name>"). */
export type PlayWho = "all" | "mine" | "theirs" | `by:${string}`;

/** People credited across plays, most plays first. */
export function creditCounts(plays: Play[]): Array<{ credit: string; n: number }> {
  const m = new Map<string, { credit: string; n: number }>();
  for (const p of plays) {
    const c = p.header.credit?.trim();
    if (!c) continue;
    const e = m.get(c.toLowerCase()) ?? { credit: c, n: 0 };
    e.n++;
    m.set(c.toLowerCase(), e);
  }
  return [...m.values()].sort((a, b) => b.n - a.n || a.credit.localeCompare(b.credit));
}

function whoMatches(h: PlayHeader, who: PlayWho): boolean {
  if (who === "all") return true;
  if (who === "mine") return !isTheirs(h);
  if (who === "theirs") return isTheirs(h);
  return h.credit?.trim().toLowerCase() === who.slice(3).toLowerCase();
}

/** Every word must appear in the name, markets, timeframes, tactics or text (credit and source included). */
export function filterPlays(plays: Play[], q: string, market: string | null, who: PlayWho = "all"): Play[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  return plays.filter((p) => {
    if (!whoMatches(p.header, who)) return false;
    if (market && !p.header.markets.some((m) => m.toLowerCase() === market.toLowerCase())) return false;
    if (!words.length) return true;
    const hay = [p.header.name, ...p.header.markets, ...p.header.timeframes, ...p.header.tactics, p.markdown].join("\n").toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

// ---------------------------------------------------------------------------
// Writing

export class PlayError extends Error {
  override name = "PlayError";
}

/** Returns an error message, or null when the header can be saved. */
export function checkHeader(h: PlayHeader): string | null {
  if (!h.name.trim()) return "Give the play a name.";
  if (/[\r\n]/.test(h.name)) return "The name must be one line.";
  if (h.name.trim().length > 80) return "Keep the name under 80 characters.";
  if (h.tactics.some((t) => /[\r\n]/.test(t))) return "Each entry tactic must be one line.";
  if (h.credit !== undefined && !h.credit.trim()) return "Say whose play it is.";
  if (/[\r\n]/.test(h.credit ?? "") || /[\r\n]/.test(h.source ?? "")) return "Credit and source must each be one line.";
  if ((h.credit ?? "").trim().length > 80) return "Keep the credit under 80 characters.";
  return null;
}

/** The header block: everything above the first "## " section. */
export function buildHeader(h: PlayHeader, created: string, kind: PlayKind = PLAYS): string {
  const lines = [`# ${h.name.trim()}`, "", `**Created:** ${created}`];
  if (isTheirs(h)) {
    lines.push(`**Credit:** ${h.credit!.trim()}`);
    if (h.source?.trim()) lines.push(`**Source:** ${h.source.trim()}`);
  }
  const [a, b, list] = kind.labels;
  lines.push(`**${a}:** ${cleanList(h.markets).join(", ")}`, `**${b}:** ${cleanList(h.timeframes).join(", ")}`, `**${list}:**`);
  cleanList(h.tactics).forEach((t, i) => lines.push(kind.ordered ? `${i + 1}. ${t}` : `- ${t}`));
  return `${lines.join("\n")}\n`;
}

export const updateTitle = (date: string, label: string) => `Update — ${date}${label.trim() ? ` · ${label.trim().replace(/[\r\n]+/g, " ")}` : ""}`;

const section = (title: string, body: string) => `## ${title}\n\n${body.trim() || "(nothing written yet)"}\n`;

/** A new play's file: the header and its Write-up. */
export function buildPlayMarkdown(h: PlayHeader, created: string, writeup: string, kind: PlayKind = PLAYS): string {
  return `${buildHeader(h, created, kind)}\n${section(WRITEUP_TITLE, writeup)}`;
}

/** Swap the header block, keeping every section exactly as it is in the file. */
export function replaceHeader(markdown: string, h: PlayHeader, fallbackCreated: string, kind: PlayKind = PLAYS): string {
  const text = markdown.replace(/\r\n?/g, "\n");
  const created = parsePlay({ path: "x.md", markdown: text }).created ?? fallbackCreated;
  const at = text.search(/^## /m);
  const rest = at < 0 ? "" : text.slice(at);
  return `${buildHeader(h, created, kind)}${rest ? `\n${rest}` : ""}`;
}

/** Add a dated update section at the end of the file. */
export function appendSection(markdown: string, title: string, body: string): string {
  const text = markdown.replace(/\r\n?/g, "\n").replace(/\s+$/, "");
  return `${text}\n\n${section(title, body)}`;
}

/**
 * Replace one section's body, found by its index and heading: if the file
 * changed so that heading isn't there any more, throw instead of editing the
 * wrong section.
 */
export function replaceSection(markdown: string, index: number, title: string, body: string): string {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const starts = lines.flatMap((l, i) => (/^## /.test(l) ? [i] : []));
  const start = starts[index];
  if (start === undefined || lines[start]!.slice(3).trim() !== title) throw new PlayError(`The section “${title}” changed in Playbook since this page loaded. Reload and try again.`);
  const end = starts[index + 1] ?? lines.length;
  const next = [...lines.slice(0, start), ...section(title, body).replace(/\n$/, "").split("\n"), ...(end < lines.length ? [""] : []), ...lines.slice(end)];
  return `${next.join("\n").replace(/\s+$/, "")}\n`;
}

/** "Gap and Go!" → "gap-and-go". */
export function slugify(name: string): string {
  const s = name.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/, "");
  return s || "play";
}

/** "Plays/<slug>.md", adding -2, -3, … when taken (case-insensitively). */
export function playPath(existing: Iterable<string>, name: string, kind: PlayKind = PLAYS): string {
  const taken = new Set([...existing].map((p) => p.toLowerCase()));
  const stem = `${kind.dir}${slugify(name)}`;
  let path = `${stem}.md`;
  for (let n = 2; taken.has(path.toLowerCase()); n++) path = `${stem}-${n}.md`;
  return path;
}

/** "Images/plays/<slug>/<date>-<n>.<ext>": the next free n that day, in any image format. */
export function playImagePath(existing: Iterable<string>, slug: string, date: string, ext: string, kind: PlayKind = PLAYS): string {
  if (!/^[a-z0-9-]+$/.test(slug)) throw new PlayError(`Bad play name: ${slug}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new PlayError(`Bad date: ${date}`);
  if (!Object.values(UPLOAD_TYPES).includes(ext)) throw new PlayError(`Unsupported image type: ${ext}`);
  const dir = `${kind.imagesDir}${slug}/`;
  const taken = new Set([...existing].filter((p) => p.startsWith(dir) && IMAGE_EXT_RE.test(p)).map((p) => p.slice(dir.length).replace(IMAGE_EXT_RE, "").toLowerCase()));
  let n = 1;
  while (taken.has(`${date}-${n}`)) n++;
  return `${dir}${date}-${n}.${ext}`;
}

// ---------------------------------------------------------------------------
// Images pasted into a section before they have a path

/** What the textarea holds for an image until it's committed: `![image 2](pending:2)`. */
export const pendingToken = (id: number, alt = `image ${id}`) => `![${alt}](pending:${id})`;

/** Ids of the pending images still referenced in `body`. */
export function pendingIds(body: string): number[] {
  return [...body.matchAll(/\]\(pending:(\d+)\)/g)].map((m) => Number(m[1]));
}

/** Drop an image's token (and the blank line it leaves) from `body`. */
export const stripPending = (body: string, id: number) =>
  body.replace(new RegExp(`!\\[[^\\]]*\\]\\(pending:${id}\\)\\n?`, "g"), "").replace(/\n{3,}/g, "\n\n");

/**
 * Point each pending token at its committed path, relative to the play file
 * ("../Images/plays/…"). An image whose token was deleted from the text is
 * still committed, so it goes on the end of the section rather than vanishing.
 */
export function resolvePending(body: string, paths: Map<number, string>): string {
  let out = body.replace(/\]\(pending:(\d+)\)/g, (whole, id: string) => {
    const p = paths.get(Number(id));
    return p ? `](../${p})` : whole;
  });
  const used = new Set(pendingIds(body));
  const extra = [...paths].filter(([id]) => !used.has(id));
  if (extra.length) out = `${out.replace(/\s+$/, "")}\n\n${extra.map(([id, p]) => `![image ${id}](../${p})`).join("\n\n")}`;
  return out;
}
