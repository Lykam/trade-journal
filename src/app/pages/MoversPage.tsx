// MOVERS (SPEC §6.7f, Q85): a research list of every week's big movers, US stocks
// that moved 50%+ either way on $100M+ average daily dollar volume, priced over $5.
// Read-only: movers.json is written weekly by `npm run movers -- --publish` (a
// Windows scheduled task) into trade-history, and the deploy bundles it.
import { useMemo, useState } from "react";
import { etDate } from "../../core/normalize/util";
import { filterMovers, moverRows, NO_FILTER, type MoverFilter, type MoverRow } from "../../core/movers/movers";
import type { DataBundle, Trade } from "../../core/types";

const MINUS = "−";
const PAGE = 150;
const signed = (n: number) => `${n > 0 ? "+" : n < 0 ? MINUS : ""}${Math.abs(n).toFixed(1)}%`;
const dollars = (n: number) => (n >= 1e9 ? `$${(n / 1e9).toFixed(1)}B` : `$${Math.round(n / 1e6)}M`);
const usd = (n: number) => `$${n >= 100 ? n.toFixed(0) : n.toFixed(2)}`;

type Choice<K extends keyof MoverFilter> = { value: MoverFilter[K]; label: string; title?: string };
const DIRS: Choice<"dir">[] = [{ value: "all", label: "ALL" }, { value: "up", label: "UP" }, { value: "down", label: "DOWN" }];
const BASES: Choice<"basis">[] = [
  { value: "all", label: "ALL" },
  { value: "close", label: "HELD ON CLOSE", title: "The Friday close moved 50%+" },
  { value: "intraweek", label: "INTRAWEEK", title: "Only the week's high or low reached 50%: it faded by Friday" },
];
const LIQ: Choice<"liquidity">[] = [
  { value: "all", label: "ALL" },
  { value: "before", label: "LIQUID BEFORE", title: "30-day average dollar volume already over the bar" },
  { value: "move", label: "LIQUID FROM MOVE", title: "Only this week's volume cleared the bar" },
];

function Pills<K extends keyof MoverFilter>({ label, k, choices, f, set }: { label: string; k: K; choices: Choice<K>[]; f: MoverFilter; set: (f: MoverFilter) => void }) {
  return (
    <div className="pillgroup" role="group" aria-label={label}>
      <span className="label small">{label}</span>
      {choices.map((c) => (
        <button key={String(c.value)} type="button" className="pill" title={c.title} aria-pressed={f[k] === c.value} onClick={() => set({ ...f, [k]: c.value })}>
          {c.label}
        </button>
      ))}
    </div>
  );
}

/** Your trades on the ticker that were open at some point in the mover's week. */
function tradedThatWeek(trades: Trade[], r: MoverRow): Trade | undefined {
  return trades.find((t) => t.underlying === r.ticker && etDate(t.openedAt) <= r.weekEnd && (!t.closedAt || etDate(t.closedAt) >= r.week));
}

export function MoversPage({ data }: { data: DataBundle }) {
  const file = data.movers ?? null;
  const all = useMemo(() => moverRows(file), [file]);
  const [f, setF] = useState<MoverFilter>(NO_FILTER);
  const [shown, setShown] = useState(PAGE);
  const set = (next: MoverFilter) => {
    setF(next);
    setShown(PAGE);
  };
  const bar = file?.criteria.dollarVolume;
  const rows = useMemo(() => filterMovers(all, f, bar), [all, f, bar]);
  const filtered = JSON.stringify(f) !== JSON.stringify(NO_FILTER);
  const trades = data.derived.trades;

  const up = rows.filter((r) => r.dir === "up").length;
  const held = rows.filter((r) => r.basis === "close").length;
  const weeks = new Set(rows.map((r) => r.weekEnd)).size;

  return (
    <main className="page">
      <header className="page-head">
        <h1>MOVERS <span className="sub">/ {filtered ? `${rows.length} OF ` : ""}{all.length} MOVER{all.length === 1 ? "" : "S"}</span></h1>
      </header>
      <div className="dim small">
        US stocks that moved {file?.criteria.move ?? 50}%+ in a week, up or down, on {dollars(bar ?? 100e6)}+ average daily dollar volume (that week or the last 30 days), priced over ${file?.criteria.price ?? 5}.
        {file?.through ? <> Through the week ending {file.through}; updated every Saturday.</> : null}
      </div>

      {all.length > 0 && (
        <>
          <section className="panel statrow" aria-label="Summary">
            <div><div className="label small">MOVERS</div><div className="v">{rows.length}</div><div className="muted small">IN {weeks} WEEK{weeks === 1 ? "" : "S"}</div></div>
            <div><div className="label small">UP / DOWN</div><div className="v"><span className="gain">{up}</span> / <span className="loss">{rows.length - up}</span></div></div>
            <div title="The Friday close moved 50%+, vs. only the week's high or low"><div className="label small">HELD ON CLOSE</div><div className="v">{rows.length ? Math.round((held / rows.length) * 100) : 0}%</div><div className="muted small">{rows.length - held} INTRAWEEK ONLY</div></div>
          </section>

          <section className="panel quotes-filter plays-filter movers-filter" aria-label="Filter movers">
            <div className="row">
              <input type="search" className="input quotes-search" placeholder="Ticker…" value={f.q} onChange={(e) => set({ ...f, q: e.target.value })} aria-label="Search tickers" />
              {filtered && <button type="button" className="btn ghost tiny" onClick={() => set(NO_FILTER)}>CLEAR</button>}
            </div>
            <Pills label="DIRECTION" k="dir" choices={DIRS} f={f} set={set} />
            <Pills label="MOVE" k="basis" choices={BASES} f={f} set={set} />
            <Pills label="LIQUIDITY" k="liquidity" choices={LIQ} f={f} set={set} />
          </section>
        </>
      )}

      <section className="panel">
        {all.length === 0 ? (
          <div className="empty">
            No movers yet. <code>npm run movers -- --publish</code> writes <code>movers.json</code> to trade-history; the page fills in after the next deploy.
          </div>
        ) : rows.length === 0 ? (
          <div className="empty">No mover matches.</div>
        ) : (
          <>
            <div className="scroll-x">
              <table className="grid movers-table">
                <thead>
                  <tr>
                    <th>WEEK</th><th>TICKER</th><th className="num">MOVE</th>
                    <th className="num ph-hide" title="The week's high vs the prior week's close">HIGH</th>
                    <th className="num ph-hide" title="The week's low vs the prior week's close">LOW</th>
                    <th className="num ph-hide">PRICE</th>
                    <th className="num" title="Average daily dollar volume this week">$VOL/DAY</th>
                    <th className="num ph-hide" title="Average daily dollar volume, 21 market days ending this week">30D</th>
                    <th className="num ph-hide" title="Average daily range (high − low) / low this week">ADR</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, shown).map((r, i) => {
                    const t = tradedThatWeek(trades, r);
                    const firstOfWeek = i === 0 || rows[i - 1]!.weekEnd !== r.weekEnd;
                    return (
                      <tr key={`${r.weekEnd}-${r.ticker}`} className={firstOfWeek ? "week-first" : ""}>
                        <td className="muted">{firstOfWeek ? r.weekEnd : ""}</td>
                        <td>
                          <button type="button" className="linklike sym" title={`Show every week ${r.ticker} qualified`} onClick={() => set({ ...NO_FILTER, q: r.ticker })}>{r.ticker}</button>
                          {r.repeats > 1 && <> <span className="chip" title={`Qualified in ${r.repeats} weeks`}>×{r.repeats}</span></>}
                          {r.basis === "intraweek" && <> <span className="chip auto" title="Only the week's high or low reached the move; it faded by Friday">INTRAWEEK</span></>}
                          {t && <> <a className="chip etf" href={`#/trade/${encodeURIComponent(t.id)}`} title="You had a trade on it that week">TRADED</a></>}
                        </td>
                        <td className={`num b ${r.chg > 0 ? "gain" : r.chg < 0 ? "loss" : ""}`}>{signed(r.chg)}</td>
                        <td className="num ph-hide gain">{signed(r.hi)}</td>
                        <td className="num ph-hide loss">{signed(r.lo)}</td>
                        <td className="num ph-hide muted">{usd(r.start)} → {usd(r.end)}</td>
                        <td className="num">{dollars(r.dv5)}</td>
                        <td className="num ph-hide muted">{dollars(r.dv30)}</td>
                        <td className="num ph-hide muted">{r.adr.toFixed(1)}%</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {rows.length > shown && (
              <div className="empty">
                <button type="button" className="btn" onClick={() => setShown(shown + PAGE * 2)}>SHOW MORE ({rows.length - shown} LEFT)</button>
              </div>
            )}
          </>
        )}
      </section>
    </main>
  );
}
