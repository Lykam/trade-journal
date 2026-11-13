// npm run cot -- [--out FILE]
//
// Compute the COT positioning gauge (SPEC §5.7) from the CFTC's public legacy
// futures-only Commitments of Traders data (no key) and daily ETF bars from
// Yahoo, and write cot.json: gitignored and never committed, like regime.json.
// Nothing here is the user's holdings, so markets are fine to name in logs.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { REPO_ROOT } from "../cli/lib/history.ts";
import { COT_MARKETS, computeCot, LOOKBACK_WEEKS, type CotMarketId, type CotReport, type DailyBar } from "../src/core/cot/cot.ts";
import type { CotFile } from "../src/core/types.ts";
import { isPublicLog, runMain } from "./public-log.ts";
import { yahooClient } from "./yahoo.ts";

/** Lookback plus a year of year-over-year and sparkline history, with margin. */
const REPORT_WEEKS = LOOKBACK_WEEKS + 52 + 26;
/** Daily bars: enough to walk a signal through a long-lasting zone. */
const BAR_DAYS = 730;

/** A source of COT reports and daily bars. Swap in another implementation without touching callers. */
export interface CotProvider {
  readonly name: string;
  /** Reports since `from` per CFTC contract code; a missing code is simply absent. */
  reports(codes: string[], from: string): Promise<Record<string, CotReport[]>>;
  /** Daily OHLC bars (oldest first) per symbol; a missing symbol is simply absent. */
  bars(symbols: string[], now: string): Promise<Record<string, DailyBar[]>>;
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

export class CftcYahooProvider implements CotProvider {
  readonly name = "cftc+yahoo";

  async reports(codes: string[], from: string): Promise<Record<string, CotReport[]>> {
    const url = new URL(CFTC_LEGACY_FUTURES);
    url.searchParams.set(
      "$select",
      "cftc_contract_market_code as code,report_date_as_yyyy_mm_dd as d,open_interest_all as oi," +
        "comm_positions_long_all as cl,comm_positions_short_all as cs,noncomm_positions_long_all as nl," +
        "noncomm_positions_short_all as ns,nonrept_positions_long_all as rl,nonrept_positions_short_all as rs",
    );
    url.searchParams.set("$where", `cftc_contract_market_code in (${codes.map((c) => `'${c}'`).join(",")}) AND report_date_as_yyyy_mm_dd >= '${from}'`);
    url.searchParams.set("$order", "d");
    url.searchParams.set("$limit", "50000");
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`CFTC ${res.status}`);
    const rows = (await res.json()) as CftcRow[];
    const out: Record<string, CotReport[]> = {};
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
    return out;
  }

  async bars(symbols: string[], now: string): Promise<Record<string, DailyBar[]>> {
    const yf = await yahooClient();
    const period1 = new Date(Date.parse(now) - BAR_DAYS * 24 * 3600_000);
    const out: Record<string, DailyBar[]> = {};
    for (const symbol of symbols) {
      try {
        const result = (await yf.chart(symbol, { period1, period2: new Date(now), interval: "1d", return: "array" }, { validateResult: false })) as {
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
    }
    return out;
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
  const from = new Date(Date.parse(now) - REPORT_WEEKS * 7 * 24 * 3600_000).toISOString().slice(0, 10);

  let byCode: Record<string, CotReport[]> = {};
  let bars: Record<string, DailyBar[]> = {};
  try {
    [byCode, bars] = await Promise.all([provider.reports(COT_MARKETS.map((m) => m.code), from), provider.bars(COT_MARKETS.map((m) => m.etf), now)]);
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

  writeFileSync(out, `${JSON.stringify(file, null, 2)}\n`);
  const summary = file.snapshot.markets.map((m) => `${m.id} ${Math.round(m.osc)}`).join(" · ");
  log(`cot: ${file.stale ? "using a stale snapshot" : summary}${publicLog || !file.stale ? "" : ` (${summary})`}`);
  return complete || prev ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  await runMain("cot", () => runFetchCot(process.argv.slice(2)));
}
