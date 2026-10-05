// Tradervue trades export (SPEC §4.7): one row per trade, used once to carry
// Tradervue's tags, notes and style over to overrides.json. Times are Eastern
// wall-clock ("YYYY-MM-DD HH:MM:SS"); date-only trades (Schwab) are logged at
// 12:00:00. Volume counts both sides, so a closed trade bought Volume ÷ 2 shares.
import { parseCsv } from "../normalize/util";

/** Columns the importer reads; the export has more (MFE/MAE, %, Shared), which are ignored. */
export const TRADERVUE_COLUMNS = [
  "Open Datetime", "Close Datetime", "Symbol", "Side", "Volume", "Exec Count",
  "Entry Price", "Exit Price", "Gross P&L", "Notes", "Tags",
] as const;

export interface TvTrade {
  /** 1-based data row in the CSV, for messages. */
  row: number;
  symbol: string;
  /** ET wall-clock, "YYYY-MM-DD HH:MM:SS". */
  openedAt: string;
  closedAt: string | null;
  /** Logged at 12:00:00 on both ends: the broker gave dates only. */
  dateOnly: boolean;
  volume: number;
  /** Shares bought: Volume ÷ 2 once closed; null while open (sells so far are unknown). */
  shares: number | null;
  execCount: number;
  grossPnl: number;
  /** Plain text: Tradervue's HTML stripped, entities decoded, whitespace collapsed. */
  note: string;
  tags: string[];
}

export interface TvParseResult {
  trades: TvTrade[];
  errors: string[];
  /** Rows left out, by reason (e.g. short trades: the journal is long only). */
  skipped: Record<string, number>;
}

export const isTradervueTrades = (header: string[]) => TRADERVUE_COLUMNS.every((c) => header.includes(c));

const DATETIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const NOON = " 12:00:00";

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Tradervue stores notes as HTML ("<p>…</p>"); the journal's quick note is plain text. */
export function cleanNote(html: string): string {
  return html
    .replace(/<(br|\/p|\/div|\/li)\b[^>]*>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) =>
      e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (ENTITIES[e.toLowerCase()] ?? m))
    .replace(/\s+/g, " ")
    .trim();
}

/** Cut at a word boundary to at most `max` characters, ending in "…". */
export function truncateNote(note: string, max: number): string {
  if (note.length <= max) return note;
  const cut = note.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** "A, b ,A" → ["A", "b"]: trimmed, empty dropped, first spelling of a repeated tag kept. */
export function splitTags(raw: string): string[] {
  const out: string[] = [];
  for (const t of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (!out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t);
  }
  return out;
}

const num = (s: string | undefined) => (s === undefined || s.trim() === "" ? NaN : Number(s.trim()));

export function parseTradervue(text: string): TvParseResult {
  const { header, rows } = parseCsv(text);
  if (!isTradervueTrades(header)) {
    const missing = TRADERVUE_COLUMNS.filter((c) => !header.includes(c));
    return { trades: [], errors: [`not a Tradervue trades export (missing ${missing.join(", ")})`], skipped: {} };
  }
  const trades: TvTrade[] = [];
  const errors: string[] = [];
  const skipped: Record<string, number> = {};
  rows.forEach((r, i) => {
    const row = i + 1;
    const openedAt = (r["Open Datetime"] ?? "").trim();
    const closedAt = (r["Close Datetime"] ?? "").trim() || null;
    const side = (r["Side"] ?? "").trim().toUpperCase();
    const volume = num(r["Volume"]);
    const execCount = num(r["Exec Count"]);
    const grossPnl = num(r["Gross P&L"]);
    const symbol = (r["Symbol"] ?? "").trim().toUpperCase();
    if (side === "S") {
      skipped["short"] = (skipped["short"] ?? 0) + 1;
      return;
    }
    const bad: string[] = [];
    if (!DATETIME.test(openedAt)) bad.push("Open Datetime");
    if (closedAt !== null && !DATETIME.test(closedAt)) bad.push("Close Datetime");
    if (side !== "L") bad.push("Side");
    if (!symbol) bad.push("Symbol");
    if (!(volume > 0)) bad.push("Volume");
    if (!(execCount > 0)) bad.push("Exec Count");
    if (Number.isNaN(grossPnl)) bad.push("Gross P&L");
    if (closedAt !== null && volume % 2 !== 0) bad.push("Volume (odd for a closed trade)");
    if (bad.length) {
      errors.push(`row ${row}: bad ${bad.join(", ")}`); // no values: they are real trades
      return;
    }
    trades.push({
      row,
      symbol,
      openedAt,
      closedAt,
      dateOnly: openedAt.endsWith(NOON) && (closedAt === null || closedAt.endsWith(NOON)),
      volume,
      shares: closedAt === null ? null : volume / 2,
      execCount,
      grossPnl,
      note: cleanNote(r["Notes"] ?? ""),
      tags: splitTags(r["Tags"] ?? ""),
    });
  });
  return { trades, errors, skipped };
}
