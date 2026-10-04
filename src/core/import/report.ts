// Plain-text import preview tables, shared by the CLI (terminal only, never CI
// logs) and the Import page, so both show the same preview (SPEC §4.5).
import type { FileReport, UnmappedEtf } from "../normalize";
import { etDate } from "../normalize/util";
import { heldOvernightDayTrades, summarize, type Summary } from "../trades";
import type { DerivedTrades, Trade } from "../types";

export function table(rows: Array<Array<string | number>>, align: Array<"l" | "r"> = []): string {
  const cells = rows.map((r) => r.map(String));
  const widths = cells[0]?.map((_, i) => Math.max(...cells.map((r) => r[i]?.length ?? 0))) ?? [];
  return cells
    .map((r) => r.map((c, i) => (align[i] === "r" ? c.padStart(widths[i]!) : c.padEnd(widths[i]!))).join("  ").trimEnd())
    .join("\n");
}

export const money = (n: number) => `${n < 0 ? "-" : n > 0 ? "+" : " "}$${Math.abs(n).toFixed(2)}`;
export const pct = (n: number | null) => (n === null ? "—" : `${(n * 100).toFixed(1)}%`);
const date = (iso: string | null) => (iso ? etDate(iso) : "—");
const time = (t: Trade, iso: string | null) =>
  !iso ? "" : t.broker === "webull" ? new Date(iso).toLocaleTimeString("en-GB", { timeZone: "America/New_York" }) : "";

export function symbolLabel(t: Trade): string {
  return t.instrument === "leveraged_etf" ? `${t.symbol}→${t.underlying} ${t.leverage}x` : t.symbol;
}

export function tradeRows(trades: Trade[]): string {
  const rows: Array<Array<string | number>> = [
    ["OPENED", "", "CLOSED", "BROKER", "STYLE", "SYMBOL", "STATUS", "MAX", "ENTRY", "EXIT", "NET", "RESULT", "FILLS"],
  ];
  for (const t of trades) {
    rows.push([
      date(t.openedAt), time(t, t.openedAt), date(t.closedAt), t.broker, t.style, symbolLabel(t),
      t.status === "open" ? `open ${t.openQty}` : t.status === "unmatched" ? `UNMATCHED -${t.unmatchedQty}` : t.sameDay ? "closed" : "closed*",
      t.maxPosition, t.avgEntry.toFixed(4), t.avgExit?.toFixed(4) ?? "—", money(t.netPnl), t.result ?? "", t.fillIds.length,
    ]);
  }
  return table(rows, ["l", "l", "l", "l", "l", "l", "l", "r", "r", "r", "r", "l", "r"]);
}

function summaryRow(label: string, s: Summary): Array<string | number> {
  return [label, s.trades, s.closed, s.open, s.unmatched, `${s.wins}/${s.losses}/${s.breakevens}`, pct(s.winRate), money(s.netPnl)];
}

export function summaryTable(trades: Trade[]): string {
  const rows: Array<Array<string | number>> = [["", "TRADES", "CLOSED", "OPEN", "UNMATCHED", "W/L/BE", "WIN %", "NET P&L"]];
  for (const style of ["day", "swing"] as const) {
    for (const broker of ["schwab", "webull"] as const) {
      const sub = trades.filter((t) => t.style === style && t.broker === broker);
      if (sub.length) rows.push(summaryRow(`${style} · ${broker}`, summarize(sub)));
    }
    rows.push(summaryRow(`${style} (all)`, summarize(trades.filter((t) => t.style === style))));
  }
  for (const broker of ["schwab", "webull"] as const) {
    rows.push(summaryRow(`${broker} (all)`, summarize(trades.filter((t) => t.broker === broker))));
  }
  rows.push(summaryRow("TOTAL", summarize(trades)));
  return table(rows, ["l", "r", "r", "r", "r", "r", "r", "r"]);
}

export function monthlyTable(trades: Trade[]): string {
  const months = [...new Set(trades.filter((t) => t.closedAt).map((t) => etDate(t.closedAt!).slice(0, 7)))].sort();
  const rows: Array<Array<string | number>> = [["MONTH (closed)", "SCHWAB W/L/BE", "WIN %", "NET", "WEBULL W/L/BE", "WIN %", "NET"]];
  for (const m of months) {
    const inMonth = trades.filter((t) => t.closedAt && etDate(t.closedAt).startsWith(m));
    const cells = (["schwab", "webull"] as const).flatMap((b) => {
      const s = summarize(inMonth.filter((t) => t.broker === b));
      return [`${s.wins}/${s.losses}/${s.breakevens}`, pct(s.winRate), money(s.netPnl)];
    });
    rows.push([m, ...cells]);
  }
  return table(rows, ["l", "r", "r", "r", "r", "r", "r"]);
}

export function filesTable(files: FileReport[]): string {
  const rows: Array<Array<string | number>> = [["FILE", "BROKER", "ACCOUNT", "ROWS", "FILLS", "NEW", "DUP", "SKIPPED", "ERRORS"]];
  for (const f of files) {
    const skipped = Object.entries(f.skipped).map(([k, v]) => `${k} ${v}`).join(", ") || "—";
    rows.push([f.source, f.broker ?? "?", f.account ?? "?", f.rows, f.parsed, f.added, f.duplicates, skipped, f.errors.length]);
  }
  return table(rows, ["l", "l", "l", "r", "r", "r", "r", "l", "r"]);
}

export function etfTable(etfs: UnmappedEtf[]): string {
  return table([
    ["SYMBOL", "NAME", "GUESS"],
    ...etfs.map((e) => [
      e.symbol, e.name,
      `${e.guess.underlying ?? "? (name doesn't say)"} ${e.guess.leverage}x ${e.guess.direction}${e.guess.issuer ? ` (${e.guess.issuer})` : ""}`,
    ]),
  ]);
}

/** Trades that are new or changed compared with the previous derived/trades.json. */
export function diffTrades(prev: DerivedTrades | null, next: Trade[]) {
  const fp = (t: Trade) => JSON.stringify([t.status, t.netPnl, t.fillIds, t.style, t.ideaId, t.excluded]);
  const before = new Map((prev?.trades ?? []).map((t) => [t.id, fp(t)]));
  const nextIds = new Set(next.map((t) => t.id));
  return {
    added: next.filter((t) => !before.has(t.id)),
    changed: next.filter((t) => before.has(t.id) && before.get(t.id) !== fp(t)),
    removed: [...before.keys()].filter((id) => !nextIds.has(id)),
  };
}

export function attentionSection(trades: Trade[], today: string, reorderedDays: number): string {
  const out: string[] = [];
  const open = trades.filter((t) => t.status === "open");
  out.push(`OPEN POSITIONS (${open.length})`);
  out.push(open.length ? tradeRows(open) : "  none");
  const unmatched = trades.filter((t) => t.status === "unmatched");
  out.push("", `UNMATCHED SELLS (${unmatched.length}) — fix with overrides.json openingPositions`);
  out.push(unmatched.length ? tradeRows(unmatched) : "  none");
  const overnight = heldOvernightDayTrades(trades, today);
  out.push("", `DAY TRADES HELD OVERNIGHT (${overnight.length}) — still day trades? (closed* = closed on a later date)`);
  out.push(overnight.length ? tradeRows(overnight.slice(-15)) + (overnight.length > 15 ? `\n  … ${overnight.length - 15} earlier` : "") : "  none");
  out.push("", `Schwab days where a buy was moved ahead of a same-day sell: ${reorderedDays}`);
  return out.join("\n");
}
