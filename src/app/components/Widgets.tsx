// Range-driven widgets (SPEC §6.1 item 6). Plain SVG so the Terminal look stays exact.
// Gain/loss are green/red by decision (Q10); every value also carries its sign and
// a direct label, so nothing relies on color alone (red↔green is weak under CVD).
import type { Attention, RangeStats } from "../../core/dashboard/dashboard";
import type { Journal, ReviewAttention } from "../../core/journal/journal";
import { useState } from "react";
import type { Quote, Trade } from "../../core/types";
import { dateOf, days, DOW, minutes, mmdd, money, pct, pnlClass, stamp, etfBadge } from "../format";

import { tradeHref } from "./OpenPositions";

export function Widget({ title, children, wide }: { title: React.ReactNode; children: React.ReactNode; wide?: boolean }) {
  return (
    <section className="panel widget" style={wide ? { gridColumn: "1 / -1" } : undefined}>
      <h2>{title}</h2>
      {children}
    </section>
  );
}

export interface CumPoint {
  date: string;
  value: number;
  cum: number;
}

/** Cumulative line from 0, with a hover band per point. `fmt` formats values ($ by default). */
export function CumulativeChart({ pts, label, fmt = money, height = 200 }: { pts: CumPoint[]; label: string; fmt?: (n: number) => string; height?: number }) {
  if (pts.length === 0) return <div className="empty">No closed trades in range</div>;
  const W = 600, H = height, P = 10;
  const vals = [0, ...pts.map((p) => p.cum)];
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const span = hi - lo || 1;
  const y = (v: number) => P + ((hi - v) / span) * (H - 2 * P);
  const x = (i: number) => (pts.length === 1 ? W / 2 : (i / (pts.length - 1)) * W);
  const last = pts[pts.length - 1]!;
  const step = pts.length > 1 ? W / (pts.length - 1) : W;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ height: H }} role="img" aria-label={`${label}, ending at ${fmt(last.cum)}`}>
      <line x1="0" x2={W} y1={y(0)} y2={y(0)} className="chart-axis" strokeDasharray="2 4" vectorEffect="non-scaling-stroke" />
      <polyline points={pts.map((p, i) => `${x(i).toFixed(1)},${y(p.cum).toFixed(1)}`).join(" ")}
        className={last.cum >= 0 ? "line-gain" : "line-loss"} vectorEffect="non-scaling-stroke" />
      {pts.map((p, i) => (
        <rect key={p.date} x={x(i) - step / 2} y="0" width={step} height={H} fill="transparent">
          <title>{`${p.date}: day ${fmt(p.value)} · total ${fmt(p.cum)}`}</title>
        </rect>
      ))}
    </svg>
  );
}

export interface WinDay {
  date: string;
  winRate: number | null;
  wins: number;
  losses: number;
  value: number;
}

/** Win % per day as columns; days at or above the average are green. */
export function WinByDay({ days, avg, fmt = money }: { days: WinDay[]; avg: number | null; fmt?: (n: number) => string }) {
  if (days.length === 0) return <div className="empty">No closed trades in range</div>;
  return (
    <div style={{ position: "relative", height: 200, display: "flex", alignItems: "flex-end", gap: days.length > 60 ? 0 : 2, overflow: "hidden", borderBottom: "1px solid var(--border-strong)" }}
      role="img" aria-label={`Win rate by day; average ${pct(avg)}`}>
      {avg !== null && (
        <div style={{ position: "absolute", left: 0, right: 0, bottom: `${avg * 100}%`, borderTop: "1px dashed var(--accent)" }} />
      )}
      {days.map((d) => (
        <div key={d.date} title={`${d.date}: ${pct(d.winRate)} · ${d.wins}W ${d.losses}L · ${fmt(d.value)}`}
          style={{
            flex: "1 1 0", minWidth: 0, height: `${Math.max(1, (d.winRate ?? 0) * 100)}%`,
            background: d.winRate === null ? "var(--border)" : avg !== null && d.winRate >= avg ? "var(--gain)" : "var(--border-strong)",
          }} />
      ))}
    </div>
  );
}

function Donut({ r }: { r: RangeStats }) {
  const s = r.summary;
  const total = s.wins + s.losses + s.breakevens;
  if (!total) return <div className="empty">No closed trades in range</div>;
  const R = 50, C = 2 * Math.PI * R;
  const parts = [
    { n: s.wins, cls: "s-gain", label: "WIN" },
    { n: s.losses, cls: "s-loss", label: "LOSS" },
    { n: s.breakevens, cls: "", label: "BE" },
  ];
  let off = 0;
  return (
    <div style={{ display: "flex", gap: 20, alignItems: "center", flexWrap: "wrap" }}>
      <svg viewBox="0 0 120 120" style={{ width: 140, flex: "0 0 140px" }} role="img"
        aria-label={`${s.wins} wins, ${s.losses} losses, ${s.breakevens} breakeven`}>
        {parts.map((p) => {
          const len = (p.n / total) * C;
          const gap = p.n && p.n < total ? 2 : 0;
          const el = (
            <circle key={p.label} cx="60" cy="60" r={R} fill="none" strokeWidth="14" className={p.cls}
              style={p.cls ? undefined : { stroke: "var(--flat)" }}
              strokeDasharray={`${Math.max(0, len - gap)} ${C}`} strokeDashoffset={-off} transform="rotate(-90 60 60)">
              <title>{`${p.label}: ${p.n}`}</title>
            </circle>
          );
          off += len;
          return el;
        })}
        {/* One win % everywhere: wins ÷ (wins + losses), the tile's and the gauges' figure (#16). */}
        <text x="60" y="66" textAnchor="middle" className="donut-value">{pct(s.winRate, 1)}</text>
      </svg>
      <div className="donut-legend">
        <span><span className="dot bg-win" /> WIN <b>{s.wins}</b></span>
        <span><span className="dot bg-loss" /> LOSS <b>{s.losses}</b></span>
        <span><span className="dot bg-breakeven" /> BE <b>{s.breakevens}</b> <span className="muted">(excluded)</span></span>
      </div>

    </div>
  );
}

export interface Bar {
  key: string;
  label: React.ReactNode;
  value: number;
  text: string;
  cls: string;
  title?: string;
}

/** Horizontal bars from a shared zero line; values in text ink beside each bar. */
export function HBars({ bars }: { bars: Bar[] }) {
  const max = Math.max(...bars.map((b) => Math.abs(b.value)), 0) || 1;
  const hasNeg = bars.some((b) => b.value < 0);
  const hasPos = bars.some((b) => b.value > 0);
  const zero = hasNeg && hasPos ? 50 : hasNeg ? 100 : 0;
  const scale = hasNeg && hasPos ? 50 : 100;
  return (
    <div className="hbars">
      {bars.map((b) => {
        const w = (Math.abs(b.value) / max) * scale;
        const left = b.value < 0 ? zero - w : zero;
        return [
          <span key={`${b.key}l`} className="muted">{b.label}</span>,
          <div key={`${b.key}b`} className="hbar" title={b.title}>
            <div className="zero" style={{ left: `${zero}%` }} />
            <div className="fill" style={{ left: `${left}%`, width: `${Math.max(w, b.value ? 0.5 : 0)}%`, background: `var(--${b.cls})` }} />
          </div>,
          <span key={`${b.key}v`} className="num">{b.text}</span>,
        ];
      })}
    </div>
  );
}

export const pnlBar = (v: number) => (v > 0 ? "gain" : v < 0 ? "loss" : "flat");

export function TradeLink({ t }: { t: Trade | null }) {
  if (!t) return <span className="muted">—</span>;
  return (
    <a href={tradeHref(t.id)} className="sym">
      {t.symbol}<span className="tag"> {etfBadge(t)} {mmdd(dateOf(t.closedAt!))}</span>
    </a>
  );
}

/** Largest gain and loss as two bars from one zero line, each linked to its trade (#15: the half-gauge had no scale). */
function Largest({ r }: { r: RangeStats }) {
  if (!r.largestGain && !r.largestLoss) return <div className="empty">No closed trades in range</div>;
  const bars: Bar[] = [
    { key: "g", label: <>BEST <TradeLink t={r.largestGain} /></>, value: r.largestGain?.netPnl ?? 0, text: money(r.largestGain?.netPnl ?? null), cls: "gain" },
    { key: "l", label: <>WORST <TradeLink t={r.largestLoss} /></>, value: r.largestLoss?.netPnl ?? 0, text: money(r.largestLoss?.netPnl ?? null), cls: "loss" },
  ];
  return <HBars bars={bars} />;
}

function HoldTimes({ r }: { r: RangeStats }) {
  const d = r.hold.day, s = r.hold.swing;
  const bars: Bar[] = [
    { key: "dw", label: "DAY · WINNERS", value: d.winners ?? 0, text: minutes(d.winners), cls: "gain" },
    { key: "dl", label: "DAY · LOSERS", value: d.losers ?? 0, text: minutes(d.losers), cls: "loss" },
  ];
  const sbars: Bar[] = [
    { key: "sw", label: "SWING · WINNERS", value: s.winners ?? 0, text: days(s.winners), cls: "gain" },
    { key: "sl", label: "SWING · LOSERS", value: s.losers ?? 0, text: days(s.losers), cls: "loss" },
  ];
  return (
    <>
      {(d.winners !== null || d.losers !== null) && <HBars bars={bars} />}
      {(s.winners !== null || s.losers !== null) && <HBars bars={sbars} />}
      <div className="dim small">Day: Webull fill times. Swing: calendar days.</div>
    </>
  );
}

export function StatRow({ r }: { r: RangeStats }) {
  const s = r.summary;
  const items = [
    { label: "NET P&L", value: money(s.netPnl), sub: `${s.closed} TRADE${s.closed === 1 ? "" : "S"}`, cls: pnlClass(s.netPnl) },
    { label: "WIN %", value: pct(s.winRate, 1), sub: `${s.wins}W ${s.losses}L${s.breakevens ? ` ${s.breakevens}BE` : ""}`, cls: "" },
    { label: "PROFIT FACTOR", value: r.profitFactor?.toFixed(2) ?? (s.wins ? "∞" : "—"), sub: "", cls: "" },
    {
      label: "AVG WIN / LOSS", value: `${money(r.avgWin)} / ${money(r.avgLoss)}`,
      sub: r.avgWin && r.avgLoss ? `${(r.avgWin / Math.abs(r.avgLoss)).toFixed(2)}×` : "", cls: "",
    },
    { label: "DAY HOLD", value: `WIN ${minutes(r.hold.day.winners)} / LOSS ${minutes(r.hold.day.losers)}`, sub: "", cls: "" },
    { label: "BEST / WORST", value: `${money(r.largestGain?.netPnl ?? null)} / ${money(r.largestLoss?.netPnl ?? null)}`, sub: "", cls: "" },
  ];
  return (
    <section className="panel statrow" aria-label="Key stats">
      {items.map((i) => (
        <div key={i.label}>
          <div className="label small">{i.label}</div>
          <div className={`v ${i.cls}`}>{i.value}</div>
          {i.sub && <div className="muted small">{i.sub}</div>}
        </div>
      ))}
    </section>
  );
}

const reviewHref = (id: string) => `#/journal/${encodeURIComponent(id)}`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

interface AttentionProps {
  a: Attention;
  reviews: ReviewAttention;
  journal: Journal;
  quotes: Record<string, Quote>;
  /** Trades dated today without a review (what `#/trades?range=today&review=no` lists). */
  unreviewedToday: number;
}

/** Everything Needs attention lists, one line each (SPEC §6.1). */
function attentionRows({ a, reviews, journal, quotes, unreviewedToday }: AttentionProps): React.ReactNode[] {
  const rows: React.ReactNode[] = [];
  for (const t of a.unpriced) rows.push(<div key={`u${t.id}`}><span className="half">!</span> <a className="sym" href={tradeHref(t.id)}>{t.symbol}</a> open position not priced (run <code>npm run quotes</code>)</div>);
  for (const t of a.stale) {
    const q = quotes[t.symbol];
    rows.push(<div key={`s${t.id}`}><span className="half">!</span> <a className="sym" href={tradeHref(t.id)}>{t.symbol}</a> price stale{q ? ` (${stamp(q.time)})` : ""}</div>);
  }
  for (const t of a.unmatched) rows.push(<div key={`m${t.id}`}><span className="loss">!</span> <a className="sym" href={tradeHref(t.id)}>{t.symbol}</a> {dateOf(t.openedAt)} unmatched sell (fix with openingPositions)</div>);
  if (a.heldOvernight.length) {
    rows.push(<div key="ho"><span className="accent">i</span> {plural(a.heldOvernight.length, "day trade")} held overnight: keep as DAY? <a href="#/trades?flag=overnight">REVIEW ›</a></div>);
  }
  if (unreviewedToday) {
    rows.push(<div key="ur"><span className="accent">i</span> {plural(unreviewedToday, "unreviewed trade")} today <a href="#/trades?range=today&review=no">REVIEW ›</a></div>);
  }
  for (const r of reviews.openButClosed) {
    const idea = journal.ideaById.get(journal.reviews.ideaOf.get(r.id) ?? "");
    const closes = (idea?.tradeIds ?? []).map((id) => journal.tradeById.get(id)?.closedAt).filter((c): c is string => !!c).sort();
    const closedOn = closes.length ? ` closed ${mmdd(dateOf(closes[closes.length - 1]!))}` : " closed";
    rows.push(
      <div key={`ro${r.id}`}>
        <span className="half">!</span> <a className="sym" href={reviewHref(r.id)}>{r.ticker}</a> idea from {r.date ? mmdd(r.date) : "?"}{closedOn}: write
        the exit (<code>/playbook-review {r.ticker}</code>)
      </div>,
    );
  }
  for (const r of reviews.unmatched) {
    rows.push(<div key={`ru${r.id}`}><span className="half">!</span> <a className="sym" href={reviewHref(r.id)}>{r.ticker ?? r.id}</a> {r.date ?? ""} review matches no idea: check its date and ticker</div>);
  }
  for (const m of reviews.multiple) {
    const idea = journal.ideaById.get(m.ideaId);
    rows.push(<div key={`rm${m.ideaId}`}><span className="accent">i</span> {idea?.underlying} {idea?.date} idea has {m.reviews.length} reviews: {m.reviews.map((r, i) => <span key={r.id}>{i ? ", " : ""}<a href={reviewHref(r.id)}>{r.id}</a></span>)}</div>);
  }
  return rows;
}

/**
 * Needs attention, pinned under the gauges as one line that opens into the list (#15, SPEC §6.1).
 * Nothing renders when nothing needs attention.
 */
export function AttentionBar(p: AttentionProps) {
  const [open, setOpen] = useState(false);
  const rows = attentionRows(p);
  if (!rows.length) return null;
  return (
    <section className="panel attention-bar" aria-label="Needs attention">
      <button type="button" className="attention-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="half b">!</span> <span className="label">Needs attention</span> <b>{plural(rows.length, "item").toUpperCase()}</b>{" "}
        <span className="accent">{open ? "▾" : "›"}</span>
      </button>
      {open && <div className="attention">{rows}</div>}
    </section>
  );
}

export function WidgetGrid({ r }: { r: RangeStats }) {
  const dowBars: Bar[] = r.byDayOfWeek.map((b) => ({
    key: String(b.dow), label: DOW[b.dow], value: b.net, cls: pnlBar(b.net),
    text: `${money(b.net)} · ${b.trades}`, title: `${plural(b.trades, "trade")} · ${pct(b.winRate)} win`,
  }));
  const durBars: Bar[] = r.byDuration.filter((b) => b.trades).map((b) => ({
    key: b.bucket, label: b.bucket, value: b.net, cls: pnlBar(b.net),
    text: `${money(b.net)} · ${b.trades}`, title: `${plural(b.trades, "trade")} · ${pct(b.winRate)} win`,
  }));
  const avgBars: Bar[] = [
    { key: "w", label: "AVG WIN", value: r.avgWin ?? 0, text: money(r.avgWin), cls: "gain" },
    { key: "l", label: "AVG LOSS", value: r.avgLoss ?? 0, text: money(r.avgLoss), cls: "loss" },
  ];
  const last = r.cumulative[r.cumulative.length - 1];
  return (
    <>
      <StatRow r={r} />
      <div className="widgets">
        <Widget title={<>Cumulative P&amp;L · {r.days} days · <span className={pnlClass(last?.cum)}>{money(last?.cum ?? 0)}</span></>}>
          <CumulativeChart pts={r.cumulative.map((p) => ({ date: p.date, value: p.net, cum: p.cum }))} label={`Cumulative P&L over ${r.days} days`} />
        </Widget>
        <Widget title={<>Daily win % · avg {pct(r.summary.winRate)} <span className="accent">┄</span></>}>
          <WinByDay days={r.winByDay.map((d) => ({ ...d, value: d.net }))} avg={r.summary.winRate} />
        </Widget>
        <Widget title="Winning vs losing trades"><Donut r={r} /></Widget>
        <Widget title="Hold time · winners vs losers"><HoldTimes r={r} /></Widget>
        <Widget title="Average winning vs losing trade"><HBars bars={avgBars} /></Widget>
        <Widget title="Largest gain vs largest loss"><Largest r={r} /></Widget>
        <Widget title="P&L by weekday (P&L · trades)"><HBars bars={dowBars} /></Widget>
        <Widget title="P&L by hold time (P&L · trades)">
          {durBars.length ? <HBars bars={durBars} /> : <div className="empty">No closed trades in range</div>}
        </Widget>
      </div>
    </>
  );
}
