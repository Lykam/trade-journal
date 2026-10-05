// npm run market -- --mode regular|post-close
//
// The prices workflow's first step (SPEC §5.4): decide whether a scheduled run
// should price and deploy. Checks the ET clock, then Yahoo's marketState for a
// broad index ETF (never a held symbol), which catches holidays. Writes
// run=true|false to $GITHUB_OUTPUT and prints only the reason.
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { shouldPrice } from "../src/core/market";
import { runMain } from "./public-log";
import { yahooClient } from "./yahoo";

const REFERENCE = "SPY";

async function reference(): Promise<{ state: string | null; lastTradeIso: string | null } | null> {
  try {
    const yf = await yahooClient();
    const q = (await yf.quote(REFERENCE, {}, { validateResult: false })) as { marketState?: string; regularMarketTime?: Date | number };
    const t = q.regularMarketTime;
    const lastTradeIso = t instanceof Date ? t.toISOString() : typeof t === "number" ? new Date(t * 1000).toISOString() : null;
    return { state: q.marketState ?? null, lastTradeIso };
  } catch {
    return null;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  await runMain("market", async () => {
    const { values } = parseArgs({ args: process.argv.slice(2), options: { mode: { type: "string", default: "regular" } } });
    const mode = values.mode === "post-close" ? "post-close" : "regular";
    const now = new Date().toISOString();
    // Skip the network call when the clock already says no.
    const clock = shouldPrice(mode, now, { state: mode === "regular" ? "REGULAR" : null, lastTradeIso: now });
    const result = clock.run ? shouldPrice(mode, now, await reference()) : clock;
    console.log(`market: ${result.run ? "run" : "skip"} (${result.why})`);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `run=${result.run}\n`);
  });
}
