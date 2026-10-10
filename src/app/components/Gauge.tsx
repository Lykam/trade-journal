import { useState } from "react";
import { baselineSpan, winsToFull, type Gauge as GaugeData, type SizeState } from "../../core/gauge/gauge";
import type { Config } from "../../core/types";
import { money, pct, pnlClass, pts, stamp } from "../format";

const CX = 100, CY = 100, R = 80;
const clamp = (x: number) => Math.min(1, Math.max(0, x));
/** Win rate 0…1 → point on the semicircle (0 at the left, 1 at the right). */
const at = (rate: number, r = R) => {
  const a = Math.PI * (1 - clamp(rate));
  return [CX + r * Math.cos(a), CY - r * Math.sin(a)] as const;
};
const f = (n: number) => n.toFixed(1);
function arc(from: number, to: number) {
  const [x1, y1] = at(from);
  const [x2, y2] = at(to);
  return `M${f(x1)} ${f(y1)} A${R} ${R} 0 0 1 ${f(x2)} ${f(y2)}`;
}

const STATE_LABEL: Record<SizeState, string> = { full: "FULL SIZE", half: "½ SIZE", quarter: "¼ SIZE" };

function Dial({ g, bands }: { g: GaugeData; bands: Config["gauge"]["bands"] }) {
  const base = g.baseline.winRate;
  const rate = g.stats.winRate;
  const label = `${g.style} gauge: ${pct(rate)} in the window against a ${pct(base)} baseline`;
  const segments: Array<{ from: number; to: number; cls: string; state: SizeState }> =
    base === null
      ? []
      : [
          { from: 0, to: clamp(base - bands.quarterSizeBelowPts / 100), cls: "s-loss", state: "quarter" },
          { from: clamp(base - bands.quarterSizeBelowPts / 100), to: clamp(base - bands.halfSizeBelowPts / 100), cls: "s-half", state: "half" },
          { from: clamp(base - bands.halfSizeBelowPts / 100), to: 1, cls: "s-gain", state: "full" },
        ];
  const [mx1, my1] = base === null ? [0, 0] : at(base, R - 12);
  const [mx2, my2] = base === null ? [0, 0] : at(base, R + 12);
  const [nx, ny] = rate === null ? [CX, CY] : at(rate, R - 18);
  return (
    <svg className="dial" viewBox="0 0 200 122" role="img" aria-label={label}>
      {base === null ? (
        <path d={arc(0, 1)} className="band s-muted" />
      ) : (
        segments
          .filter((s) => s.to > s.from)
          .map((s) => <path key={s.state} d={arc(s.from, s.to)} className={`band ${s.cls} ${g.state === s.state ? "" : "dimmed"}`} />)
      )}
      {base !== null && <line x1={f(mx1)} y1={f(my1)} x2={f(mx2)} y2={f(my2)} className="marker" />}
      {rate !== null && <line x1={CX} y1={CY} x2={f(nx)} y2={f(ny)} className="needle" />}
      <rect x={CX - 6} y={CY - 6} width="12" height="12" className="hub" />
      <text x={CX} y={CY - 22} textAnchor="middle" className="value">{pct(rate)}</text>
      <text x={CX - R} y={CY + 18} textAnchor="middle" className="scale">0</text>
      <text x={CX + R} y={CY + 18} textAnchor="middle" className="scale">100</text>
      {base !== null && <text x={CX} y={CY + 18} textAnchor="middle" className="scale">AVG {pct(base)}</text>}
    </svg>
  );
}

function Sparkline({ g }: { g: GaugeData }) {
  const W = 8 * 14, H = 28;
  const base = g.baseline.winRate;
  // Hovering or tapping a bar puts its week in place of the label (#19); native titles were too slow to find.
  const [at, setAt] = useState<number | null>(null);
  const p = at === null ? null : g.sparkline[at]!;
  return (
    <div className="spark">
      <svg viewBox={`0 0 ${W} ${H}`} className="spark-svg" role="img" onMouseLeave={() => setAt(null)}
        aria-label={`Weekly win rates, last 8 weeks: ${g.sparkline.map((p) => pct(p.winRate)).join(", ")}`}>
        {base !== null && <line x1="0" x2={W} y1={H - base * H} y2={H - base * H} className="chart-ref" />}
        {g.sparkline.map((p, i) => {
          const h = p.winRate === null ? 1 : Math.max(1, p.winRate * H);
          const cls = p.winRate === null ? "f-dim" : base === null || p.winRate >= base ? "f-gain" : "f-loss";
          return (
            <g key={p.weekStart}>
              <rect x={i * 14 + 2} y={H - h} width="10" height={h} className={cls} opacity={p.current || at === i ? 1 : 0.7} />
              <rect x={i * 14} y="0" width="14" height={H} fill="transparent" onMouseEnter={() => setAt(i)} onClick={() => setAt(i)} />
            </g>
          );
        })}
      </svg>
      <span className={p ? "text-2" : ""}>
        {p ? `WEEK ${p.weekStart.slice(5)}${p.current ? " (NOW)" : ""} · ${pct(p.winRate)} · ${p.wins}W ${p.losses}L` : "LAST 8 WEEKS · AVG ┄"}
      </span>
    </div>
  );
}

/** "11 CLOSED THIS WEEK" / "1 CLOSED, 6 OPEN", plus backfill: what the window holds, in decisive trades. */
function windowText(g: GaugeData, swingOpen: boolean): string {
  const c = g.counts;
  const parts = swingOpen ? [`${c.week} CLOSED`, `${c.open} OPEN`] : [`${c.week} CLOSED THIS WEEK`];
  if (c.prior) parts.push(`${c.prior} EARLIER`);
  return parts.join(", ");
}

const wl = (w: number, l: number, be = 0) => `${w}W ${l}L${be ? ` ${be}BE` : ""}`;

export function GaugeCard({ g, config }: { g: GaugeData; config: Config }) {
  const s = g.stats;
  const b = g.baseline;
  const swing = g.style === "swing";
  const swingOpen = swing && config.gauge.swingIncludesOpenPositions;
  const min = config.gauge.minSample[g.style];
  const target = winsToFull(g, config);
  const [more, setMore] = useState(false);
  return (
    <section className="panel gauge" aria-label={`${g.style} gauge`}>
      <Dial g={g} bands={config.gauge.bands} />
      <div className="body">
        <div className="label">
          {g.style} · {baselineSpan(config)} avg {pct(b.winRate)} ({wl(b.wins, b.losses)})
        </div>
        <div className={`state ${g.state ?? "none"}`}>▌{g.state ? STATE_LABEL[g.state] : "NO SIGNAL"}</div>
        <div className="muted">
          {g.delta === null ? "—" : `${pts(g.delta)} VS AVG`} · {windowText(g, swingOpen)}
        </div>
        <div className="text-2">{g.message}</div>
        {target && (
          <div className="muted" title="Wins this week that would bring the win rate back to your average, with nothing else changing">
            FULL SIZE AT <b className="text-1">{wl(target.w, target.l)}</b> (+{target.wins} WIN{target.wins === 1 ? "" : "S"})
          </div>
        )}
        <button type="button" className="btn ghost small more-toggle" aria-expanded={more} onClick={() => setMore(!more)}>
          {more ? "▾ LESS" : "▸ STATS"}
        </button>
        <div className={`more ${more ? "show" : ""}`}>
          <div className="stats">
            {swing ? (
              <span>
                CLOSED <b>{wl(s.closed.wins, s.closed.losses)}</b> · OPEN <b>{wl(s.open.wins, s.open.losses)}</b>
              </span>
            ) : (
              <span><b>{wl(s.wins, s.losses, s.breakevens)}</b></span>
            )}
            <span>REALIZED <b className={pnlClass(s.realized)}>{money(s.realized)}</b></span>
            {swing && <span>UNREALIZED <b className={pnlClass(s.unrealized)}>{money(s.unrealized)}</b></span>}
            <span>AVG WIN <b>{money(s.avgWin)}</b></span>
            <span>AVG LOSS <b>{money(s.avgLoss)}</b></span>
            <span>PROFIT FACTOR <b>{s.profitFactor ?? (s.wins ? "∞" : "—")}</b></span>
            <span>EXPECTANCY <b className={pnlClass(s.expectancy)}>{money(s.expectancy)}</b></span>
          </div>
          <div className="notes">
            {g.counts.prior > 0 && (
              <span className="dim" title={`Until this week has ${min} decided trades, the latest earlier ones fill the window (Q20)`}>
                {g.counts.prior} EARLIER TRADE{g.counts.prior === 1 ? "" : "S"} FILL IN UNTIL THIS WEEK HAS {min}
              </span>
            )}
            {swingOpen && g.counts.open > 0 && <span className="dim">OPEN POSITIONS COUNT AT THE LAST PRICE</span>}
            {swing && g.pricesAsOf && (
              <span className="dim">
                PRICES {stamp(g.pricesAsOf)}
                {g.stale.length > 0 && <span className="half"> · {g.stale.length} STALE</span>}
              </span>
            )}
            {swing && g.unpriced.length > 0 && (
              <span className="half">
                {g.unpriced.length} open position{g.unpriced.length === 1 ? "" : "s"} not priced
              </span>
            )}
            {b.lowConfidence && (
              <span className="dim">LOW-CONFIDENCE AVERAGE: {b.wins + b.losses} trades {config.gauge.baselineDays === null ? "all time" : `in ${config.gauge.baselineDays} days`} (&lt; 20)</span>
            )}
          </div>
          <Sparkline g={g} />
        </div>
      </div>
    </section>
  );
}
