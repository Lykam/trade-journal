// The QUOTES page (SPEC §3.6, §6.7b, Q81): trading quotes the owner hears or
// thinks of, with an optional source, link and tags. They live in trade-history's
// sayings.json (named so to keep apart from quotes.json, the prices), and each
// add, edit or removal is one commit through the usual preview (Q40). Trades
// don't change, so derived/trades.json is left alone.
import { jsonText, type FileWrite, type HistorySnapshot } from "../history/files.ts";
import type { SchemaTexts, Validate } from "../schema-names.ts";
import type { Saying, SayingsFile } from "../types.ts";

/** What the add/edit form holds, as typed. */
export interface SayingDraft {
  text: string;
  source: string;
  link: string;
  /** Comma-separated. */
  tags: string;
}

export type SayingChange = { kind: "put"; saying: Saying } | { kind: "remove"; id: string };

export interface SayingCommitPlan {
  sayings: SayingsFile;
  before: Saying | null;
  after: Saying | null;
  files: FileWrite[];
  message: string;
  /** Equal for two plans that write the same change (what the user approved, Q40). */
  fingerprint: string;
}

export const MAX_TEXT = 4000;
const MAX_TAG = 40;

/** "Relative Strength" → "relative-strength"; null when nothing usable is left. */
export function normalizeTag(raw: string): string | null {
  const t = raw
    .trim()
    .toLowerCase()
    .replace(/^#/, "")
    .replace(/[\s_/]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_TAG)
    .replace(/-+$/, "");
  return t || null;
}

/** "volatility, Relative Strength, volatility" → ["volatility", "relative-strength"]. */
export function parseTags(text: string): string[] {
  const out: string[] = [];
  for (const part of text.split(",")) {
    const t = normalizeTag(part);
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

/**
 * A link as typed → an http(s) URL, "" for none, or null when it isn't a web link.
 * "youtu.be/abc" gets https:// in front.
 */
export function normalizeLink(raw: string): string | null {
  const s = raw.trim();
  if (!s) return "";
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (!url.hostname.includes(".") || /\s/.test(withScheme)) return null;
  return url.href;
}

/** A link safe to put in an href: http(s) only, whatever the file says. */
export function safeHref(link: string | undefined): string | null {
  if (!link) return null;
  try {
    const u = new URL(link);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
}

/** "https://www.youtube.com/watch?v=…" → "youtube.com". */
export function linkLabel(link: string): string {
  try {
    return new URL(link).hostname.replace(/^www\./, "");
  } catch {
    return link;
  }
}

/** "q-" + 12 random hex chars. */
export function newSayingId(random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  return `q-${[...random(6)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export const draftOf = (s?: Saying): SayingDraft => ({
  text: s?.text ?? "",
  source: s?.source ?? "",
  link: s?.link ?? "",
  tags: (s?.tags ?? []).join(", "),
});

/** The saying a draft describes, or an error message. Editing keeps the id and the date added. */
export function sayingFromDraft(d: SayingDraft, base: { id: string; addedAt: string }): Saying | string {
  const text = d.text.trim().replace(/\r\n/g, "\n");
  if (!text) return "Type the quote.";
  if ([...text].length > MAX_TEXT) return `Keep the quote under ${MAX_TEXT} characters.`;
  const source = d.source.trim().replace(/\s+/g, " ");
  if ([...source].length > 200) return "Keep the source under 200 characters.";
  const link = normalizeLink(d.link);
  if (link === null) return "The link must be a web address (https://…).";
  const tags = parseTags(d.tags);
  return {
    id: base.id,
    text,
    ...(source ? { source } : {}),
    ...(link ? { link } : {}),
    ...(tags.length ? { tags } : {}),
    addedAt: base.addedAt,
  };
}

const short = (s: string, n = 48) => {
  const one = s.replace(/\s+/g, " ").trim();
  return [...one].length > n ? `${[...one].slice(0, n - 1).join("").trimEnd()}…` : one;
};

function describe(before: Saying | null, after: Saying | null): string {
  const s = (after ?? before)!;
  const by = s.source ? ` (${short(s.source, 30)})` : "";
  if (!after) return `Quotes: remove "${short(s.text)}"${by}`;
  return `Quotes: ${before ? "edit" : "add"} "${short(s.text)}"${by}`;
}

/** The commit for one add, edit or removal, against the current trade-history. */
export function planSayingCommit(snap: HistorySnapshot, change: SayingChange, ctx: { schemas: SchemaTexts }, validate: Validate): SayingCommitPlan {
  const list = snap.sayings.sayings;
  const id = change.kind === "put" ? change.saying.id : change.id;
  const before = list.find((s) => s.id === id) ?? null;
  let next: Saying[];
  let after: Saying | null = null;
  if (change.kind === "remove") {
    if (!before) throw new Error("That quote is no longer in trade-history.");
    next = list.filter((s) => s.id !== id);
  } else {
    after = change.saying;
    // New quotes go on the end, so the file only grows at the bottom; edits stay in place.
    next = before ? list.map((s) => (s.id === id ? after! : s)) : [...list, after];
  }
  const sayings: SayingsFile = { schemaVersion: 1, sayings: next };
  validate("sayings", sayings, "sayings.json");
  const changed = JSON.stringify(before) !== JSON.stringify(after);
  return {
    sayings, before, after,
    files: changed
      ? [{ path: "sayings.json", content: jsonText(sayings) }, { path: "schema/sayings.schema.json", content: ctx.schemas.sayings }]
      : [],
    message: describe(before, after),
    fingerprint: JSON.stringify(change),
  };
}

// ---------------------------------------------------------------------------
// The list

export interface SayingFilter {
  q: string;
  tag: string | null;
  source: string | null;
}

/** Newest first. */
export const newestFirst = (list: Saying[]) => [...list].sort((a, b) => b.addedAt.localeCompare(a.addedAt) || b.id.localeCompare(a.id));

export function filterSayings(list: Saying[], f: SayingFilter): Saying[] {
  const words = f.q.toLowerCase().split(/\s+/).filter(Boolean);
  return list.filter((s) => {
    if (f.tag && !(s.tags ?? []).includes(f.tag)) return false;
    if (f.source && (s.source ?? "").toLowerCase() !== f.source.toLowerCase()) return false;
    const hay = `${s.text}\n${s.source ?? ""}\n${(s.tags ?? []).join(" ")}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** Tags with how many quotes use each, most used first. */
export function tagCounts(list: Saying[]): Array<{ tag: string; n: number }> {
  const m = new Map<string, number>();
  for (const s of list) for (const t of s.tags ?? []) m.set(t, (m.get(t) ?? 0) + 1);
  return [...m].map(([tag, n]) => ({ tag, n })).sort((a, b) => b.n - a.n || a.tag.localeCompare(b.tag));
}

/** Distinct sources, most used first (for the source field's suggestions). */
export function sourceList(list: Saying[]): string[] {
  const m = new Map<string, { name: string; n: number }>();
  for (const s of list) {
    if (!s.source) continue;
    const k = s.source.toLowerCase();
    const e = m.get(k);
    if (e) e.n++;
    else m.set(k, { name: s.source, n: 1 });
  }
  return [...m.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name)).map((e) => e.name);
}
