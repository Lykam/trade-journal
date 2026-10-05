// Reports (SPEC §6.5): every tab reads the global filter, Gross / Net, Count by
// Trade / Idea and $ / % return from the URL. The numbers come from
// src/core/reports; this file only lays them out.
import { useMemo } from "react";
import { dateRange, type TradeFilter, type ViewState } from "../../core/journal/filter";
import { filterTrades, type Journal } from "../../core/journal/journal";
import {
  applyPreset, buildUnits, byBroker, compareLabels,
 byCost, byDayOfWeek, byEntryPrice, byHour, byInstrument, byMonth, byShares, bySymbol, byStyle,
  byUnderlying, COMPARE_PRESETS, computeGrid, distribution, drawdownReport, parseReport, reportExtra, sameUnderlying, SUB_LABELS, SUBS,
  TAB_LABELS, TABS, tagGroups, topBottom, winLossDays, type Grid, type ReportState, type Unit, type ValueOpts,
} from "../../core/reports";
import { BucketBars, BucketTable, Underwater, VBars } from "../components/ReportCharts";
import { GridColumns, holdText, StatsGrid, type Fmt } from "../components/StatsGrid";

import { FilterBar, viewHref } from "../components/FilterBar";
import { CumulativeChart, Widget, WinByDay } from "../components/Widgets";
import { money, pct, pnlClass, qty, signedPct } from "../format";

const MINUS = "−";
const signedPts = (n: number) => `${n > 0 ? "+" : n < 0 ? MINUS : ""}${(Math.abs(n) * 100).toFixed(2)} pts`;

interface Ctx {
  j: Journal;
  view: ViewState;
  r: ReportState;
  o: ValueOpts;
  f: Fmt;
  units: Unit[];
  trades: ReturnType<typeof filterTrades>;
  href: (patch: Partial<ReportState>, v?: ViewState) => string;
}

function Tabs<T extends string>({ items, labels, on, href, label }: { items: readonly T[]; labels: Record<T, string>; on: T; href: (t: T) => string; label: string }) {
  return (
    <nav className="seg wrap tabs" aria-label={label}>
      {items.map((t) => (
        <a key={t} className="segl" href={href(t)} aria-current={on === t ? "true" : undefined}>{labels[t]}</a>
      ))}
    </nav>
  );
}

function Totals({ items }: { items: Array<{ label: string; value: React.ReactNode; sub?: React.ReactNode; cls?: string; title?: string }> }) {
  return (
    <section className="panel statrow">
      {items.map((i) => (
        <div key={i.label} title={i.title}>
          <div className="label small">{i.label}</div>
          <div className={`v ${i.cls ?? ""}`}>{i.value}</div>
          {i.sub !== undefined && <div className="muted small">{i.sub}</div>}
        </div>
      ))}
    </section>
  );
}

function headline(g: Grid, c: Ctx) {
  return [
    {
      label: `${c.view.pnl.toUpperCase()} ${c.f.pct ? `SUM OF ${c.f.unit} %` : "P&L"}`, value: c.f.v(g.total), cls: pnlClass(g.total), sub: `${g.days} DAYS TRADED`,
      title: c.f.pct ? "A sum of per-trade % returns, not a return on the account" : undefined,
    },
    { label: `WIN % (${c.f.unit}S)`, value: pct(g.winRate, 1), sub: `${g.wins}W ${g.losses}L${g.breakevens ? ` ${g.breakevens}BE` : ""}${c.view.pnl === "gross" ? " · ON NET" : ""}` },
    { label: `${c.f.unit}S`, value: String(g.count), sub: c.f.unit === "IDEA" ? `${c.units.reduce((s, u) => s + u.trades.length, 0)} TRADES` : `${new Set(c.units.map((u) => u.trades[0]!.ideaId)).size} IDEAS` },
    { label: "PROFIT FACTOR", value: g.profitFactor?.toFixed(2) ?? (g.wins ? "∞" : "—") },
    { label: "EXPECTANCY", value: c.f.v(g.expectancy), cls: pnlClass(g.expectancy), sub: `PER ${c.f.unit}` },
  ];
}

// ---------------------------------------------------------------- tabs

function Overview({ c, g }: { c: Ctx; g: Grid }) {
  const d = g.daily;
  const fmt = (n: number) => c.f.v(n);
  return (
    <>
      <Totals items={headline(g, c)} />
      <div className="widgets">
        <Widget title={<>Cumulative {c.f.pct ? `sum of ${c.f.unit.toLowerCase()} %` : "P&L"} · <span className={pnlClass(g.total)}>{c.f.v(g.total)}</span></>}>
          <CumulativeChart pts={d} fmt={fmt} label="Cumulative P&L" />
        </Widget>
        <Widget title={<>Daily {c.r.mode === "pct" ? "return" : "P&L"} · avg {c.f.v(g.avgDaily)}</>}>
          <VBars label="Daily P&L" bars={d.map((x) => ({ key: x.date, value: x.value, cls: x.value > 0 ? "gain" : x.value < 0 ? "loss" : "flat", title: `${x.date}: ${fmt(x.value)} · ${x.units} ${c.f.unit.toLowerCase()}s` }))}
            height={200} axis={d.length ? [d[0]!.date, d[d.length - 1]!.date] : undefined} />
        </Widget>
        <Widget title={<>Daily win % · avg {pct(g.winRate)} <span className="accent">┄</span></>}>
          <WinByDay days={d} avg={g.winRate} fmt={fmt} />
        </Widget>
        <Widget title={<>Volume / day (shares) · avg {g.avgDailyVolume === null ? "—" : qty(Math.round(g.avgDailyVolume))}</>}>
          <VBars label="Shares traded per day" bars={d.map((x) => ({ key: x.date, value: x.volume, cls: "border-strong", title: `${x.date}: ${qty(x.volume)} shares` }))}
            height={200} axis={d.length ? [d[0]!.date, d[d.length - 1]!.date] : undefined} />
        </Widget>
      </div>
    </>
  );
}

function Breakdowns({ c }: { c: Ctx }) {
  const { units, o, r, f } = c;
  const fmt = f.v;
  const unit = f.unit.toLowerCase();
  const W = (title: React.ReactNode, body: React.ReactNode, wide?: boolean) => <Widget title={title} wide={wide}>{body}</Widget>;
  let body: React.ReactNode;
  if (r.sub === "times") {
    const h = byHour(units, o);
    body = (
      <>
        {W("By day of week (close date)", <BucketBars buckets={byDayOfWeek(units, o)} fmt={fmt} unit={unit} />)}
        {W(<>By hour of entry (ET) {h.untimed > 0 && <span className="dim">· {h.untimed} Schwab {unit}{h.untimed === 1 ? "" : "s"} without times left out</span>}</>,
          <BucketBars buckets={h.buckets} fmt={fmt} unit={unit} empty="No timed (Webull) trades in range" />)}
        {W("By month (close date)", <BucketBars buckets={byMonth(units, o)} fmt={fmt} unit={unit} />)}
      </>
    );
  } else if (r.sub === "price") {
    body = (
      <>
        {W("By entry price", <BucketBars buckets={byEntryPrice(units, o)} fmt={fmt} unit={unit} />)}
        {W("By position size (shares bought)", <BucketBars buckets={byShares(units, o)} fmt={fmt} unit={unit} />)}
        {W("By position size ($ bought)", <BucketBars buckets={byCost(units, o)} fmt={fmt} unit={unit} />)}
      </>
    );
  } else if (r.sub === "instrument") {
    const sym = topBottom(bySymbol(units, o));
    const und = topBottom(byUnderlying(units, o));
    const same = sameUnderlying(units, o);
    body = (
      <>
        {W("By symbol · top 20", <BucketBars buckets={sym.top} fmt={fmt} unit={unit} />)}
        {W("By symbol · bottom 20", <BucketBars buckets={sym.bottom} fmt={fmt} unit={unit} empty="—" />)}
        {W("By underlying · top 20", <BucketBars buckets={und.top} fmt={fmt} unit={unit} />)}
        {W("By underlying · bottom 20", <BucketBars buckets={und.bottom} fmt={fmt} unit={unit} empty="—" />)}
        {W("Stock vs leveraged ETF", <BucketTable buckets={byInstrument(units, o)} fmt={fmt} unit={f.unit} />)}
        {W("Same underlying · stock vs ETF", same.length === 0 ? <div className="empty">No underlying traded both ways in range</div> : (
          <div className="scroll-x">
            <table className="grid dense">
              <thead>
                <tr><th>UNDERLYING</th><th></th><th className="num">{f.unit}S</th><th className="num">WIN %</th><th className="num">P&amp;L</th><th className="num">EXPECTANCY</th></tr>
              </thead>
              <tbody>
                {same.flatMap((s) => [s.stock, s.etf, ...(s.mixed ? [s.mixed] : [])].map((b, i) => (
                  <tr key={`${s.underlying}-${b.key}`} className={i ? "sub" : ""}>
                    <td>{i === 0 ? <b>{s.underlying}</b> : ""}</td>
                    <td className="muted">{b.label}</td>
                    <td className="num">{b.count}</td>
                    <td className="num">{pct(b.winRate, 1)}</td>
                    <td className={`num b ${pnlClass(b.total)}`}>{b.count ? fmt(b.total) : "—"}</td>
                    <td className="num">{fmt(b.expectancy)}</td>
                  </tr>
                )))}
              </tbody>
            </table>
          </div>
        ), true)}
      </>
    );
  } else {
    const dist = distribution(units, o);
    const binLabel = (x: number) => (c.r.mode === "pct" ? signedPct(x, 1) : money(x));
    body = (
      <>
        {W(<>Distribution of {unit} {c.r.mode === "pct" ? "returns" : "P&L"}</>, (
          <VBars label={`Distribution of ${unit} P&L`} height={180}
            bars={dist.bins.map((b) => ({
              key: String(b.from), value: b.count, cls: b.from >= 0 ? "gain" : "loss",
              title: `${binLabel(b.from)} to ${binLabel(b.to)}: ${b.count} ${unit}${b.count === 1 ? "" : "s"} (${b.wins}W ${b.losses}L)`,
            }))}
            axis={dist.bins.length ? [binLabel(dist.bins[0]!.from), binLabel(dist.bins[dist.bins.length - 1]!.to),
              ...(dist.bins[0]!.from < 0 && dist.bins[dist.bins.length - 1]!.to > 0 ? [{ text: binLabel(0), frac: -dist.bins[0]!.from / (dist.bins[dist.bins.length - 1]!.to - dist.bins[0]!.from) }] : [])] as [string, string, { text: string; frac: number }?] : undefined} />
        ), true)}
        {W("By style", <BucketTable buckets={byStyle(units, o)} fmt={fmt} unit={f.unit} />)}
        {W("By broker", <BucketTable buckets={byBroker(units, o)} fmt={fmt} unit={f.unit} />)}
      </>
    );
  }
  return (
    <>
      <Tabs items={SUBS} labels={SUB_LABELS} on={r.sub} href={(s) => c.href({ sub: s })} label="Breakdowns" />
      <div className="widgets">{body}</div>
    </>
  );
}

function Detailed({ c, g }: { c: Ctx; g: Grid }) {
  return (
    <>
      <StatsGrid g={g} f={c.f} />
      <Breakdowns c={c} />
    </>
  );
}

function WinLossDays({ c }: { c: Ctx }) {
  const w = useMemo(() => winLossDays(c.units, c.o), [c.units, c.o]);
  const u = c.f.unit.toLowerCase();
  const rows: Array<[string, (s: typeof w.green) => string, string?]> = [
    ["Days", (s) => String(s.days)],
    [`${c.f.unit === "IDEA" ? "Ideas" : "Trades"} per day`, (s) => s.perDay.units?.toFixed(1) ?? "—"],
    ["Volume per day (shares)", (s) => (s.perDay.volume === null ? "—" : qty(Math.round(s.perDay.volume)))],
    [`Avg shares bought per ${u}`, (s) => s.perDay.shares?.toFixed(1) ?? "—"],
    [`Avg $ bought per ${u}`, (s) => money(s.perDay.cost, { sign: false })],
    ["Avg hold", (s) => holdText(s.grid.hold, "all")],
  ];
  return (
    <>
      <Totals items={[
        { label: "GREEN DAYS", value: String(w.green.days), cls: "gain", sub: c.f.v(w.green.grid.total) },
        { label: "RED DAYS", value: String(w.red.days), cls: "loss", sub: c.f.v(w.red.grid.total) },
        { label: "FLAT DAYS", value: String(w.flatDays) },
        { label: "GREEN-DAY %", value: pct(w.green.days + w.red.days ? w.green.days / (w.green.days + w.red.days) : null, 1), title: "Green days ÷ (green + red days); flat days left out" },
      ]} />
      <section className="panel scroll-x">
        <h2 className="panel-pad" title="A day's color is its net P&L">Green vs red days</h2>
        <table className="grid dense">
          <thead><tr><th></th><th className="num gain">GREEN DAYS</th><th className="num loss">RED DAYS</th></tr></thead>
          <tbody>
            {rows.map(([label, fn]) => (
              <tr key={label}><td className="muted">{label}</td><td className="num b">{fn(w.green)}</td><td className="num b">{fn(w.red)}</td></tr>
            ))}
          </tbody>
        </table>
      </section>
      <GridColumns f={c.f} sides={[{ label: <span className="gain">GREEN DAYS</span>, g: w.green.grid }, { label: <span className="loss">RED DAYS</span>, g: w.red.grid }]} />
    </>
  );
}

function DrawdownTab({ c }: { c: Ctx }) {
  const usd = useMemo(() => drawdownReport(c.units, { ...c.o, mode: "usd" }), [c.units, c.o]);
  const ret = useMemo(() => drawdownReport(c.units, { ...c.o, mode: "pct" }), [c.units, c.o]);
  const d = c.r.mode === "pct" ? ret : usd;
  const fmt = c.r.mode === "pct" ? signedPts : (n: number) => money(n);
  const m = usd.max;
  return (
    <>
      <Totals items={[
        {
          label: "MAX DRAWDOWN", value: m ? money(-m.depth) : "—", cls: m ? "loss" : "",
          // A share of peak profit, not of the account; left out in % mode, where it would read as an account figure (#16).
          sub: c.f.pct ? "" : usd.maxPctOfPeak !== null ? `${pct(usd.maxPctOfPeak, 1)} OF PEAK PROFIT` : m ? "PEAK ≤ 0" : "NONE",
          title: "Deepest fall of cumulative P&L below a running peak",
        },
        { label: "MAX DRAWDOWN %", value: ret.max ? signedPts(-ret.max.depth).toUpperCase() : "—", cls: ret.max ? "loss" : "", sub: `SUM OF ${c.f.unit} %`, title: "The same on the curve of summed % returns (points), not a share of the account" },
        { label: "WORST DRAWDOWN", value: m ? `${(m.peakDate || c.units[0]!.date).slice(5)}→${m.troughDate.slice(5)}` : "—", sub: m ? (m.recoveredDate ? `RECOVERED ${m.recoveredDate.slice(5)}` : "NOT RECOVERED") : "", title: m ? `${usd.declineDays} day${usd.declineDays === 1 ? "" : "s"} from peak to low` : undefined },
        { label: "RECOVERY", value: usd.recoveryDays === null ? "—" : `${usd.recoveryDays}d`, sub: "LOW TO NEW HIGH" },
        { label: "LONGEST DRAWDOWN", value: usd.longest ? `${usd.longest.days}d` : "—", sub: usd.longest ? `${(usd.longest.peakDate || c.units[0]!.date).slice(5)}→${usd.longest.recoveredDate?.slice(5) ?? "NOW"}` : "" },
        { label: "NOW", value: d.current ? fmt(d.current).toUpperCase() : "AT PEAK", cls: d.current ? "loss" : "gain", sub: "BELOW PEAK" },
      ]} />
      <div className="widgets">
        <Widget title={<>Cumulative {c.f.pct ? `sum of ${c.f.unit.toLowerCase()} %` : "P&L"}</>} wide>
          <CumulativeChart pts={d.days.map((x, i) => ({ date: x.date, cum: x.equity, value: x.equity - (d.days[i - 1]?.equity ?? 0) }))} fmt={fmt} label="Cumulative P&L" height={180} />
        </Widget>
        <Widget title={<>Below peak (worst point each day)</>} wide>
          <Underwater days={d.days} fmt={fmt} height={160} />
        </Widget>
      </div>
      <div className="dim small">Measured {c.f.unit.toLowerCase()} by {c.f.unit.toLowerCase()} from 0, so intraday dips count.</div>
    </>
  );
}

function Compare({ c }: { c: Ctx }) {
  const bView: ViewState = { ...c.view, filter: c.r.b };
  const bTrades = useMemo(() => filterTrades(c.j, c.r.b), [c.j, c.r.b]);
  const bUnits = useMemo(() => buildUnits(bTrades, c.view.count), [bTrades, c.view.count]);
  const ga = useMemo(() => computeGrid(c.units, c.o), [c.units, c.o]);
  const gb = useMemo(() => computeGrid(bUnits, c.o), [bUnits, c.o]);
  // Each side is named by what differs from the other (#18), and the date range is always named.
  const names = compareLabels(c.view.filter, c.r.b, c.j.today, c.j.startsOn);
  const presetHref = (p: (typeof COMPARE_PRESETS)[number]) => {
    const { a, b } = applyPreset(c.view, p);
    return c.href({ b }, { ...c.view, filter: a });
  };
  const fmt = (n: number) => c.f.v(n);
  return (
    <>
      <div className="row">
        <span className="label small" title="Each preset replaces the style, instrument, broker and dates of both sides; other filters stay">PRESETS</span>
        {COMPARE_PRESETS.map((p) => <a key={p.key} className="btn" href={presetHref(p)}>{p.label}</a>)}
      </div>
      <FilterBar view={bView} journal={c.j} base="#/reports" title="B FILTERS" pnl={false} count={false} defaultOpen={false}
        hrefFor={(v) => c.href({ b: v.filter })} />
      {names.same ? (
        <div className="panel empty">A and B are the same filter. Pick a preset above, or change B's filters, to compare.</div>
      ) : (
        <>
          <div className="two-col">
            <Widget title={<><span className="accent">A</span> · {names.a.join(" · ")} · <span className={pnlClass(ga.total)}>{c.f.v(ga.total)}</span></>}>
              <CumulativeChart pts={ga.daily} fmt={fmt} label="Set A cumulative P&L" height={160} />
            </Widget>
            <Widget title={<><span className="accent">B</span> · {names.b.join(" · ")} · <span className={pnlClass(gb.total)}>{c.f.v(gb.total)}</span></>}>
              <CumulativeChart pts={gb.daily} fmt={fmt} label="Set B cumulative P&L" height={160} />
            </Widget>
          </div>
          <GridColumns f={c.f} diff sides={[{ label: <>A · {names.a[0]}</>, g: ga }, { label: <>B · {names.b[0]}</>, g: gb }]} />
        </>
      )}
    </>
  );
}

function TagBreakdown({ c }: { c: Ctx }) {
  const groups = useMemo(() => tagGroups(c.trades, (t) => c.j.tags.get(t.id), c.view.count, c.o), [c.trades, c.j, c.view.count, c.o]);
  const keyOf = (g: (typeof groups)[number]) => `${g.kind}:${g.tag}`;
  const sel = groups.find((g) => keyOf(g) === c.r.tag) ?? null;
  const KINDS: Array<[(typeof groups)[number]["kind"], string, string]> = [
    ["manual", "Manual tags", "No manual tags on these trades"],
    ["category", "Review category", "No reviewed trades with a Category here"],
    ["style", "Style", ""],
  ];
  return (
    <>
      <div className="widgets">
        {KINDS.map(([kind, title, empty]) => {
          const gs = groups.filter((g) => g.kind === kind);
          return (
            <Widget key={kind} title={title} wide={kind === "manual"}>
              {gs.length === 0 ? <div className="empty">{empty}</div> : (
                <div className="scroll-x">
                  <table className="grid dense">
                    <thead>
                      <tr><th>TAG</th><th className="num">{c.f.unit}S</th><th className="num">WIN %</th><th className="num">P&amp;L</th><th className="num">EXPECTANCY</th><th className="num">PF</th><th className="num">SQN</th></tr>
                    </thead>
                    <tbody>
                      {gs.map((g) => (
                        <tr key={g.tag} className={sel === g ? "selected" : ""}>
                          <td><a href={c.href({ tag: sel === g ? null : keyOf(g) })} aria-current={sel === g ? "true" : undefined}>{g.tag}</a></td>
                          <td className="num">{g.grid.count}</td>
                          <td className="num">{pct(g.grid.winRate, 1)}</td>
                          <td className={`num b ${pnlClass(g.grid.total)}`}>{c.f.v(g.grid.total)}</td>
                          <td className="num">{c.f.v(g.grid.expectancy)}</td>
                          <td className="num">{g.grid.profitFactor?.toFixed(2) ?? (g.grid.wins ? "∞" : "—")}</td>
                          <td className="num">{g.grid.sqn?.toFixed(2).replace("-", MINUS) ?? "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Widget>
          );
        })}
      </div>
      {sel ? (
        <>
          <h2 className="label">Stats · {sel.tag} <a className="small" href={c.href({ tag: null })}>✕ CLOSE</a></h2>
          <StatsGrid g={sel.grid} f={c.f} />
        </>
      ) : (
        <div className="dim small">Click a tag for full stats. Multi-tag trades count in each.</div>

      )}
    </>
  );
}

// ---------------------------------------------------------------- page

export function ReportsPage({ journal: j, view, params }: { journal: Journal; view: ViewState; params: URLSearchParams }) {
  const r = useMemo(() => parseReport(params), [params]);
  const o: ValueOpts = useMemo(() => ({ pnl: view.pnl, mode: r.mode }), [view.pnl, r.mode]);
  const trades = useMemo(() => filterTrades(j, view.filter), [j, view.filter]);
  const units = useMemo(() => buildUnits(trades, view.count), [trades, view.count]);
  const grid = useMemo(() => computeGrid(units, o), [units, o]);
  const href = (patch: Partial<ReportState>, v: ViewState = view) => viewHref("#/reports", v, reportExtra({ ...r, ...patch }));
  const unit = view.count === "idea" ? "IDEA" : "TRADE";
  const f: Fmt = { v: r.mode === "pct" ? (n) => signedPct(n ?? null, 2) : (n) => money(n), unit, view, pct: r.mode === "pct" };
  const c: Ctx = { j, view, r, o, f, units, trades, href };
  const range = dateRange(view.filter, j.today, j.startsOn);

  const modeSeg = (
    <div className="fgroup">
      <span className="flabel">SHOW</span>
      <div className="seg" role="group" aria-label="Values">
        <a className="segl" href={href({ mode: "usd" })} aria-current={r.mode === "usd" ? "true" : undefined} title="Dollar values">$</a>
        <a className="segl" href={href({ mode: "pct" })} aria-current={r.mode === "pct" ? "true" : undefined} title="% return on the cost of the shares bought">%</a>
      </div>
    </div>
  );

  let body: React.ReactNode;
  if (units.length === 0 && r.tab !== "compare") body = <div className="panel empty">No closed trades match these filters.</div>;
  else if (r.tab === "overview") body = <Overview c={c} g={grid} />;
  else if (r.tab === "detailed") body = <Detailed c={c} g={grid} />;
  else if (r.tab === "days") body = <WinLossDays c={c} />;
  else if (r.tab === "drawdown") body = <DrawdownTab c={c} />;
  else if (r.tab === "compare") body = <Compare c={c} />;
  else body = <TagBreakdown c={c} />;

  return (
    <main className="page">
      <header className="page-head">
        <h1>
          REPORTS <span className="sub">/ {units.length} {unit}S · {range.from || range.to ? `${range.from ?? "…"} – ${range.to ?? "…"}` : "ALL DATES"}
          {r.mode === "pct" ? " · % RETURN ON COST" : ""}</span>
        </h1>
      </header>
      <FilterBar view={view} journal={j} base="#/reports" extra={reportExtra(r)} controls={modeSeg} title={r.tab === "compare" ? "A FILTERS" : "FILTERS"} />
      <Tabs items={TABS} labels={TAB_LABELS} on={r.tab} href={(t) => href({ tab: t })} label="Report" />
      {body}
      <div className="dim small">
        Closed trades only. Win/loss always uses net P&amp;L.{" "}
        {r.mode === "pct" ? "% return = P&L ÷ cost of the shares bought; totals are sums of those returns, not account returns. " : ""}
        {view.count === "idea" ? "Each idea counts once, scored on its trades that pass the filter." : ""}
      </div>
    </main>
  );
}
