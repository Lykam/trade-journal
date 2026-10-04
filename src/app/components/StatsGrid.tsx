// The Reports stats grid (SPEC §6.5): one list of cells, shown as the 3-column
// grid on Detailed and as side-by-side columns on Compare and Win vs Loss Days.
import { viewToParams, queryOf, type ViewState } from "../../core/journal/filter";
import type { Grid, StreakRef } from "../../core/reports/grid";
import type { Unit } from "../../core/reports/units";
import { minutes, money, mmdd, pct, pnlClass, qty } from "../format";
import { tradeLink } from "../pages/TradesPage";

export interface Fmt {
  /** A unit value: $ or % return. */
  v: (n: number | null | undefined) => string;
  /** "TRADE" or "IDEA". */
  unit: string;
  view: ViewState;
}

export const holdFmt = (m: number | null) => (m === null ? "—" : m < 1440 ? minutes(m) : `${(m / 1440).toFixed(1)}d`);
const num = (n: number | null, d = 2) => (n === null ? "—" : !Number.isFinite(n) ? (n > 0 ? "∞" : "−∞") : n.toFixed(d).replace("-", "−"));

export interface Cell {
  key: string;
  label: string;
  value: React.ReactNode;
  cls?: string;
  title?: string;
}

/** Trades page for the dates a streak spans, under the current filter. */
export function streakHref(s: StreakRef, view: ViewState): string {
  const from = s.units[0]!.date, to = s.units[s.units.length - 1]!.date;
  return `#/trades${queryOf(viewToParams({ ...view, filter: { ...view.filter, preset: null, from, to }, page: 1 }))}`;
}

function UnitLink({ u, f }: { u: Unit; f: Fmt }) {
  return (
    <a href={tradeLink(u.trades[0]!.id, f.view)} title={`Open ${u.symbol} ${u.date}`}>
      {u.kind === "idea" ? u.underlying : u.symbol} {mmdd(u.date)} ↗
    </a>
  );
}

function StreakLink({ s, f }: { s: StreakRef | null; f: Fmt }) {
  if (!s) return <>—</>;
  const first = s.units[0]!.date, last = s.units[s.units.length - 1]!.date;
  return (
    <>
      {s.length}{" "}
      <a className="small" href={streakHref(s, f.view)} title={`${s.length} in a row, ${first} → ${last}: open on Trades`}>
        {mmdd(first)}{first !== last ? `→${mmdd(last)}` : ""} ↗
      </a>
    </>
  );
}

/** Every grid stat, in the spec's order (rows of three). */
export function gridCells(g: Grid, f: Fmt): Cell[] {
  const u = f.unit.toLowerCase();
  const n = (x: number, of: number | null) => `${x} (${pct(of, 1)})`;
  return [
    { key: "total", label: "Total gain/loss", value: f.v(g.total), cls: pnlClass(g.total) },
    { key: "lg", label: "Largest gain", value: g.largestGain ? <><span className="gain">{f.v(g.largestGain.value)}</span> <UnitLink u={g.largestGain.unit} f={f} /></> : "—" },
    { key: "ll", label: "Largest loss", value: g.largestLoss ? <><span className="loss">{f.v(g.largestLoss.value)}</span> <UnitLink u={g.largestLoss.unit} f={f} /></> : "—" },
    { key: "ad", label: "Avg daily gain/loss", value: f.v(g.avgDaily), cls: pnlClass(g.avgDaily), title: `Over ${g.days} trading days with closes` },
    { key: "av", label: "Avg daily volume", value: g.avgDailyVolume === null ? "—" : qty(Math.round(g.avgDailyVolume)), title: "Shares bought + sold per trading day" },
    { key: "ps", label: "Avg per-share gain/loss", value: money(g.avgPerShare), cls: pnlClass(g.avgPerShare), title: "$ P&L ÷ shares bought" },
    { key: "au", label: `Avg ${u} gain/loss`, value: f.v(g.avgUnit), cls: pnlClass(g.avgUnit) },
    { key: "aw", label: `Avg winning ${u}`, value: f.v(g.avgWin), cls: "gain" },
    { key: "al", label: `Avg losing ${u}`, value: f.v(g.avgLoss), cls: "loss" },
    { key: "n", label: `Total ${u}s`, value: String(g.count) },
    { key: "nw", label: "# winning (%)", value: n(g.wins, g.winShare), title: "Share of all, breakevens included" },
    { key: "nl", label: "# losing (%)", value: n(g.losses, g.lossShare) },
    { key: "h", label: "Avg hold (all)", value: holdFmt(g.hold.all), title: g.hold.untimed ? `${g.hold.untimed} same-day ${u}s without times left out` : undefined },
    { key: "hw", label: "Avg hold (winners)", value: holdFmt(g.hold.winners) },
    { key: "hl", label: "Avg hold (losers)", value: holdFmt(g.hold.losers) },
    { key: "be", label: "# breakeven ($0.00)", value: String(g.breakevens) },
    { key: "sw", label: "Max consecutive wins", value: <StreakLink s={g.streaks.win} f={f} /> },
    { key: "sl", label: "Max consecutive losses", value: <StreakLink s={g.streaks.loss} f={f} /> },
    { key: "sd", label: `${f.unit === "IDEA" ? "Idea" : "Trade"} P&L std dev`, value: f.v(g.stdDev).replace("+", "") },
    { key: "sqn", label: "SQN", value: num(g.sqn), title: "√n × mean ÷ std dev" },
    { key: "p", label: "Probability of random chance", value: pct(g.randomChance, 1), title: "Two-sided t-test of mean P&L ≠ 0; lower is better" },
    { key: "k", label: "Kelly %", value: pct(g.kelly, 1), title: "W − (1 − W) ÷ (avg win ÷ |avg loss|)" },
    { key: "kr", label: "K-ratio", value: num(g.kRatio), title: "Kestner 2003 on daily cumulative P&L" },
    { key: "pf", label: "Profit factor", value: g.profitFactor === null ? (g.wins ? "∞" : "—") : num(g.profitFactor) },
    { key: "fees", label: "Fees & commissions", value: money(g.fees, { sign: false }), title: "Brokers report one combined figure" },
    { key: "wr", label: "Win % (excl. BE)", value: pct(g.winRate, 1), title: "wins ÷ (wins + losses)" },
    { key: "ex", label: "Expectancy", value: f.v(g.expectancy), cls: pnlClass(g.expectancy), title: `Per decisive ${u}: W × avg win + (1 − W) × avg loss` },
  ];
}

export function StatsGrid({ g, f }: { g: Grid; f: Fmt }) {
  return (
    <section className="panel sgrid" aria-label="Stats">
      {gridCells(g, f).map((c) => (
        <div key={c.key} className="cell" title={c.title}>
          <span className="muted">{c.label}</span>
          <span className={`num b ${c.cls ?? ""}`}>{c.value}</span>
        </div>
      ))}
    </section>
  );
}

/** The grid as rows with one column per side (Compare, Win vs Loss Days). */
export function GridColumns({ sides, f }: { sides: Array<{ label: React.ReactNode; g: Grid }>; f: Fmt }) {
  const cols = sides.map((s) => gridCells(s.g, f));
  return (
    <section className="panel scroll-x">
      <table className="grid dense">
        <thead>
          <tr>
            <th>STAT</th>
            {sides.map((s, i) => <th key={i} className="num">{s.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {cols[0]!.map((c, r) => (
            <tr key={c.key}>
              <td className="muted" title={c.title}>{c.label}</td>
              {cols.map((col, i) => <td key={i} className={`num b ${col[r]!.cls ?? ""}`}>{col[r]!.value}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
