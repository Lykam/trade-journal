import { useMemo } from "react";
import { weekStart } from "../../core/calendar";
import { needsAttention, openPositions, openTotals, rangeStats, recentTrades } from "../../core/dashboard/dashboard";
import { computeGauges } from "../../core/gauge/gauge";
import { etDate } from "../../core/normalize/util";
import type { DataBundle } from "../../core/types";
import { GaugeCard } from "../components/Gauge";
import { OpenQuick } from "../components/OpenPositions";
import { RecentTen } from "../components/Recent";
import { WeekStrip } from "../components/WeekStrip";
import { WidgetGrid } from "../components/Widgets";
import { usePersisted } from "../data";

const RANGES = ["30", "60", "90"] as const;

export function Dashboard({ data, now }: { data: DataBundle; now: string }) {
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
  const wk = gauges.day.week;

  return (
    <main className="page">
      <header className="page-head">
        <h1>DASHBOARD <span className="sub">/ WK OF {wk.start} – {wk.end}</span></h1>
      </header>

      <div className="gauges">
        <GaugeCard g={gauges.day} config={data.config} />
        <GaugeCard g={gauges.swing} config={data.config} />
      </div>
      <OpenQuick rows={rows} totals={totals} />
      <RecentTen day={recent.day} swing={recent.swing} />

      <WeekStrip trades={trades} today={today} startsOn={data.config.weekStartsOn} key={weekStart(today)} />

      <header className="page-head" style={{ marginTop: 8 }}>
        <h2 className="label">Last {range} days</h2>
        <div className="seg" role="group" aria-label="Range">
          {RANGES.map((r) => (
            <button key={r} type="button" aria-pressed={range === r} onClick={() => setRange(r)}>{r}D</button>
          ))}
        </div>
      </header>
      <WidgetGrid r={stats} attention={attention} />
    </main>
  );
}
