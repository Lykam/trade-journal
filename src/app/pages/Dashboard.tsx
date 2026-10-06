import { useMemo, useState } from "react";
import { accountValues } from "../../core/account/value";
import { weekStart } from "../../core/calendar";
import { needsAttention, openPositions, openTotals, rangeStats, recentTrades } from "../../core/dashboard/dashboard";
import { computeGauges } from "../../core/gauge/gauge";
import { emptyFilter } from "../../core/journal/filter";
import { filterTrades, reviewAttention, reviewDates, type Journal } from "../../core/journal/journal";
import { etDate } from "../../core/normalize/util";
import type { DataBundle } from "../../core/types";
import { GaugeCard } from "../components/Gauge";
import { OpenQuick } from "../components/OpenPositions";
import { RecentTen } from "../components/Recent";
import { WeekStrip } from "../components/WeekStrip";
import { AttentionBar, WidgetGrid } from "../components/Widgets";
import { mmdd } from "../format";
import { usePersisted } from "../data";
import { DEMO_REFRESH_NOTE } from "../demo-text";
import { refreshPrices, useDeploy, useToken } from "../github";

/** Optional (SPEC §5.4): shown only when a token may start prices.yml. */
function RefreshPrices() {
  const token = useToken();
  const deploy = useDeploy();
  const [error, setError] = useState<string | null>(null);
  if (token.status !== "ok" || !token.record.actions) return null;
  const record = token.record;
  return (
    <span className="row">
      <button
        type="button"
        className="btn"
        disabled={deploy?.phase === "waiting"}
        onClick={() => { setError(null); refreshPrices(record).catch((e) => setError((e as Error).message)); }}
        title="Start the prices workflow now; new prices appear after its deploy (1–2 min)"
      >
        REFRESH PRICES
      </button>
      {error && <span className="loss small">{error}</span>}
    </span>
  );
}

/** Demo build: the button, disabled, with its reason. */
function DemoRefreshPrices() {
  return <button type="button" className="btn" disabled title={DEMO_REFRESH_NOTE}>REFRESH PRICES</button>;
}

const RefreshButton = __TJ_DEMO__ ? DemoRefreshPrices : RefreshPrices;

const RANGES = ["30", "60", "90"] as const;
const STYLES = ["all", "day", "swing"] as const;

export function Dashboard({ data, journal, now }: { data: DataBundle; journal: Journal; now: string }) {
  const trades = data.derived.trades;
  const quotes = data.quotes?.quotes ?? {};
  const [range, setRange] = usePersisted("tj.range", "30", RANGES);
  const [style, setStyle] = usePersisted("tj.rangeStyle", "all", STYLES);
  const today = etDate(now);

  const gauges = useMemo(() => computeGauges({ trades, config: data.config, now, quotes }), [trades, data.config, now, quotes]);
  const accounts = useMemo(() => accountValues(trades, data.config, quotes, now), [trades, data.config, quotes, now]);
  const rows = useMemo(() => openPositions(trades, quotes, now, accounts), [trades, quotes, now, accounts]);
  const totals = useMemo(() => openTotals(rows), [rows]);
  const recent = useMemo(() => ({ day: recentTrades(trades, "day"), swing: recentTrades(trades, "swing") }), [trades]);
  const stats = useMemo(() => rangeStats(trades, Number(range), now, style === "all" ? null : style), [trades, range, now, style]);
  const unreviewedToday = useMemo(() => filterTrades(journal, { ...emptyFilter(), preset: "today", review: "no" }).length, [journal]);
  const attention = useMemo(() => needsAttention(trades, rows, now), [trades, rows, now]);
  const reviews = useMemo(() => ({ attention: reviewAttention(journal), dates: reviewDates(journal) }), [journal]);
  const wk = gauges.day.week;

  return (
    <main className="page">
      <header className="page-head">
        <h1>DASHBOARD <span className="sub">/ WEEK {mmdd(wk.start)} – {mmdd(wk.end)}</span></h1>
        <RefreshButton />
      </header>

      <div className="gauges">
        <GaugeCard g={gauges.day} config={data.config} />
        <GaugeCard g={gauges.swing} config={data.config} />
      </div>
      <AttentionBar a={attention} reviews={reviews.attention} journal={journal} quotes={quotes} unreviewedToday={unreviewedToday} />
      <OpenQuick rows={rows} totals={totals} accounts={accounts} />
      <RecentTen day={recent.day} swing={recent.swing} journal={journal} />

      <WeekStrip trades={trades} today={today} startsOn={data.config.weekStartsOn} reviewDates={reviews.dates} key={weekStart(today)} />

      <header className="page-head range-head">
        <h2 className="label">Last {range} days{style === "all" ? "" : ` · ${style}`}</h2>
        <div className="row">
          {/* Everything above is split by style; this block can be too (#15). */}
          <div className="seg" role="group" aria-label="Style">
            {STYLES.map((s) => (
              <button key={s} type="button" aria-pressed={style === s} onClick={() => setStyle(s)}>{s.toUpperCase()}</button>
            ))}
          </div>
          <div className="seg" role="group" aria-label="Range">
            {RANGES.map((r) => (
              <button key={r} type="button" aria-pressed={range === r} onClick={() => setRange(r)}>{r}D</button>
            ))}
          </div>
        </div>
      </header>
      <WidgetGrid r={stats} />
    </main>
  );
}
