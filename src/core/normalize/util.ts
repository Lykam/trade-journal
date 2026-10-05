import Papa from "papaparse";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

export const TIMEZONE = "America/New_York";

/** Parse CSV text (with or without a BOM) into header-keyed rows. */
export function parseCsv(text: string): { header: string[]; rows: Record<string, string>[] } {
  const result = Papa.parse<Record<string, string>>(text.replace(/^﻿/, ""), {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (h) => h.trim(),
  });
  return { header: result.meta.fields ?? [], rows: result.data };
}

/** "$1,234.50" → 1234.5, "-$79.62" → -79.62, "" → 0. Throws on anything else. */
export function parseMoney(raw: string | undefined): number {
  const s = (raw ?? "").trim().replace(/[$,]/g, "").replace(/^@/, "");
  if (s === "") return 0;
  const n = Number(s);
  if (!Number.isFinite(n)) throw new Error(`not a number: "${raw}"`);
  return n;
}

export function round(n: number, places: number): number {
  const f = 10 ** places;
  // Nudge by EPSILON so 1.005 rounds to 1.01 instead of 1.00.
  const r = Math.round((n + Math.sign(n) * Number.EPSILON * Math.abs(n)) * f) / f;
  return Object.is(r, -0) ? 0 : r;
}

export const cents = (n: number) => round(n, 2);

/** The ET calendar date (YYYY-MM-DD) of an ISO timestamp. */
// Formatters are created once: constructing an Intl.DateTimeFormat is far slower than using one.
const ET_DATE = new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" });
const ET_OFFSET = new Intl.DateTimeFormat("en-US", { timeZone: TIMEZONE, timeZoneName: "shortOffset" });

export function etDate(iso: string): string {
  return ET_DATE.format(new Date(iso));
}

/** UTC offset ("-04:00" / "-05:00") of New York at the given local wall-clock time. */
export function etOffset(date: string, time = "12:00:00"): string {
  // Guess the instant as EST, then ask Intl what New York's offset is at that instant.
  const guess = new Date(`${date}T${time}-05:00`);
  const name = ET_OFFSET
    .formatToParts(guess)
    .find((p) => p.type === "timeZoneName")?.value; // e.g. "GMT-4"
  const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(name ?? "");
  if (!m) throw new Error(`cannot resolve ET offset for ${date}`);
  return `${m[1]}${m[2]!.padStart(2, "0")}:${m[3] ?? "00"}`;
}

/** "05/19/2026" → "2026-05-19". */
export function usDateToIso(us: string): string {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(us.trim());
  if (!m) throw new Error(`bad date: "${us}"`);
  return `${m[3]}-${m[1]}-${m[2]}`;
}

export function shortHash(input: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(input))).slice(0, 12);
}

/** Minimal shape of a row-level parse result shared by both brokers. */
export interface ParseResult<T> {
  fills: T[];
  rows: number;
  skipped: Record<string, number>;
  errors: string[];
}

export function bump(counts: Record<string, number>, key: string) {
  counts[key] = (counts[key] ?? 0) + 1;
}
