import { etTime } from "../core/calendar";
import { etDate } from "../core/normalize/util";
import type { Trade } from "../core/types";

const MINUS = "−";

/** "+12.61", "−0.70", "0.00". No currency sign, like the mockups. */
export function money(n: number | null | undefined, opts: { sign?: boolean } = {}): string {
  if (n === null || n === undefined) return "—";
  const abs = Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (n < 0) return `${MINUS}${abs}`;
  return n > 0 && opts.sign !== false ? `+${abs}` : abs;
}

export const pnlClass = (n: number | null | undefined) => (n === null || n === undefined || n === 0 ? "flat" : n > 0 ? "gain" : "loss");

/** 0.523 → "52%" (or "52.3%" with digits = 1). */
export function pct(rate: number | null | undefined, digits = 0): string {
  return rate === null || rate === undefined ? "—" : `${(rate * 100).toFixed(digits)}%`;
}

export function signedPct(rate: number | null | undefined, digits = 2): string {
  if (rate === null || rate === undefined) return "—";
  const s = (Math.abs(rate) * 100).toFixed(digits);
  return rate > 0 ? `+${s}%` : rate < 0 ? `${MINUS}${s}%` : `${s}%`;
}

export const pts = (d: number | null) => (d === null ? "—" : `${d > 0 ? "+" : d < 0 ? MINUS : ""}${Math.abs(d).toFixed(1)} PTS`);

export const price = (n: number | null | undefined) =>
  n === null || n === undefined ? "—" : n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: n < 1 ? 4 : 2 });

export const qty = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 4 });

/** "2026-09-26" → "09-26". */
export const mmdd = (date: string) => date.slice(5);
export const dateOf = (iso: string) => etDate(iso);
export const timeOf = (iso: string) => `${etTime(iso)} ET`;
export const dateTimeOf = (iso: string) => `${etDate(iso)} ${timeOf(iso)}`;

/** "→FAKE 2x" style suffix for leveraged ETFs (inverse funds say so). */
export function underlyingTag(t: Trade): string {
  if (t.instrument !== "leveraged_etf") return "";
  return `→${t.underlying} ${t.leverage}x${t.direction === "inverse" ? " inv" : ""}`;
}

export function minutes(m: number | null): string {
  if (m === null) return "—";
  if (m < 60) return `${Math.round(m)}m`;
  const h = Math.floor(m / 60);
  return `${h}h${String(Math.round(m % 60)).padStart(2, "0")}`;
}

export const days = (d: number | null) => (d === null ? "—" : `${d.toFixed(1)}d`);

export const DOW = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const MONTH_NAMES = MONTHS;

/** "2026-01-15" → "Jan 15, 2026". */
export const longDate = (date: string) => `${MONTHS[Number(date.slice(5, 7)) - 1]} ${Number(date.slice(8, 10))}, ${date.slice(0, 4)}`;

/** "2026-09" → "SEP 2026". */
export const monthLabel = (month: string) => `${MONTHS[Number(month.slice(5, 7)) - 1]!.toUpperCase()} ${month.slice(0, 4)}`;

/** ET date plus time for second-precision fills; the date only for Schwab's day precision. */
export const whenOf = (iso: string, precision: "second" | "day" = "second") =>
  precision === "day" ? dateOf(iso) : `${dateOf(iso)} ${etTime(iso)}`;

/** Short P&L for small calendar cells: "+12.6", "−126", "+1.2k". */
export function compactMoney(n: number): string {
  const a = Math.abs(n);
  const body = a >= 1000 ? `${(a / 1000).toFixed(a >= 10000 ? 0 : 1)}k` : a >= 100 ? a.toFixed(0) : a.toFixed(a >= 10 ? 1 : 2);
  return n < 0 ? `${MINUS}${body}` : n > 0 ? `+${body}` : body;
}
