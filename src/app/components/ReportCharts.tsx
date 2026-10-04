// Report-only charts in the same hand-rolled SVG as the dashboard widgets (Q22).
// Every bar has a hover title with its exact value, so nothing relies on color alone.
import type { Bucket } from "../../core/reports/breakdowns";
import { pct } from "../format";
import { HBars, pnlBar, type Bar } from "./Widgets";

export interface VBar {
  key: string;
  value: number;
  /** CSS color token: gain, loss, flat, accent, border-strong. */
  cls: string;
  title: string;
}

/** Columns from a shared zero line (P&L per day, volume per day, a histogram). */
export function VBars({ bars, label, height = 160, axis }: { bars: VBar[]; label: string; height?: number; axis?: [string, string, { text: string; frac: number }?] }) {
  if (bars.length === 0) return <div className="empty">No closed trades in range</div>;
  const W = 600, H = height, P = 4;
  const hi = Math.max(0, ...bars.map((b) => b.value));
  const lo = Math.min(0, ...bars.map((b) => b.value));
  const span = hi - lo || 1;
  const y = (v: number) => P + ((hi - v) / span) * (H - 2 * P);
  const w = W / bars.length;
  const gap = w > 4 ? Math.min(2, w * 0.2) : 0;
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ height: H }} role="img" aria-label={label}>
        {bars.map((b, i) => {
          const top = Math.min(y(b.value), y(0));
          const h = Math.max(Math.abs(y(b.value) - y(0)), b.value ? 0.8 : 0);
          return (
            <g key={b.key}>
              <rect x={i * w + gap / 2} y={top} width={Math.max(w - gap, 0.6)} height={h} style={{ fill: `var(--${b.cls})` }} />
              <rect x={i * w} y="0" width={w} height={H} fill="transparent"><title>{b.title}</title></rect>
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
    </div>
  );
}

/** Underwater curve: distance below the running peak (≤ 0), as a red area. */
export function Underwater({ days, fmt, height = 160 }: { days: Array<{ date: string; equity: number; underwater: number }>; fmt: (n: number) => string; height?: number }) {
  if (days.length === 0) return <div className="empty">No closed trades in range</div>;
  const W = 600, H = height, P = 4;
  const lo = Math.min(...days.map((d) => d.underwater));
  const span = -lo || 1;
  const y = (v: number) => P + (-v / span) * (H - 2 * P);
  const x = (i: number) => (days.length === 1 ? W / 2 : (i / (days.length - 1)) * W);
  const step = days.length > 1 ? W / (days.length - 1) : W;
  const line = days.map((d, i) => `${x(i).toFixed(1)},${y(d.underwater).toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ height: H }} role="img"
      aria-label={`Underwater curve; deepest ${fmt(lo)}`}>
      <polygon points={`${x(0).toFixed(1)},${y(0)} ${line} ${x(days.length - 1).toFixed(1)},${y(0)}`} style={{ fill: "var(--loss)", opacity: 0.25 }} />
      <polyline points={line} className="line-loss" vectorEffect="non-scaling-stroke" />
      <line x1="0" x2={W} y1={y(0)} y2={y(0)} className="chart-axis" vectorEffect="non-scaling-stroke" />
      {days.map((d, i) => (
        <rect key={d.date} x={x(i) - step / 2} y="0" width={step} height={H} fill="transparent">
          <title>{`${d.date}: ${d.underwater ? `${fmt(d.underwater)} below peak` : "at peak"} · equity ${fmt(d.equity)}`}</title>
        </rect>
      ))}
    </svg>
  );
}

/** Breakdown buckets as P&L bars; hover shows win rate, count and expectancy (SPEC §6.5). */
export function BucketBars({ buckets, fmt, unit, empty = "No closed trades in range" }: { buckets: Bucket[]; fmt: (n: number | null) => string; unit: string; empty?: string }) {
  if (!buckets.length) return <div className="empty">{empty}</div>;
  const bars: Bar[] = buckets.map((b) => ({
    key: b.key, label: b.label, value: b.total, cls: pnlBar(b.total),
    text: `${fmt(b.total)} · ${b.count}`,
    title: `${b.label}: ${b.count} ${unit}${b.count === 1 ? "" : "s"} · ${pct(b.winRate)} win (${b.wins}W/${b.losses}L) · expectancy ${fmt(b.expectancy)}`,
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
              <td className="num">{pct(b.winRate, 1)} <span className="dim">{b.wins}W/{b.losses}L</span></td>
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
