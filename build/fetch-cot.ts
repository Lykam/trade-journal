// npm run cot -- [--out FILE]
//
// Compute the COT positioning gauge (SPEC §5.7) and the COT page's futures board
// (SPEC §5.8) from the CFTC's public legacy futures-only Commitments of Traders
// data (no key) and Yahoo bars (daily ETF and futures bars, weekly futures bars),
// and write cot.json: gitignored and never committed, like regime.json.
// Nothing here is the user's holdings, so markets are fine to name in logs.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { REPO_ROOT } from "../cli/lib/history.ts";
import { BOARD_MARKETS, computeBoard, type CotBoard } from "../src/core/cot/board.ts";
import { COT_MARKETS, computeCot, type CotMarketId, type CotReport, type DailyBar } from "../src/core/cot/cot.ts";
import type { CotFile } from "../src/core/types.ts";
import { isPublicLog, runMain } from "./public-log.ts";
import { yahooClient } from "./yahoo.ts";

/** All of it: the 3-year rank needs only LOOKBACK_WEEKS, but "most short since" reads the whole history (CFTC data starts 1986). */
const HISTORY_FROM = "1986-01-01";
/** Daily bars: enough to walk a signal through a long-lasting zone. */
const BAR_DAYS = 730;
/** Weekly bars for the board's price pane: BOARD_WEEKS (6 years) with margin. */
const WEEKLY_DAYS = 7 * 330;
/** Socrata's page size; the board's ~44 markets of full history take a few pages. */
const PAGE = 50_000;
/** Yahoo requests in flight at once. */
const CONCURRENCY = 4;

/** A source of COT reports and bars. Swap in another implementation without touching callers. */
export interface CotProvider {
  readonly name: string;
  /** Reports since `from` per CFTC contract code; a missing code is simply absent. */
  reports(codes: string[], from: string): Promise<Record<string, CotReport[]>>;
  /** Daily OHLC bars (oldest first) per symbol; a missing symbol is simply absent. */
  bars(symbols: string[], now: string): Promise<Record<string, DailyBar[]>>;
  /** Weekly OHLC bars (oldest first, dated their first session) per symbol, for the board. Optional: without it the board has no prices. */
  weekly?(symbols: string[], now: string): Promise<Record<string, DailyBar[]>>;
}

const CFTC_LEGACY_FUTURES = "https://publicreporting.cftc.gov/resource/6dca-aqww.json";

interface CftcRow {
  code: string;
  d: string;
  oi: string;
  cl: string;
  cs: string;
  nl: string;
  ns: string;
  rl: string;
  rs: string;
}

/** Run `fn` over `items` with at most `n` in flight. */
async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]!);
  }));
}

export class CftcYahooProvider implements CotProvider {
  readonly name = "cftc+yahoo";

  async reports(codes: string[], from: string): Promise<Record<string, CotReport[]>> {
    const out: Record<string, CotReport[]> = {};
    for (let offset = 0; ; offset += PAGE) {
      const url = new URL(CFTC_LEGACY_FUTURES);
      url.searchParams.set(
        "$select",
        "cftc_contract_market_code as code,report_date_as_yyyy_mm_dd as d,open_interest_all as oi," +
          "comm_positions_long_all as cl,comm_positions_short_all as cs,noncomm_positions_long_all as nl," +
          "noncomm_positions_short_all as ns,nonrept_positions_long_all as rl,nonrept_positions_short_all as rs",
      );
      url.searchParams.set("$where", `cftc_contract_market_code in (${codes.map((c) => `'${c}'`).join(",")}) AND report_date_as_yyyy_mm_dd >= '${from}'`);
      url.searchParams.set("$order", "d,code");
      url.searchParams.set("$limit", String(PAGE));
      url.searchParams.set("$offset", String(offset));
      const res = await fetch(url, { headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`CFTC ${res.status}`);
      const rows = (await res.json()) as CftcRow[];
      for (const r of rows) {
        const n = (s: string) => Number(s);
        (out[r.code] ??= []).push({
          date: r.d.slice(0, 10),
          openInterest: n(r.oi),
          commercial: [n(r.cl), n(r.cs)],
          largeSpec: [n(r.nl), n(r.ns)],
          small: [n(r.rl), n(r.rs)],
        });
      }
      if (rows.length < PAGE) return out;
    }
  }

  private async chart(symbols: string[], now: string, days: number, interval: "1d" | "1wk"): Promise<Record<string, DailyBar[]>> {
    const yf = await yahooClient();
    const period1 = new Date(Date.parse(now) - days * 24 * 3600_000);
    const out: Record<string, DailyBar[]> = {};
    await pool(symbols, CONCURRENCY, async (symbol) => {
      try {
        const result = (await yf.chart(symbol, { period1, period2: new Date(now), interval, return: "array" }, { validateResult: false })) as {
          quotes: Array<{ date: Date; open: number | null; high: number | null; low: number | null; close: number | null }>;
        };
        const bars: DailyBar[] = [];
        for (const q of result.quotes) {
          if (q.open == null || q.high == null || q.low == null || q.close == null) continue;
          bars.push({ date: q.date.toISOString().slice(0, 10), open: q.open, high: q.high, low: q.low, close: q.close });
        }
        if (bars.length) out[symbol] = bars;
      } catch {
        // left out; the caller falls back to the previous snapshot
      }
    });
    return out;
  }

  bars(symbols: string[], now: string): Promise<Record<string, DailyBar[]>> {
    return this.chart(symbols, now, BAR_DAYS, "1d");
  }

  weekly(symbols: string[], now: string): Promise<Record<string, DailyBar[]>> {
    return this.chart(symbols, now, WEEKLY_DAYS, "1wk");
  }
}

export function resolveCotFile(flag?: string): string {
  return resolve(flag ?? process.env.COT_FILE ?? join(REPO_ROOT, "cot.json"));
}

export function readCot(path: string): CotFile | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as CotFile;
  } catch {
    return null;
  }
}

export async function runFetchCot(
  argv: string[],
  opts: { provider?: CotProvider; now?: string; log?: (s: string) => void; publicLog?: boolean } = {},
): Promise<number> {
  const log = opts.log ?? console.log;
  const publicLog = opts.publicLog ?? isPublicLog();
  const { values } = parseArgs({ args: argv, options: { out: { type: "string" } } });
  const out = resolveCotFile(values.out);
  const provider = opts.provider ?? new CftcYahooProvider();
  const now = opts.now ?? new Date().toISOString();
  const prev = readCot(out);
  const from = HISTORY_FROM;

  const codes = [...new Set([...COT_MARKETS.map((m) => m.code), ...BOARD_MARKETS.map((m) => m.code)])];
  const futures = BOARD_MARKETS.map((m) => m.yahoo);
  let byCode: Record<string, CotReport[]> = {};
  let bars: Record<string, DailyBar[]> = {};
  let futDaily: Record<string, DailyBar[]> = {};
  let futWeekly: Record<string, DailyBar[]> = {};
  try {
    [byCode, bars, futDaily, futWeekly] = await Promise.all([
      provider.reports(codes, from),
      provider.bars(COT_MARKETS.map((m) => m.etf), now),
      provider.bars(futures, now).catch(() => ({})),
      provider.weekly ? provider.weekly(futures, now).catch(() => ({})) : Promise.resolve({}),
    ]);
  } catch (e) {
    log(`cot: ${provider.name} fetch failed (${(e as Error)?.name ?? "error"})`);
  }

  const reports: Partial<Record<CotMarketId, CotReport[]>> = {};
  for (const m of COT_MARKETS) if (byCode[m.code]) reports[m.id] = byCode[m.code];
  const snapshot = computeCot(reports, bars, now);
  // A market without a full lookback or its bars can't be scored: carry the previous snapshot
  // forward, marked stale, instead of showing a partial gauge.
  const complete = snapshot.markets.length === COT_MARKETS.length && COT_MARKETS.every((m) => bars[m.etf]?.length);

  let file: CotFile;
  if (complete) file = { asOf: now, attemptedAt: now, snapshot };
  else if (prev) file = { ...prev, attemptedAt: now, stale: true };
  else file = { asOf: now, attemptedAt: now, stale: true, snapshot };

  // The board stands apart from the gauge: a market missing this time keeps its previous entry, and
  // a board with nothing fetched at all carries the previous one over. It never changes the exit code.
  let board: CotBoard | undefined = computeBoard(byCode, futWeekly, futDaily, now, prev?.board);
  // The indices' signals match the dashboard gauge's, which walks the ETFs.
  for (const g of snapshot.markets) {
    const b = board.markets.find((m) => m.id === g.id);
    if (b && b.report === g.report) Object.assign(b, { signal: g.signal, signalOn: g.etf });
  }
  const fetched = BOARD_MARKETS.filter((m) => byCode[m.code]?.length).length;
  if (!fetched) board = prev?.board ? { ...prev.board, stale: true } : undefined;
  if (board) file.board = board;
  else delete file.board;

  writeFileSync(out, `${JSON.stringify(file)}\n`);
  const summary = file.snapshot.markets.map((m) => `${m.id} ${Math.round(m.osc)}`).join(" · ");
  const boardNote = ` · board ${fetched}/${BOARD_MARKETS.length}${board?.stale ? " (stale)" : ""}`;
  log(`cot: ${file.stale ? "using a stale snapshot" : summary}${publicLog || !file.stale ? "" : ` (${summary})`}${boardNote}`);
  return complete || prev ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  await runMain("cot", () => runFetchCot(process.argv.slice(2)));
}
