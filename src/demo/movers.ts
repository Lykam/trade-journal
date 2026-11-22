// The demo's MOVERS page (Q85): half a year of made-up weekly big movers, in the
// same file shape `npm run movers` writes. Tickers are invented (plus the demo's
// own day tickers), so nothing here is real market data.
import { addDays, dayOfWeek, weekStart } from "../core/calendar";
import { etDate } from "../core/normalize/util";
import { DEFAULT_CRITERIA, moversFile, type Mover, type MoversFile, type MoverWeek } from "../core/movers/movers";
import { noteKey, type MoverNotesFile } from "../core/movers/notes";
import { Rng, seedOf } from "./prng";
import { DAY_TICKERS } from "./tickers";

const NAMES = [...DAY_TICKERS.map((t) => t.symbol), "VYRQ", "OMNQ", "HXLQ", "GLBQ", "ARQZ", "NRVQ", "CYPQ", "FNXQ", "DRQN", "SLVQ"];
const WEEKS = 26;

export function demoMovers(now: string, seed: number): MoversFile {
  let fri = addDays(etDate(now), -1);
  while (dayOfWeek(fri) !== 5) fri = addDays(fri, -1);
  const weeks: MoverWeek[] = [];
  for (let k = WEEKS - 1; k >= 0; k--) {
    const end = addDays(fri, -7 * k);
    const r = new Rng(seedOf(seed, "movers", end));
    const picks = [...NAMES].sort(() => r.next() - 0.5).slice(0, r.int(0, 4));
    const movers: Mover[] = picks.map((ticker) => {
      const up = r.chance(0.85);
      const held = r.chance(0.65);
      const extreme = up ? r.range(0.5, 2.5) : -r.range(0.5, 0.8);
      const chg = held ? extreme : extreme * r.range(0.2, 0.8);
      const start = r.range(5.5, 40);
      const dv5 = r.range(1e8, 9e8);
      return {
        ticker,
        dir: up ? "up" : "down",
        basis: held ? "close" : "intraweek",
        chg: round(chg * 100),
        hi: round((up ? extreme : r.range(0, 0.15)) * 100),
        lo: round((up ? -r.range(0, 0.15) : extreme) * 100),
        start: round(start, 2),
        end: round(start * (1 + chg), 2),
        dv5: Math.round(dv5),
        dv30: Math.round(dv5 * r.range(0.2, 1.1)),
        dvMax: Math.round(dv5 * r.range(2, 4)),
        adr: round(r.range(8, 35)),
        days: 5,
      };
    });
    movers.sort((a, b) => Math.abs(b.chg) - Math.abs(a.chg));
    weeks.push({ week: weekStart(end), end, movers });
  }
  return moversFile(weeks, DEFAULT_CRITERIA);
}

const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

/** A couple of short notes on the latest movers, so the demo shows the NOTE column in use. */
export function demoMoverNotes(file: MoversFile): MoverNotesFile {
  const recent = [...file.weeks].reverse().flatMap((w) => w.movers.map((m) => noteKey(w.end, m.ticker))).slice(0, 2);
  const texts = ["Demo note: gapped on news, held VWAP all week.", "Demo note: faded after day one; the short worked."];
  return { schemaVersion: 1, notes: Object.fromEntries(recent.map((k, i) => [k, { text: texts[i]!, updated: file.through }])) };
}
