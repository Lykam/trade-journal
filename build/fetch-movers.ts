// npm run movers -- [--publish] [--out FILE] [--from YYYY-MM-DD]
//
// The weekly big-movers research list (src/core/movers): every complete week's
// US stocks that moved 50%+ either way, with $100M+ average daily dollar volume
// and a price over $5. Market data comes from Massive (formerly Polygon.io),
// key in MASSIVE_API_KEY or POLYGON_API_KEY:
//   - grouped daily bars (one call per market day, every US ticker, actual prices),
//     cached gzipped under _cache/movers/days/ so later runs fetch only new days;
//   - splits, so a split week isn't a fake move;
//   - the reference list of common stocks and ADRs, delisted included, so ETFs,
//     warrants and units drop out but names that later delisted stay in.
// Writes movers.json and movers.csv here (gitignored, like cot.json). With
// --publish it also commits movers.json to trade-history (token: GITHUB_TOKEN or
// `gh auth token`), which redeploys the site so the MOVERS page shows the new
// week (SPEC §6.7f, Q85). The free plan allows 5 calls a minute and 2 years of
// history: a first backfill takes ~2 hours; a weekly run, about a minute.
// Run weekly by the "TradeJournal Movers" Windows scheduled task (build/movers-task.ps1).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { gunzipSync, gzipSync } from "node:zlib";
import { REPO_ROOT } from "../cli/lib/history.ts";
import { addDays, dayOfWeek } from "../src/core/calendar.ts";
import { commitFiles, GitHubClient, parseRepo, readState, RefMovedError } from "../src/core/github/client.ts";
import { computeMovers, moversCsv, moversFile, DEFAULT_CRITERIA, type Bar, type Day, type Split } from "../src/core/movers/movers.ts";
import { etDate } from "../src/core/normalize/util.ts";
import { runMain } from "./public-log.ts";

const API = "https://api.massive.com";
/** Free plan: 5 calls a minute. */
const GAP_MS = 12_500;
/** Ticker types kept: common stock, ADRs of common stock, ordinary shares. */
const STOCK_TYPES = ["CS", "ADRC", "OS"];
const REFERENCE_MAX_AGE_MS = 7 * 86_400_000;

const CACHE = join(REPO_ROOT, "_cache", "movers");
const DAYS_DIR = join(CACHE, "days");

class Massive {
  private nextAt = 0;
  constructor(private readonly key: string) {}

  /** GET a path or a next_url, paced to the plan's rate limit; a 429 waits a minute and retries. */
  async get(pathOrUrl: string): Promise<{ status: number; body: any }> {
    for (let attempt = 0; ; attempt++) {
      const wait = this.nextAt - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.nextAt = Date.now() + GAP_MS;
      const url = new URL(pathOrUrl.startsWith("http") ? pathOrUrl : `${API}${pathOrUrl}`);
      url.searchParams.set("apiKey", this.key);
      const res = await fetch(url);
      if (res.status === 429 && attempt < 5) {
        this.nextAt = Date.now() + 65_000;
        continue;
      }
      return { status: res.status, body: await res.json().catch(() => null) };
    }
  }

  /** Every page of a v3 list endpoint. */
  async all(path: string): Promise<any[]> {
    const out: any[] = [];
    for (let next: string | undefined = path; next; ) {
      const { status, body } = await this.get(next);
      if (status !== 200) throw new Error(`Massive ${status} on ${path.split("?")[0]}: ${body?.message ?? body?.error ?? ""}`);
      out.push(...(body.results ?? []));
      next = body.next_url;
    }
    return out;
  }
}

type Packed = [string, number, number, number, number, number, number | null];

function dayFile(date: string) {
  return join(DAYS_DIR, `${date}.json.gz`);
}

function readDay(date: string): Day | null {
  const f = dayFile(date);
  if (!existsSync(f)) return null;
  const rows = JSON.parse(gunzipSync(readFileSync(f)).toString("utf8")) as Packed[];
  return { date, bars: new Map(rows.map(([t, o, h, l, c, v, vw]) => [t, { o, h, l, c, v, ...(vw ? { vw } : {}) } as Bar])) };
}

/** Weekdays from `from` through `to`. */
function weekdays(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) if (dayOfWeek(d) >= 1 && dayOfWeek(d) <= 5) out.push(d);
  return out;
}

/** The last Friday strictly before `today`: the end of the latest complete week. */
export function lastCompleteFriday(today: string): string {
  let d = addDays(today, -1);
  while (dayOfWeek(d) !== 5) d = addDays(d, -1);
  return d;
}

async function cachedJson<T>(name: string, maxAgeMs: number, load: () => Promise<T>): Promise<T> {
  const f = join(CACHE, name);
  if (existsSync(f) && Date.now() - statSync(f).mtimeMs < maxAgeMs) return JSON.parse(readFileSync(f, "utf8")) as T;
  const v = await load();
  writeFileSync(f, JSON.stringify(v));
  return v;
}

async function main(argv: string[], log = console.log): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { out: { type: "string" }, from: { type: "string" }, publish: { type: "boolean" } } });
  const key = (process.env.MASSIVE_API_KEY ?? process.env.POLYGON_API_KEY ?? "").trim();
  if (!key) throw new Error("set MASSIVE_API_KEY (or POLYGON_API_KEY) to a Massive API key");
  const api = new Massive(key);
  mkdirSync(DAYS_DIR, { recursive: true });

  const today = etDate(new Date().toISOString());
  const through = lastCompleteFriday(today);
  // The free plan's history reaches back 2 years; a day it refuses is skipped, not cached. Days cached
  // earlier stay in the computation, so the history keeps growing after they leave the plan's window.
  const window = values.from ?? addDays(today, -730);
  const earliest = readdirSync(DAYS_DIR).filter((n) => n.endsWith(".json.gz")).sort()[0]?.slice(0, 10);
  const from = !values.from && earliest && earliest < window ? earliest : window;
  const dates = weekdays(from, through);

  const missing = dates.filter((d) => d >= window && !existsSync(dayFile(d)));
  if (missing.length) log(`movers: fetching ${missing.length} market day(s), about ${Math.ceil((missing.length * GAP_MS) / 60_000)} min`);
  let done = 0;
  for (const d of missing) {
    const { status, body } = await api.get(`/v2/aggs/grouped/locale/us/market/stocks/${d}?adjusted=false`);
    done++;
    if (status === 403) continue; // before the plan's history
    if (status !== 200) throw new Error(`Massive ${status} on ${d}: ${body?.message ?? ""}`);
    const rows: Packed[] = (body.results ?? []).map((r: any) => [r.T, r.o, r.h, r.l, r.c, r.v, r.vw ?? null]);
    writeFileSync(dayFile(d), gzipSync(JSON.stringify(rows)));
    if (done % 20 === 0) log(`movers: ${done}/${missing.length} days (${d})`);
  }

  log("movers: loading splits and the stock list");
  const splitsRaw = await cachedJson("splits.json", 86_400_000, () => api.all(`/v3/reference/splits?execution_date.gte=${addDays(from, -7)}&limit=1000`));
  const splits: Split[] = splitsRaw.map((s: any) => ({ ticker: s.ticker, date: s.execution_date, from: s.split_from, to: s.split_to }));
  const stocks = new Set<string>(
    await cachedJson("stocks.json", REFERENCE_MAX_AGE_MS, async () => {
      const names: string[] = [];
      for (const type of STOCK_TYPES)
        for (const active of [true, false])
          names.push(...(await api.all(`/v3/reference/tickers?market=stocks&type=${type}&active=${active}&limit=1000`)).map((t: any) => t.ticker));
      return [...new Set(names)];
    }),
  );

  const days = dates.map(readDay).filter((d): d is Day => !!d && d.bars.size > 0);
  const weeks = computeMovers(days, splits, (t) => stocks.has(t), DEFAULT_CRITERIA);
  const out = resolve(values.out ?? process.env.MOVERS_FILE ?? join(REPO_ROOT, "movers.json"));
  const json = `${JSON.stringify(moversFile(weeks, DEFAULT_CRITERIA))}\n`;
  writeFileSync(out, json);
  writeFileSync(out.replace(/\.json$/, ".csv"), moversCsv(weeks));

  const total = weeks.reduce((n, w) => n + w.movers.length, 0);
  log(`movers: ${weeks.length} weeks (${weeks[0]?.end ?? "—"} to ${weeks.at(-1)?.end ?? "—"}), ${total} movers → ${out}`);
  const latest = weeks.at(-1);
  if (latest) {
    log(`movers: week ending ${latest.end}:`);
    for (const r of latest.movers) log(`  ${r.ticker.padEnd(6)} ${r.dir.padEnd(4)} ${String(r.chg).padStart(7)}%  ${r.basis.padEnd(9)} $${(Math.max(r.dv5, r.dv30) / 1e6).toFixed(0)}M/day`);
  }
  if (values.publish) await publish(json, weeks.at(-1)?.end ?? "", log);
  return 0;
}

/** Commit movers.json to trade-history (only when it changed); the data repo's push redeploys the site. */
async function publish(json: string, through: string, log: (s: string) => void): Promise<void> {
  const token = (process.env.GITHUB_TOKEN ?? execFileSync("gh", ["auth", "token"], { encoding: "utf8" })).trim();
  const repo = parseRepo(process.env.TRADE_HISTORY_REPO ?? "Lykam/trade-history");
  if (!token || !repo) throw new Error("publish needs GITHUB_TOKEN or a logged-in gh, and TRADE_HISTORY_REPO as owner/repo");
  const gh = new GitHubClient(token);
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await commitFiles(gh, await readState(gh, repo), [{ path: "movers.json", content: json }], `Update movers through ${through}`);
      log(res ? `movers: published to ${repo.owner}/${repo.repo} (${res.sha.slice(0, 7)}); the site redeploys` : "movers: trade-history already up to date");
      return;
    } catch (e) {
      if (!(e instanceof RefMovedError) || attempt >= 2) throw e;
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  await runMain("movers", () => main(process.argv.slice(2)));
}
