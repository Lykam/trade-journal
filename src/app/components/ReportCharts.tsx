// Report-only charts in the same hand-rolled SVG as the dashboard widgets (Q22).
// Every bar has a hover title with its exact value, so nothing relies on color alone.
import type { Bucket } from "../../core/reports/breakdowns";
import { useState } from "react";
import { pct } from "../format";
import { ChartFrame, dateTicks, HBars, pnlBar, type Bar } from "./Widgets";


export interface VBar {
  key: string;
  value: number;
  /** CSS color token: gain, loss, flat, accent, border-strong. */
  cls: string;
  title: string;
}

/**
 * Columns from a shared zero line (P&L per day, volume per day, a histogram), with the
 * shared readout, edge values and ticks (#19). `ticks` are spread evenly; `axis` places a
 * middle label at a fraction of the width (the histogram's 0).
 */
export function VBars({ bars, label, height = 160, axis, ticks, fmt }: {
  bars: VBar[]; label: string; height?: number; axis?: [string, string, { text: string; frac: number }?]; ticks?: string[]; fmt?: (n: number) => string;
}) {
  const [at, setAt] = useState<number | null>(null);
  if (bars.length === 0) return <div className="empty">No closed trades in range</div>;
  const W = 600, H = height, P = 4;
  const hi = Math.max(0, ...bars.map((b) => b.value));
  const lo = Math.min(0, ...bars.map((b) => b.value));
  const span = hi - lo || 1;
  const y = (v: number) => P + ((hi - v) / span) * (H - 2 * P);
  const w = W / bars.length;
  const gap = w > 4 ? Math.min(2, w * 0.2) : 0;
  return (
    <ChartFrame readout={at === null ? null : bars[at]!.title} hi={fmt?.(hi)} lo={fmt && lo < 0 ? fmt(lo) : undefined} ticks={ticks}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ height: H }} role="img" aria-label={label} onMouseLeave={() => setAt(null)}>
        {bars.map((b, i) => {
          const top = Math.min(y(b.value), y(0));
          const h = Math.max(Math.abs(y(b.value) - y(0)), b.value ? 0.8 : 0);
          return (
            <g key={b.key}>
              <rect x={i * w + gap / 2} y={top} width={Math.max(w - gap, 0.6)} height={h} className={`f-${b.cls} ${at === i ? "bar-on" : ""}`} />
              <rect x={i * w} y="0" width={w} height={H} fill="transparent" onMouseEnter={() => setAt(i)} onClick={() => setAt(i)} />
            </g>
          );
        })}
        <line x1="0" x2={W} y1={y(0)} y2={y(0)} className="chart-axis" vectorEffect="non-scaling-stroke" />
      </svg>
      {axis && (
        <div className="axis-labels dim small">
          <span>{axis[0]}</span>
          {axis[2] && <span className="mid" style={{ left: `${axis[2].frac * 100}%` }}>{axis[2].text}</span>}
          <span>{axis[1]}</span>
        </div>
      )}
    </ChartFrame>
  );
}

/** Underwater curve: distance below the running peak (≤ 0), as a red area, with its depth on the edge (#19). */
export function Underwater({ days, fmt, height = 160 }: { days: Array<{ date: string; equity: number; underwater: number }>; fmt: (n: number) => string; height?: number }) {
  const [at, setAt] = useState<number | null>(null);
  if (days.length === 0) return <div className="empty">No closed trades in range</div>;
  const W = 600, H = height, P = 4;
  const lo = Math.min(...days.map((d) => d.underwater));
  const span = -lo || 1;
  const y = (v: number) => P + (-v / span) * (H - 2 * P);
  const x = (i: number) => (days.length === 1 ? W / 2 : (i / (days.length - 1)) * W);
  const step = days.length > 1 ? W / (days.length - 1) : W;
  const line = days.map((d, i) => `${x(i).toFixed(1)},${y(d.underwater).toFixed(1)}`).join(" ");
  const d = at === null ? null : days[at]!;
  return (
    <ChartFrame readout={d && `${d.date} · ${d.underwater ? `${fmt(d.underwater)} below peak` : "at peak"} · total ${fmt(d.equity)}`}
      hi="AT PEAK" lo={lo < 0 ? fmt(lo) : undefined} ticks={dateTicks(days.map((x) => x.date))}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ height: H }} role="img"
        aria-label={`Underwater curve; deepest ${fmt(lo)}`} onMouseLeave={() => setAt(null)}>
        <polygon points={`${x(0).toFixed(1)},${y(0)} ${line} ${x(days.length - 1).toFixed(1)},${y(0)}`} className="area-loss" />
        <polyline points={line} className="line-loss" vectorEffect="non-scaling-stroke" />
        <line x1="0" x2={W} y1={y(0)} y2={y(0)} className="chart-axis" vectorEffect="non-scaling-stroke" />
        {at !== null && <line x1={x(at)} x2={x(at)} y1="0" y2={H} className="crosshair" vectorEffect="non-scaling-stroke" />}
        {days.map((q, i) => (
          <rect key={q.date} x={x(i) - step / 2} y="0" width={step} height={H} fill="transparent" onMouseEnter={() => setAt(i)} onClick={() => setAt(i)} />
        ))}
      </svg>
    </ChartFrame>
  );
}

/** Breakdown buckets as P&L bars: "P&L · count · win %" (win % only on desktop), the rest on hover (SPEC §6.5, #19). */
export function BucketBars({ buckets, fmt, unit, empty = "No closed trades in range" }: { buckets: Bucket[]; fmt: (n: number | null) => string; unit: string; empty?: string }) {
  if (!buckets.length) return <div className="empty">{empty}</div>;
  const bars: Bar[] = buckets.map((b) => ({
    key: b.key, label: b.label, value: b.total, cls: pnlBar(b.total),
    text: <>{fmt(b.total)} · {b.count}<span className="ph-hide"> · {pct(b.winRate)}</span></>,
    title: `${b.label}: ${b.count} ${unit}${b.count === 1 ? "" : "s"} · ${pct(b.winRate)} win (${b.wins}W ${b.losses}L) · expectancy ${fmt(b.expectancy)}`,
  }));
  return <HBars bars={bars} />;
}

/** Group | count | win % | P&L | avg | expectancy. */
export function BucketTable({ buckets, fmt, unit, onRow, selected }: {
  buckets: Bucket[]; fmt: (n: number | null) => string; unit: string; onRow?: (key: string) => string; selected?: string | null;
}) {
  if (!buckets.length) return <div className="empty">No closed trades in range</div>;
  return (
    <div className="scroll-x">
      <table className="grid dense">
        <thead>
          <tr><th></th><th className="num">{unit}S</th><th className="num">WIN %</th><th className="num">P&amp;L</th><th className="num">AVG</th><th className="num">EXPECTANCY</th></tr>
        </thead>
        <tbody>
          {buckets.map((b) => (
            <tr key={b.key} className={selected === b.key ? "selected" : ""}>
              <td>{onRow ? <a href={onRow(b.key)} aria-current={selected === b.key ? "true" : undefined}>{b.label}</a> : b.label}</td>
              <td className="num">{b.count}</td>
              <td className="num">{pct(b.winRate, 1)} <span className="dim">{b.wins}W {b.losses}L</span></td>
              <td className={`num b ${b.total > 0 ? "gain" : b.total < 0 ? "loss" : "flat"}`}>{fmt(b.total)}</td>
              <td className="num">{fmt(b.avg)}</td>
              <td className="num">{fmt(b.expectancy)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
