// P&L calendar (SPEC §6.2): month grid with a P&L tint and a weekly total
// column, month arrows, and a 12-month year heatmap. Clicking a day opens Trades
// filtered to that day (keeping the other filters).
import { useMemo } from "react";
import { addDays, dayOfWeek } from "../../core/calendar";
import { monthGrid, tint, yearView, type DayTotal } from "../../core/journal/calendar-view";
import { nextMonth, prevMonth, type ViewState } from "../../core/journal/filter";
import { filterTrades, reviewDates, type Journal } from "../../core/journal/journal";
import { FilterBar, viewHref } from "../components/FilterBar";
import { compactMoney, DOW, money, MONTH_NAMES, monthLabel, pnlClass } from "../format";

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function bg(pnl: number, maxAbs: number): React.CSSProperties | undefined {
  const a = tint(pnl, maxAbs);
  if (!a) return undefined;
  return { background: `color-mix(in srgb, var(${pnl > 0 ? "--gain" : "--loss"}) ${Math.round(8 + a * 40)}%, var(--panel))` };
}

export function CalendarPage({ journal: j, view, params }: { journal: Journal; view: ViewState; params: URLSearchParams }) {
  const thisMonth = j.today.slice(0, 7);
  const month = MONTH_RE.test(params.get("month") ?? "") ? params.get("month")! : thisMonth;
  const mode = params.get("view") === "year" ? "year" : "month";
  // The calendar shows every date, so the filter's own date range doesn't apply here.
  const trades = useMemo(() => filterTrades(j, { ...view.filter, preset: null, from: null, to: null }), [j, view.filter]);
  const startsOn = j.startsOn;
  const reviews = useMemo(() => reviewDates(j), [j]);
  const unit = view.count === "idea" ? "ideas" : "trades";
  const n = (d: DayTotal) => (view.count === "idea" ? d.ideas : d.trades);
  const self = (extra: Record<string, string>) => viewHref("#/cal", view, extra);
  const dayHref = (date: string) => viewHref("#/trades", { ...view, filter: { ...view.filter, preset: null, from: date, to: date } });
  const rangeHref = (from: string, to: string) => viewHref("#/trades", { ...view, filter: { ...view.filter, preset: null, from, to } });

  const head = (
    <header className="page-head">
      <h1>CALENDAR <span className="sub">/ {mode === "year" ? month.slice(0, 4) : monthLabel(month)} · {view.pnl.toUpperCase()}</span></h1>
      <div className="row">
        <div className="seg" role="group" aria-label="Calendar view">
          <a className="segl" aria-current={mode === "month" ? "true" : undefined} href={self({ month })}>MONTH</a>
          <a className="segl" aria-current={mode === "year" ? "true" : undefined} href={self({ month, view: "year" })}>YEAR</a>
        </div>
        {mode === "month" ? (
          <>
            <a className="btn" href={self({ month: prevMonth(month) })} aria-label="Previous month">‹</a>
            <a className="btn" href={self({ month: thisMonth })}>TODAY</a>
            <a className="btn" href={self({ month: nextMonth(month) })} aria-label="Next month">›</a>
          </>
        ) : (
          <>
            <a className="btn" href={self({ month: `${Number(month.slice(0, 4)) - 1}${month.slice(4)}`, view: "year" })} aria-label="Previous year">‹</a>
            <a className="btn" href={self({ month: thisMonth, view: "year" })}>TODAY</a>
            <a className="btn" href={self({ month: `${Number(month.slice(0, 4)) + 1}${month.slice(4)}`, view: "year" })} aria-label="Next year">›</a>
          </>
        )}
      </div>
    </header>
  );
  const filters = <FilterBar view={view} journal={j} base="#/cal" dates={false} extra={{ month, ...(mode === "year" ? { view: "year" } : {}) }} />;

  if (mode === "year") {
    const months = yearView(trades, Number(month.slice(0, 4)), { pnl: view.pnl, startsOn });
    const maxAbs = Math.max(0, ...months.flatMap((m) => m.days.map((d) => Math.abs(d.pnl))));
    const total = months.reduce((s, m) => s + m.pnl, 0);
    return (
      <main className="page">
        {head}
        {filters}
        <section className="panel" aria-label="Year">
          <div className="panel-head">
            <h2>{month.slice(0, 4)} · <span className={pnlClass(total)}>{money(Math.round(total * 100) / 100)}</span></h2>
            <span className="muted small">{months.reduce((s, m) => s + m.green, 0)} GREEN DAYS · {months.reduce((s, m) => s + m.red, 0)} RED DAYS</span>
            <span className="grow" />
            <span className="dim small year-legend">
              <span className="key key-gain" /> green day · <span className="key key-loss" /> red day · darker = bigger · <span className="key key-none" /> no trades
            </span>
          </div>
          <div className="year">
            {months.map((m) => (
              <div key={m.month} className="ymonth">
                <a className="ylabel" href={self({ month: m.month })}>
                  <b>{MONTH_NAMES[Number(m.month.slice(5)) - 1]!.toUpperCase()}</b>
                  <span className={pnlClass(m.pnl)}>{m.trades ? money(m.pnl) : ""}</span>
                </a>
                {/* Weekday letters, in the configured week order (#22). */}
                <div className="ygrid ydow" aria-hidden="true">
                  {(startsOn === "sunday" ? "SMTWTFS" : "MTWTFSS").split("").map((l, i) => <span key={i}>{l}</span>)}
                </div>
                <div className="ygrid" role="grid" aria-label={monthLabel(m.month)}>
                  {Array.from({ length: m.lead }, (_, i) => <span key={`l${i}`} />)}
                  {m.days.map((d) => (
                    <a key={d.date} className="ycell" href={d.trades ? dayHref(d.date) : undefined} style={bg(d.pnl, maxAbs)}
                      title={`${d.date}: ${d.trades ? `${money(d.pnl)} · ${n(d)} ${unit}` : "no trades"}`} aria-label={`${d.date} ${d.trades ? money(d.pnl) : "no trades"}`} />
                  ))}
                </div>
                <div className="muted small">{m.trades ? `${n(m)} ${(n(m) === 1 ? unit.slice(0, -1) : unit).toUpperCase()} · ${m.green} GREEN / ${m.red} RED` : "—"}</div>

              </div>
            ))}
          </div>
        </section>
      </main>
    );
  }

  const { weeks, total } = monthGrid(trades, month, { pnl: view.pnl, startsOn, reviewDates: reviews });
  const maxAbs = Math.max(0, ...weeks.flatMap((w) => w.days.filter((d) => d.inMonth).map((d) => Math.abs(d.pnl))));
  const weekMax = Math.max(0, ...weeks.map((w) => Math.abs(w.pnl)));
  const dows = Array.from({ length: 7 }, (_, i) => DOW[dayOfWeek(addDays(weeks[0]!.start, i))]!);
  return (
    <main className="page">
      {head}
      {filters}
      <section className="panel" aria-label={monthLabel(month)}>
        <div className="panel-head">
          <h2>{monthLabel(month)} · <span className={pnlClass(total.pnl)}>{money(total.pnl)}</span></h2>
          <span className="muted small">{n(total)} {unit.toUpperCase()}</span>
        </div>
        <div className={`cal starts-${startsOn}`} role="grid">

          <div className="cal-row head" role="row">
            {dows.map((d) => <div key={d} role="columnheader">{d}</div>)}
            <div role="columnheader">WEEK</div>
          </div>
          {weeks.map((w) => {
            // A week that reaches into the next or previous month: its total includes those days, so it is dimmed and says so (#16).
            const other = w.days.filter((d) => !d.inMonth && d.trades > 0).map((d) => MONTH_NAMES[Number(d.date.slice(5, 7)) - 1]!.toUpperCase());
            const incl = [...new Set(other)].join("/");
            return (
              <div key={w.start} className="cal-row" role="row">
                {w.days.map((d) => {
                  const body = (
                    <>
                      <span className="cal-date">{Number(d.date.slice(8))}{d.review && <span className="rv" title="Review written this day"> 📄</span>}</span>
                      {d.trades > 0 && (
                        <>
                          <span className={`cal-pnl ${pnlClass(d.pnl)}`}>
                            <span className="full">{money(d.pnl)}</span>
                            <span className="compact">{compactMoney(d.pnl)}</span>
                          </span>
                          <span className="cal-n muted">{n(d)}<span className="full"> {unit.slice(0, -1).toUpperCase()}{n(d) === 1 ? "" : "S"}</span></span>
                        </>
                      )}
                    </>
                );
                const cls = `cal-cell ${d.inMonth ? "" : "out"} ${d.date === j.today ? "today" : ""}`;
                return d.trades ? (
                  <a key={d.date} role="gridcell" className={cls} href={dayHref(d.date)} style={d.inMonth ? bg(d.pnl, maxAbs) : undefined}
                    aria-label={`${d.date}: ${money(d.pnl)}, ${n(d)} ${unit}`}>{body}</a>
                ) : (
                  <div key={d.date} role="gridcell" className={cls}>{body}</div>
                );
              })}
              <a role="gridcell" className={`cal-cell week ${incl ? "spans" : ""}`} href={w.trades ? rangeHref(w.start, addDays(w.start, 6)) : undefined} style={incl ? undefined : bg(w.pnl, weekMax)}
                aria-label={`Week of ${w.start}: ${money(w.pnl)}${incl ? `, including ${incl} days` : ""}`} title={incl ? `Includes ${incl} days` : undefined}>
                <span className="cal-date muted">WK{incl && <span className="full"> · INCL. {incl}</span>}</span>
                {w.trades > 0 && (
                  <>
                    <span className={`cal-pnl ${pnlClass(w.pnl)}`}><span className="full">{money(w.pnl)}</span><span className="compact">{compactMoney(w.pnl)}</span></span>
                    <span className="cal-n muted">{n(w)}<span className="full"> {unit.slice(0, -1).toUpperCase()}{n(w) === 1 ? "" : "S"}</span></span>
                  </>
                )}
              </a>
            </div>
            );
          })}

        </div>
      </section>
      <div className="dim small">Closed-trade P&amp;L by close date (ET). Darker = bigger day. 📄 = review.</div>
    </main>
  );
}
