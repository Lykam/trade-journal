// The COT page's chart (SPEC §6.7d): each trader group's net contracts by week,
// like the top pane of a COT indicator. Large specs and commercials as columns
// (blue, red), small traders as a yellow step line, zero line across. Drawn in
// pixels at the measured width so text stays sharp; a crosshair readout gives
// each week's nets and ranks.
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { rankSeries, type BoardWeek, type RankBasis } from "../../core/cot/board";

const MINUS = "−";
const sign = (n: number) => (n > 0 ? "+" : n < 0 ? MINUS : "");
export const contracts = (n: number | null) => (n === null ? "—" : `${sign(n)}${Math.abs(Math.round(n)).toLocaleString("en-US")}`);
const compact = (n: number) => {
  const a = Math.abs(n);
  const trim = (v: number, d: number) => v.toFixed(d).replace(/\.0$/, "");
  const s = a >= 1e6 ? `${trim(a / 1e6, a >= 1e7 ? 0 : 1)}M` : a >= 1e3 ? `${trim(a / 1e3, a >= 1e5 ? 0 : 1)}K` : a.toFixed(0);
  return `${n < 0 ? MINUS : ""}${s}`;
};
export const futPrice = (n: number | null) =>
  n === null ? "—" : Math.abs(n) >= 1000 ? n.toLocaleString("en-US", { maximumFractionDigits: 1 }) : Math.abs(n) >= 10 ? n.toFixed(2) : n.toPrecision(4);
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth);
    const ro = new ResizeObserver((entries) => setW(Math.floor(entries[0]!.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/** A few round values spanning [lo, hi]. */
function ticks(lo: number, hi: number, n = 4): number[] {
  const span = hi - lo || Math.abs(hi) || 1;
  const raw = span / n;
  const mag = 10 ** Math.floor(Math.log10(raw));
  // A little under `raw` is fine: it keeps at least n − 1 gridlines on a wide range (a 3Y chart got only three).
  const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((s) => s >= raw * 0.7) ?? 10 * mag;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Number(v.toPrecision(12)));
  return out;
}

export interface CotChartProps {
  name: string;
  weeks: BoardWeek[];
  /** Weeks shown, from the latest back. */
  range: number;
  /** For the ranks in the readout. */
  lookback: number;
  basis: RankBasis;
}

export function CotChart({ name, weeks, range, lookback, basis }: CotChartProps) {
  const [host, width] = useWidth<HTMLDivElement>();
  const [at, setAt] = useState<number | null>(null);

  // Only reported weeks: the current week has no report yet, and the bars end at the last one.
  const series = useMemo(() => {
    const spec = rankSeries(weeks, "spec", lookback, basis);
    const comm = rankSeries(weeks, "comm", lookback, basis);
    const small = rankSeries(weeks, "small", lookback, basis);
    const idx = weeks.map((w, i) => (w.d === null ? -1 : i)).filter((i) => i >= 0).slice(-range);
    return { rows: idx.map((i) => weeks[i]!), spec: idx.map((i) => spec[i]!), comm: idx.map((i) => comm[i]!), small: idx.map((i) => small[i]!) };
  }, [weeks, range, lookback, basis]);

  const { rows } = series;
  const phone = width > 0 && width < 560;
  const R = phone ? 44 : 56;
  // Left gutter for the LONG / SHORT side labels.
  const L = phone ? 16 : 20;
  const PLOT_H = phone ? 220 : 320;
  const AXIS_H = 18;
  const H = PLOT_H + AXIS_H;
  const plotW = Math.max(1, width - L - R);
  const step = plotW / Math.max(1, rows.length);
  const cx = (i: number) => L + (i + 0.5) * step;

  const nets = rows.flatMap((r) => [r.spec, r.comm, r.small].filter((v): v is number => v !== null));
  const hi = Math.max(0, ...nets);
  const lo = Math.min(0, ...nets);
  const pad = (hi - lo) * 0.04 || 1;
  const y = (v: number) => 4 + ((hi + pad - v) / (hi - lo + 2 * pad)) * (PLOT_H - 8);

  let small = "";
  rows.forEach((r, i) => {
    if (r.small === null) return;
    const x0 = L + i * step;
    small += `${small ? `V${y(r.small).toFixed(1)}` : `M${x0.toFixed(1)},${y(r.small).toFixed(1)}`}H${(x0 + step).toFixed(1)}`;
  });

  // Month ticks at a regular step (1, 2, 3, 6 or 12 months) that fits the width, so
  // January (labelled with its year) is always one of them.
  const monthPx = (step * 52) / 12;
  const every = [1, 2, 3, 6, 12].find((k) => k * monthPx >= (phone ? 44 : 56)) ?? 12;
  const xTicks: { i: number; label: string }[] = [];
  rows.forEach((r, i) => {
    const prev = rows[i - 1];
    if (!prev || prev.w.slice(5, 7) === r.w.slice(5, 7)) return;
    const m = +r.w.slice(5, 7) - 1;
    if (m % every) return;
    xTicks.push({ i, label: m === 0 ? r.w.slice(0, 4) : MONTHS[m]! });
  });

  const show = at ?? rows.length - 1;
  const r = rows[show];
  const rk = (s: (number | null)[]) => (s[show] == null ? "—" : s[show]!.toFixed(0));
  const lb = lookback === 156 ? "3Y" : `${lookback}W`;
  // Each item stays on one line, so a wrapped readout breaks between items, not inside one.
  const items: [string, string][] = r
    ? [
        ["muted", `REPORT ${r.d}${at === null ? " (LATEST)" : ""}`],
        ["cot-k-spec", `SPECS ${contracts(r.spec)}`],
        ["cot-k-comm", `COMM ${contracts(r.comm)}`],
        ["cot-k-small", `SMALL ${contracts(r.small)}`],
        ["muted", `OI ${r.oi === null ? "—" : r.oi.toLocaleString("en-US")}`],
        ["muted", `${lb} RANKS ${rk(series.spec)} / ${rk(series.comm)} / ${rk(series.small)}`],
        ...(r.c !== null ? [["muted", `PRICE ${futPrice(r.c)}`] as [string, string]] : []),
      ]
    : [];
  const readout = items.map(([cls, text], i) => (
    <span key={i}>
      {i > 0 && <span className="muted"> · </span>}
      <span className={`${cls} cot-ro`}>{text}</span>
    </span>
  ));

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const i = Math.floor((e.clientX - box.left - L) / step);
    setAt(i >= 0 && i < rows.length ? i : null);
  };
  const bw = Math.max(1, Math.min(14, step * 0.66));

  return (
    <div className="chart cot-chart">
      <div className="chart-readout small" aria-live="polite">{readout}</div>
      <div ref={host} className="chart-body">
        {width > 0 && rows.length > 0 && (
          <svg
            width={width}
            height={H}
            viewBox={`0 0 ${width} ${H}`}
            role="img"
            aria-label={`${name}: weekly net contracts of large specs, commercials and small traders over ${rows.length} reports`}
            onPointerMove={onMove}
            onPointerLeave={() => setAt(null)}
          >
            <rect x={L} y={0} width={plotW} height={PLOT_H} className="cot-pane" />
            {ticks(lo, hi, phone ? 4 : 6).map((v) => (
              <g key={v}>
                <line x1={L} x2={L + plotW} y1={y(v)} y2={y(v)} className={v === 0 ? "chart-axis" : "chart-grid"} />
                <text x={width - 4} y={y(v) + 3} textAnchor="end" className="chart-text">{compact(v)}</text>
              </g>
            ))}
            {rows.map((w, i) => {
              const x = cx(i) - bw / 2;
              return (
                <g key={w.w}>
                  {w.comm !== null && <rect x={x} y={Math.min(y(0), y(w.comm))} width={bw} height={Math.abs(y(w.comm) - y(0))} className="cot-f-comm" />}
                  {w.spec !== null && <rect x={x} y={Math.min(y(0), y(w.spec))} width={bw} height={Math.abs(y(w.spec) - y(0))} className="cot-f-spec" />}
                </g>
              );
            })}
            <path d={small} className="cot-s-small" />
            {/* Which side of zero is which: net long above, net short below (rotated, read bottom to top). Left out when that side is too thin to fit the word. */}
            {[
              { label: "LONG →", top: 4, bottom: y(0) },
              { label: "← SHORT", top: y(0), bottom: PLOT_H - 4 },
            ].filter((s) => s.bottom - s.top >= 56).map((s) => {
              const cy = (s.top + s.bottom) / 2;
              const x = L / 2 + 3;
              return (
                <text key={s.label} x={x} y={cy} transform={`rotate(-90 ${x} ${cy})`} textAnchor="middle" className="chart-text cot-side">{s.label}</text>
              );
            })}
            {xTicks.map((t) => (
              <text key={`x${t.i}`} x={cx(t.i)} y={H - 4} textAnchor="middle" className="chart-text">{t.label}</text>
            ))}
            {at !== null && <line x1={cx(at)} x2={cx(at)} y1={0} y2={PLOT_H} className="crosshair" />}
          </svg>
        )}
      </div>
      <div className="chart-legend dim small">
        <span className="key cot-key-spec" /> LARGE SPECS
        <span className="key cot-key-comm" /> COMMERCIALS
        <span className="key cot-key-small" /> SMALL TRADERS
      </div>
    </div>
  );
}
