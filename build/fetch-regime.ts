// npm run regime -- [--out FILE]
//
// Compute the risk-on/unsure/risk-off market regime (SPEC §5.6) from daily
// bars for a fixed public ETF basket (REGIME_SYMBOLS) and write regime.json,
// gitignored and never committed, like quotes.json. Unlike quotes, none of
// this is the user's holdings, so symbols are fine to name in logs.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { REPO_ROOT } from "../cli/lib/history.ts";
import { ALL_REGIME_SYMBOLS, computeRegime, type Bar } from "../src/core/regime/regime.ts";
import type { RegimeFile } from "../src/core/types.ts";
import { isPublicLog, runMain } from "./public-log.ts";
import { yahooClient } from "./yahoo.ts";

/** Enough calendar days to cover a 200-session SMA plus its 20-session-ago lookback, with margin. */
const HISTORY_DAYS = 400;

/** A source of daily OHLCV bars. Swap in another implementation without touching callers. */
export interface RegimeProvider {
  readonly name: string;
  /** Daily bars (oldest first) for the symbols it could fetch; a missing symbol is simply absent. */
  fetch(symbols: string[], now: string): Promise<Record<string, Bar[]>>;
}

export class YahooRegimeProvider implements RegimeProvider {
  readonly name = "yahoo";

  async fetch(symbols: string[], now: string): Promise<Record<string, Bar[]>> {
    const yf = await yahooClient();
    const period1 = new Date(Date.parse(now) - HISTORY_DAYS * 24 * 3600_000);
    const out: Record<string, Bar[]> = {};
    for (const symbol of symbols) {
      try {
        const result = (await yf.chart(symbol, { period1, period2: new Date(now), interval: "1d", return: "array" }, { validateResult: false })) as {
          quotes: Array<{ date: Date; close: number | null; volume: number | null }>;
        };
        const bars: Bar[] = [];
        for (const q of result.quotes) {
          if (q.close == null || q.volume == null) continue;
          bars.push({ date: q.date.toISOString().slice(0, 10), close: q.close, volume: q.volume });
        }
        if (bars.length) out[symbol] = bars;
      } catch {
        // left out; the caller falls back to the previous snapshot
      }
    }
    return out;
  }
}

export function resolveRegimeFile(flag?: string): string {
  return resolve(flag ?? process.env.REGIME_FILE ?? join(REPO_ROOT, "regime.json"));
}

export function readRegime(path: string): RegimeFile | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as RegimeFile;
  } catch {
    return null;
  }
}

export async function runFetchRegime(
  argv: string[],
  opts: { provider?: RegimeProvider; now?: string; log?: (s: string) => void; publicLog?: boolean } = {},
): Promise<number> {
  const log = opts.log ?? console.log;
  const publicLog = opts.publicLog ?? isPublicLog();
  const { values } = parseArgs({ args: argv, options: { out: { type: "string" } } });
  const out = resolveRegimeFile(values.out);
  const provider = opts.provider ?? new YahooRegimeProvider();
  const now = opts.now ?? new Date().toISOString();
  const prev = readRegime(out);

  let fetched: Record<string, Bar[]> = {};
  try {
    fetched = await provider.fetch(ALL_REGIME_SYMBOLS, now);
  } catch (e) {
    log(`regime: ${provider.name} fetch failed (${(e as Error)?.name ?? "error"})`);
  }

  const missing = ALL_REGIME_SYMBOLS.filter((s) => !fetched[s]);
  const complete = missing.length === 0;

  // A partial basket can't be scored fairly: carry the previous snapshot forward, marked
  // stale, instead of computing from an incomplete set of indicators.
  let file: RegimeFile;
  if (complete) file = { asOf: now, attemptedAt: now, snapshot: computeRegime(fetched) };
  else if (prev) file = { ...prev, attemptedAt: now, stale: true };
  else file = { asOf: now, attemptedAt: now, stale: true, snapshot: computeRegime(fetched) };

  writeFileSync(out, `${JSON.stringify(file, null, 2)}\n`);
  if (publicLog) log(`regime: ${file.stale ? "using a stale snapshot" : `${file.snapshot.state} (score ${file.snapshot.score})`}`);
  else {
    log(
      `regime: ${ALL_REGIME_SYMBOLS.length} symbols · ${ALL_REGIME_SYMBOLS.length - missing.length} fetched · ` +
        `${file.snapshot.state} (score ${file.snapshot.score})${file.stale ? " [stale]" : ""}`,
    );
  }
  return complete || prev ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  await runMain("regime", () => runFetchRegime(process.argv.slice(2)));
}
