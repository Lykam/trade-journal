import { useMemo, useState } from "react";
import { weekStart } from "../../core/calendar";
import { needsAttention, openPositions, openTotals, rangeStats, recentTrades } from "../../core/dashboard/dashboard";
import { computeGauges } from "../../core/gauge/gauge";
import { reviewAttention, reviewDates, type Journal } from "../../core/journal/journal";
import { etDate } from "../../core/normalize/util";
import type { DataBundle } from "../../core/types";
import { GaugeCard } from "../components/Gauge";
import { OpenQuick } from "../components/OpenPositions";
import { RecentTen } from "../components/Recent";
import { WeekStrip } from "../components/WeekStrip";
import { WidgetGrid } from "../components/Widgets";
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

export function Dashboard({ data, journal, now }: { data: DataBundle; journal: Journal; now: string }) {
  const trades = data.derived.trades;
  const quotes = data.quotes?.quotes ?? {};
  const [range, setRange] = usePersisted("tj.range", "30", RANGES);
  const today = etDate(now);

  const gauges = useMemo(() => computeGauges({ trades, config: data.config, now, quotes }), [trades, data.config, now, quotes]);
  const rows = useMemo(() => openPositions(trades, quotes, now), [trades, quotes, now]);
  const totals = useMemo(() => openTotals(rows), [rows]);
  const recent = useMemo(() => ({ day: recentTrades(trades, "day"), swing: recentTrades(trades, "swing") }), [trades]);
  const stats = useMemo(() => rangeStats(trades, Number(range), now), [trades, range, now]);
  const attention = useMemo(() => needsAttention(trades, rows, now), [trades, rows, now]);
  const reviews = useMemo(() => ({ attention: reviewAttention(journal), dates: reviewDates(journal) }), [journal]);
  const wk = gauges.day.week;

  return (
    <main className="page">
      <header className="page-head">
        <h1>DASHBOARD <span className="sub">/ WK OF {wk.start} – {wk.end}</span></h1>
        <RefreshButton />
      </header>

      <div className="gauges">
        <GaugeCard g={gauges.day} config={data.config} />
        <GaugeCard g={gauges.swing} config={data.config} />
      </div>
      <OpenQuick rows={rows} totals={totals} />
      <RecentTen day={recent.day} swing={recent.swing} journal={journal} />

      <WeekStrip trades={trades} today={today} startsOn={data.config.weekStartsOn} reviewDates={reviews.dates} key={weekStart(today)} />

      <header className="page-head" style={{ marginTop: 8 }}>
        <h2 className="label">Last {range} days</h2>
        <div className="seg" role="group" aria-label="Range">
          {RANGES.map((r) => (
            <button key={r} type="button" aria-pressed={range === r} onClick={() => setRange(r)}>{r}D</button>
          ))}
        </div>
      </header>
      <WidgetGrid r={stats} attention={attention} reviews={reviews.attention} journal={journal} />
    </main>
  );
}
