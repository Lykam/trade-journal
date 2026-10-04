// Parse the header of a Playbook review (SPEC §6.11). The format comes from
// Playbook's Template.md:
//
//   # Playbook Review — {{TICKER}} {{DATE}}
//   **Date:** 2026-07-27
//   **Ticker:** ABC
//   **P&L:** +$85
//   **Trade Type:** DAY TRADE | SWING TRADE
//   **Status:** OPEN | CLOSED
//   **Idea ID:** wb-…            (optional, SPEC §4.6)
//   ## Category
//   free text …
//
// Template placeholders ("{{…}}") and blank values parse as null.
import type { Style } from "../types";

export interface ReviewHeader {
  date: string | null;
  ticker: string | null;
  /** As written ("+$85", "-$12.50"); the app shows the idea's computed P&L instead. */
  pnl: string | null;
  tradeType: Style | null;
  status: "open" | "closed" | null;
  ideaId: string | null;
  /** Short label from the "## Category" section, used as an automatic tag (SPEC §6.6). */
  category: string | null;
}

export interface ReviewName {
  date: string;
  ticker: string;
  /** Anything after the ticker, e.g. "2" for a second review of the same ticker that day. */
  suffix: string | null;
}

const FIELD_RE = /^\*\*([^*:]+):\*\*[ \t]*(.*)$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CATEGORY_MAX = 32;

const stripComments = (s: string) => s.replace(/<!--[\s\S]*?(?:-->|$)/g, "");

function clean(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const v = stripComments(raw).trim();
  return v === "" || /\{\{.*\}\}/.test(v) ? null : v;
}

/** "2026-07-27-ABC.md" or "Reviews/2026-07-27-ABC-2.md" → date, ticker, suffix. */
export function parseReviewName(path: string): ReviewName | null {
  const name = path.split(/[\\/]/).pop() ?? "";
  const m = /^(\d{4}-\d{2}-\d{2})-([A-Za-z0-9.^]+?)(?:[-_ ](.+))?\.md$/i.exec(name);
  return m ? { date: m[1]!, ticker: m[2]!.toUpperCase(), suffix: m[3] ?? null } : null;
}

/** The first clause of the Category section: "Breaking news. Gapped on…" → "Breaking news". */
export function categoryLabel(body: string): string | null {
  const line = stripComments(body)
    .split("\n")
    .map((l) => l.replace(/^[\s>*_-]+|[*_]+$/g, "").trim())
    .find((l) => l !== "");
  if (!line) return null;
  const first = line.split(/[.;,:!?(—–]| - /)[0]!.trim();
  if (!first || first.length > CATEGORY_MAX) return null;
  return first.charAt(0).toUpperCase() + first.slice(1);
}

/** The body of a "## Heading" section, up to the next "## ". */
export function sectionBody(markdown: string, heading: string): string | null {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim().toLowerCase() === `## ${heading.toLowerCase()}`);
  if (start < 0) return null;
  const end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  return lines.slice(start + 1, end < 0 ? undefined : end).join("\n");
}

export function parseReviewHeader(markdown: string): ReviewHeader {
  const fields = new Map<string, string>();
  for (const line of markdown.split(/\r?\n/)) {
    if (/^## /.test(line)) break; // header fields sit above the first section
    const m = FIELD_RE.exec(line.trim());
    if (m) fields.set(m[1]!.trim().toLowerCase(), m[2]!);
  }
  const date = clean(fields.get("date"));
  const ticker = clean(fields.get("ticker"));
  const type = clean(fields.get("trade type"))?.toUpperCase() ?? "";
  const status = clean(fields.get("status"))?.toUpperCase() ?? "";
  const category = sectionBody(markdown, "Category");
  return {
    date: date && DATE_RE.test(date) ? date : null,
    ticker: ticker ? ticker.split(/\s/)[0]!.toUpperCase() : null,
    pnl: clean(fields.get("p&l")),
    tradeType: type.startsWith("DAY") ? "day" : type.startsWith("SWING") ? "swing" : null,
    status: status.startsWith("OPEN") ? "open" : status.startsWith("CLOSED") ? "closed" : null,
    ideaId: clean(fields.get("idea id"))?.split(/\s/)[0] ?? null,
    category: category === null ? null : categoryLabel(category),
  };
}
