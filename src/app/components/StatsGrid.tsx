// The Reports stats grid (SPEC §6.5): one list of cells, shown as the 3-column
// grid on Detailed and as side-by-side columns on Compare and Win vs Loss Days.
import { viewToParams, queryOf, type ViewState } from "../../core/journal/filter";
import type { Grid, Holds, StreakRef } from "../../core/reports/grid";
import type { Unit } from "../../core/reports/units";
import { minutes, money, mmdd, pct, pnlClass, qty } from "../format";
import { tradeLink } from "../pages/TradesPage";

export interface Fmt {
  /** A unit value: $ or % return. */
  v: (n: number | null | undefined) => string;
  /** "TRADE" or "IDEA". */
  unit: string;
  view: ViewState;
  /** % mode: totals are sums of per-trade returns, not account returns, and say so (#16). */
  pct?: boolean;
}

export const holdFmt = (m: number | null) => (m === null ? "—" : m < 1440 ? minutes(m) : `${(m / 1440).toFixed(1)}d`);

/** A hold average, split "day 39m · swing 16.0d" when both styles are in it (#16). */
export function holdText(h: Grid["hold"], key: keyof Holds): string {
  if (!h.byStyle) return holdFmt(h[key]);
  return `day ${holdFmt(h.byStyle.day[key])} · swing ${holdFmt(h.byStyle.swing[key])}`;
}
const num = (n: number | null, d = 2) => (n === null ? "—" : !Number.isFinite(n) ? (n > 0 ? "∞" : "−∞") : n.toFixed(d).replace("-", "−"));

export interface Cell {
  key: string;
  label: string;
  value: React.ReactNode;
  cls?: string;
  title?: string;
  /** The number behind the value and how to show a difference of two, for Compare's B − A column (#18). */
  num?: { v: number | null; diff: (d: number) => string };
}

const MINUS = "−";

/** Fewer units than this and ratio stats (PF, SQN, Kelly) are shown grayed (#20). */
export const SMALL_SAMPLE = 10;
export const small = (g: Grid) => g.count < SMALL_SAMPLE;
export const smallTitle = (g: Grid) => (small(g) ? `Only ${g.count}: too few to mean much` : g.profitFactor === null && g.wins ? "No losses" : undefined);
const signedCount = (d: number) => `${d > 0 ? "+" : d < 0 ? MINUS : ""}${Math.abs(d)}`;
const signedNum = (d: number) => `${d > 0 ? "+" : d < 0 ? MINUS : ""}${Math.abs(d).toFixed(2)}`;
const signedPts = (d: number) => `${d > 0 ? "+" : d < 0 ? MINUS : ""}${(Math.abs(d) * 100).toFixed(1)} pts`;

/** Trades page for the dates a streak spans, under the current filter. */
export function streakHref(s: StreakRef, view: ViewState): string {
  const from = s.units[0]!.date, to = s.units[s.units.length - 1]!.date;
  return `#/trades${queryOf(viewToParams({ ...view, filter: { ...view.filter, preset: null, from, to }, page: 1 }))}`;
}

function UnitLink({ u, f }: { u: Unit; f: Fmt }) {
  return (
    <a href={tradeLink(u.trades[0]!.id, f.view)} title={`Open ${u.symbol} ${u.date}`}>
      {u.kind === "idea" ? u.underlying : u.symbol} <span className="nowrap">{mmdd(u.date)} ↗</span>
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
        <span className="nowrap">{mmdd(first)}{first !== last ? `→${mmdd(last)}` : ""} ↗</span>
      </a>
    </>
  );
}

/** Every grid stat, in the spec's order (rows of three). */
export function gridCells(g: Grid, f: Fmt): Cell[] {
  const u = f.unit.toLowerCase();
  const sumPct = f.pct ? { title: `A sum of per-${u} % returns, not a return on the account` } : {};
  const val = (v: number | null) => ({ num: { v, diff: (d: number) => f.v(d) } });
  const count = (v: number) => ({ num: { v, diff: signedCount } });
  const plain = (v: number | null) => ({ num: { v, diff: signedNum } });
  const cells: Cell[] = [
    { key: "total", label: f.pct ? `Sum of ${u} %` : "Total gain/loss", value: f.v(g.total), cls: pnlClass(g.total), ...sumPct, ...val(g.total) },
    { key: "lg", label: "Largest gain", value: g.largestGain ? <><span className="gain">{f.v(g.largestGain.value)}</span> <UnitLink u={g.largestGain.unit} f={f} /></> : "—" },
    { key: "ll", label: "Largest loss", value: g.largestLoss ? <><span className="loss">{f.v(g.largestLoss.value)}</span> <UnitLink u={g.largestLoss.unit} f={f} /></> : "—" },
    { key: "ad", label: f.pct ? `Avg daily sum of ${u} %` : "Avg daily gain/loss", value: f.v(g.avgDaily), cls: pnlClass(g.avgDaily), title: `Over ${g.days} days with closes`, ...val(g.avgDaily) },
    { key: "av", label: "Avg daily volume", value: g.avgDailyVolume === null ? "—" : qty(Math.round(g.avgDailyVolume)), title: "Shares bought + sold per trading day" },
    { key: "ps", label: "Avg per-share gain/loss", value: money(g.avgPerShare), cls: pnlClass(g.avgPerShare), title: "$ P&L ÷ shares bought" },
    { key: "au", label: `Avg ${u} gain/loss`, value: f.v(g.avgUnit), cls: pnlClass(g.avgUnit), ...val(g.avgUnit) },
    { key: "aw", label: `Avg winning ${u}`, value: f.v(g.avgWin), cls: "gain", ...val(g.avgWin) },
    { key: "al", label: `Avg losing ${u}`, value: f.v(g.avgLoss), cls: "loss", ...val(g.avgLoss) },
    { key: "n", label: `Total ${u}s`, value: String(g.count), ...count(g.count) },
    { key: "nw", label: "Winners", value: String(g.wins), ...count(g.wins) },
    { key: "nl", label: "Losers", value: String(g.losses), ...count(g.losses) },
    { key: "h", label: "Avg hold (all)", value: holdText(g.hold, "all"), title: g.hold.untimed ? `${g.hold.untimed} same-day ${u}s without times left out` : undefined },
    { key: "hw", label: "Avg hold (winners)", value: holdText(g.hold, "winners") },
    { key: "hl", label: "Avg hold (losers)", value: holdText(g.hold, "losers") },
    { key: "be", label: "Breakeven", value: String(g.breakevens), title: "Exactly $0.00 net; left out of win %" },
    { key: "sw", label: "Max consecutive wins", value: <StreakLink s={g.streaks.win} f={f} /> },
    { key: "sl", label: "Max consecutive losses", value: <StreakLink s={g.streaks.loss} f={f} /> },
    { key: "sd", label: `${f.unit === "IDEA" ? "Idea" : "Trade"} P&L std dev`, value: f.v(g.stdDev).replace("+", "") },
    {
      key: "sqn", label: "SQN", value: num(g.sqn), cls: small(g) ? "dim" : "", ...plain(g.sqn),
      title: smallTitle(g) ?? "System quality: how steady the edge is. √n × mean ÷ std dev of P&L",
    },
    { key: "p", label: "Chance it's luck", value: pct(g.randomChance, 1), title: "Chance of results this good if the true average were 0 (two-sided t-test); lower is better" },
    {
      key: "k", label: "Kelly %", value: pct(g.kelly, 1).replace("-", "−"), cls: small(g) ? "dim" : "",
      title: smallTitle(g) ?? "Share of capital the win rate and payoff would justify: W − (1 − W) ÷ (avg win ÷ |avg loss|)",
    },
    { key: "kr", label: "K-ratio", value: num(g.kRatio), title: "How straight the cumulative P&L climbs: slope ÷ its standard error (Kestner 2003, daily)" },
    {
      key: "pf", label: "Profit factor", value: g.profitFactor === null ? "—" : num(g.profitFactor), cls: small(g) ? "dim" : "", ...plain(g.profitFactor),
      title: smallTitle(g) ?? "Gross wins ÷ gross losses",
    },

    { key: "fees", label: "Fees & commissions", value: money(g.fees, { sign: false }), title: "Brokers report one combined figure" },
    { key: "wr", label: "Win %", value: pct(g.winRate, 1), title: "wins ÷ (wins + losses), breakevens left out: the same win % as everywhere else", num: { v: g.winRate, diff: signedPts } },
    { key: "ex", label: "Expectancy", value: f.v(g.expectancy), cls: pnlClass(g.expectancy), title: `Per decisive ${u}: W × avg win + (1 − W) × avg loss`, ...val(g.expectancy) },
  ];
  return cells;
}

/** B − A for one row, or "" when either side has no number. */
function diffText(a: Cell, b: Cell): { text: string; cls: string } {
  if (!a.num || !b.num || a.num.v === null || b.num.v === null || !Number.isFinite(a.num.v) || !Number.isFinite(b.num.v)) return { text: "", cls: "" };
  const d = b.num.v - a.num.v;
  return { text: a.num.diff(d), cls: Math.abs(d) < 1e-9 ? "flat" : "" };
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

/** The grid as rows with one column per side (Compare, Win vs Loss Days); `diff` adds a B − A column. */
export function GridColumns({ sides, f, diff }: { sides: Array<{ label: React.ReactNode; g: Grid }>; f: Fmt; diff?: boolean }) {
  const cols = sides.map((s) => gridCells(s.g, f));
  return (
    <section className="panel scroll-x">
      <table className="grid dense cols">
        <thead>
          <tr>
            <th>STAT</th>
            {sides.map((s, i) => <th key={i} className="num">{s.label}</th>)}
            {diff && <th className="num" title="Second column minus first">B − A</th>}
          </tr>
        </thead>
        <tbody>
          {cols[0]!.map((c, r) => (
            <tr key={c.key}>
              <td className="muted" title={c.title}>{c.label}</td>
              {cols.map((col, i) => <td key={i} className={`num b ${col[r]!.cls ?? ""}`}>{col[r]!.value}</td>)}
              {diff && (() => { const d = diffText(cols[0]![r]!, cols[1]![r]!); return <td className={`num muted ${d.cls}`}>{d.text}</td>; })()}

            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
