// P&L calendar (SPEC §6.2): month grid with a P&L tint and a weekly total
// column, month arrows, and a 12-month year heatmap. Clicking a day opens Trades
// filtered to that day (keeping the other filters).
import { useMemo } from "react";
import { addDays, dayOfWeek } from "../../core/calendar";
import { monthGrid, tint, yearView, type DayTotal } from "../../core/journal/calendar-view";
import { nextMonth, prevMonth, type ViewState } from "../../core/journal/filter";
import { filterTrades, reviewDates, type Journal } from "../../core/journal/journal";
import { dayStatus } from "../../core/cadence/entries";
import { dayMark, monthMark, streak, tradingDays, weekMark, weekOfRow, type DayMark, type PeriodMark } from "../../core/cadence/status";
import type { DataBundle } from "../../core/types";
import { useEntries } from "../cadence";
import { FilterBar, viewHref } from "../components/FilterBar";
import { compactMoney, DOW, money, MONTH_NAMES, monthLabel, pnlClass } from "../format";

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Saturday or Sunday. Weekend columns only show when a weekend day in view has trades (Q69). */
const isWeekend = (date: string) => dayOfWeek(date) % 6 === 0;

type Split = { day: DayTotal; swing: DayTotal };

/** Day and swing P&L side by side under a cell's total (Q76); styles with nothing booked are left out. */
function StyleSplit({ s, n, header = false }: { s: Split; n: (d: DayTotal) => number; header?: boolean }) {
  const parts = (["day", "swing"] as const).filter((k) => s[k].trades > 0);
  if (!parts.length) return null;
  return (
    <span className={header ? "cal-split head" : "cal-split full"}>
      {parts.map((k) => (
        <span key={k}>
          <span className="muted">{header ? k.toUpperCase() : k === "day" ? "D" : "S"}</span>{" "}
          <span className={pnlClass(s[k].pnl)}>{money(s[k].pnl)}</span>
          <span className="dim"> · {n(s[k])}</span>
        </span>
      ))}
    </span>
  );
}

function bg(pnl: number, maxAbs: number): React.CSSProperties | undefined {
  const a = tint(pnl, maxAbs);
  if (!a) return undefined;
  // --tint lets the cell's red/green text lighten as the background darkens, so
  // a big red day's -12.24 doesn't sink into its own red fill.
  return {
    background: `color-mix(in srgb, var(${pnl > 0 ? "--gain" : "--loss"}) ${Math.round(8 + a * 40)}%, var(--panel))`,
    ["--tint" as string]: a.toFixed(2),
  };
}

const DAY_MARK: Record<DayMark, { icon: string; cls: string; title: string }> = {
  done: { icon: "✓", cls: "gain", title: "Report card done" },
  morning: { icon: "◐", cls: "accent", title: "Morning context written; report card to do" },
  missed: { icon: "●", cls: "loss", title: "Traded, no report card" },
  today: { icon: "○", cls: "accent", title: "Today: not done yet" },
  none: { icon: "", cls: "", title: "No trades, nothing written" },
};
const PERIOD_MARK: Record<PeriodMark, { icon: string; cls: string; title: string }> = {
  done: { icon: "✓", cls: "gain", title: "Review written" },
  missed: { icon: "●", cls: "loss", title: "Traded, ended without a review" },
  open: { icon: "○", cls: "accent", title: "Still running" },
  none: { icon: "", cls: "", title: "No trades" },
};

function Mark({ m, label }: { m: { icon: string; cls: string; title: string }; label?: string }) {
  if (!m.icon) return null;
  return <span className={`rv-mark ${m.cls}`} title={m.title} aria-label={`${label ? `${label}: ` : ""}${m.title}`}>{m.icon}</span>;
}

export function CalendarPage({ data, journal: j, view, params }: { data: DataBundle; journal: Journal; view: ViewState; params: URLSearchParams }) {
  const entries = useEntries(data);
  const reviewMode = params.get("mode") === "review";
  const keep: Record<string, string> = reviewMode ? { mode: "review" } : {};
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
  const dayHref = (date: string) => viewHref("#/trades", { ...view, filter: { ...view.filter, preset: null, from: date, to: date, booked: true } });
  const rangeHref = (from: string, to: string) => viewHref("#/trades", { ...view, filter: { ...view.filter, preset: null, from, to, booked: true } });

  const head = (
    <header className="page-head">
      <h1>CALENDAR <span className="sub">/ {mode === "year" ? month.slice(0, 4) : monthLabel(month)} · {view.pnl.toUpperCase()}</span></h1>
      <div className="row">
        {mode === "month" && (
          <div className="seg" role="group" aria-label="Calendar mode">
            <a className="segl" aria-current={!reviewMode ? "true" : undefined} href={self({ month })}>P&amp;L</a>
            <a className="segl" aria-current={reviewMode ? "true" : undefined} href={self({ month, mode: "review" })}>REVIEW</a>
          </div>
        )}
        <div className="seg" role="group" aria-label="Calendar view">
          <a className="segl" aria-current={mode === "month" ? "true" : undefined} href={self({ month })}>MONTH</a>
          <a className="segl" aria-current={mode === "year" ? "true" : undefined} href={self({ month, view: "year" })}>YEAR</a>
        </div>
        {mode === "month" ? (
          <>
            <a className="btn" href={self({ month: prevMonth(month), ...keep })} aria-label="Previous month">‹</a>
            <a className="btn" href={self({ month: thisMonth, ...keep })}>TODAY</a>
            <a className="btn" href={self({ month: nextMonth(month), ...keep })} aria-label="Next month">›</a>
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
  const filters = reviewMode ? null : <FilterBar view={view} journal={j} base="#/cal" dates={false} extra={{ month, ...(mode === "year" ? { view: "year" } : {}) }} />;

  if (mode === "year") {
    const months = yearView(trades, Number(month.slice(0, 4)), { pnl: view.pnl, startsOn });
    const maxAbs = Math.max(0, ...months.flatMap((m) => m.days.map((d) => Math.abs(d.pnl))));
    const total = months.reduce((s, m) => s + m.pnl, 0);
    const fiveDay = !months.some((m) => m.days.some((d) => d.trades > 0 && isWeekend(d.date)));
    // Mon–Fri: blanks before the month's first weekday, so columns line up by weekday.
    const cellsOf = (m: (typeof months)[number]) => {
      if (!fiveDay) return { lead: m.lead, days: m.days };
      const days = m.days.filter((d) => !isWeekend(d.date));
      return { lead: dayOfWeek(days[0]!.date) - 1, days };
    };
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
                <div className={`ygrid ydow ${fiveDay ? "five" : ""}`} aria-hidden="true">
                  {(fiveDay ? "MTWTF" : startsOn === "sunday" ? "SMTWTFS" : "MTWTFSS").split("").map((l, i) => <span key={i}>{l}</span>)}
                </div>
                <div className={`ygrid ${fiveDay ? "five" : ""}`} role="grid" aria-label={monthLabel(m.month)}>
                  {Array.from({ length: cellsOf(m).lead }, (_, i) => <span key={`l${i}`} />)}
                  {cellsOf(m).days.map((d) => (
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

  if (reviewMode) return <ReviewMonth j={j} month={month} entries={entries} head={head} />;

  const { weeks, total } = monthGrid(trades, month, { pnl: view.pnl, startsOn, reviewDates: reviews });
  // The same grid per style, for the day / swing split in each cell (Q76).
  const dayGrid = monthGrid(trades.filter((t) => t.style === "day"), month, { pnl: view.pnl, startsOn });
  const swingGrid = monthGrid(trades.filter((t) => t.style === "swing"), month, { pnl: view.pnl, startsOn });
  const splitByDate = new Map<string, Split>(dayGrid.weeks.flatMap((w, wi) => w.days.map((d, di) => [d.date, { day: d, swing: swingGrid.weeks[wi]!.days[di]! }])));
  const weekSplit = (wi: number): Split => ({ day: dayGrid.weeks[wi]!.month, swing: swingGrid.weeks[wi]!.month });
  // Only worth showing when both styles traded this month.
  const split = dayGrid.total.trades > 0 && swingGrid.total.trades > 0;
  const maxAbs = Math.max(0, ...weeks.flatMap((w) => w.days.filter((d) => d.inMonth).map((d) => Math.abs(d.pnl))));
  const weekMax = Math.max(0, ...weeks.map((w) => Math.abs(w.month.pnl)));
  // Weekends are hidden unless a weekend day in view has trades, so nothing is ever left out (Q69).
  const fiveDay = !weeks.some((w) => w.days.some((d) => d.trades > 0 && isWeekend(d.date)));
  const shown = (date: string) => !fiveDay || !isWeekend(date);
  const dows = Array.from({ length: 7 }, (_, i) => addDays(weeks[0]!.start, i)).filter(shown).map((d) => DOW[dayOfWeek(d)]!);
  return (
    <main className="page">
      {head}
      {filters}
      <section className="panel" aria-label={monthLabel(month)}>
        <div className="panel-head">
          <h2>{monthLabel(month)} · <span className={pnlClass(total.pnl)}>{money(total.pnl)}</span></h2>
          <span className="muted small">{n(total)} {unit.toUpperCase()}</span>
          {split && <StyleSplit s={{ day: dayGrid.total, swing: swingGrid.total }} n={n} header />}
        </div>
        <div className={fiveDay ? "cal weekdays" : `cal starts-${startsOn}`} role="grid">

          <div className="cal-row head" role="row">
            {dows.map((d) => <div key={d} role="columnheader">{d}</div>)}
            <div role="columnheader">WEEK</div>
          </div>
          {weeks.map((w, wi) => {
            // The WEEK column counts this month's days only; a week that also traded in the next or
            // previous month shows its full total underneath (Q75).
            const first = w.days.find((d) => d.inMonth)!.date;
            const last = w.days.filter((d) => d.inMonth).at(-1)!.date;
            const m = w.month;
            return (
              <div key={w.start} className="cal-row" role="row">
                {w.days.filter((d) => shown(d.date)).map((d) => {
                  const body = (
                    <>
                      <span className="cal-date">{Number(d.date.slice(8))}{d.review && <span className="rv" title="Review written this day"> 📄</span>}{d.inMonth && <DailyMark s={dayStatus(entries.daily.get(d.date))} />}</span>
                      {d.trades > 0 && (
                        <>
                          <span className={`cal-pnl ${pnlClass(d.pnl)}`}>
                            <span className="full">{money(d.pnl)}</span>
                            <span className="compact">{compactMoney(d.pnl)}</span>
                          </span>
                          <span className="cal-n muted">{n(d)}<span className="full"> {unit.slice(0, -1).toUpperCase()}{n(d) === 1 ? "" : "S"}</span></span>
                          {split && d.inMonth && <StyleSplit s={splitByDate.get(d.date)!} n={n} />}
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
              <a role="gridcell" className="cal-cell week" href={m.trades ? rangeHref(first, last) : w.trades ? rangeHref(w.start, addDays(w.start, 6)) : undefined} style={bg(m.pnl, weekMax)}
                aria-label={`Week of ${w.start}, this month: ${money(m.pnl)}${w.spills ? `; full week ${money(w.pnl)}, ${n(w)} ${unit}` : ""}`}>
                <span className="cal-date muted">WK</span>
                {m.trades > 0 && (
                  <>
                    <span className={`cal-pnl ${pnlClass(m.pnl)}`}><span className="full">{money(m.pnl)}</span><span className="compact">{compactMoney(m.pnl)}</span></span>
                    <span className="cal-n muted">{n(m)}<span className="full"> {unit.slice(0, -1).toUpperCase()}{n(m) === 1 ? "" : "S"}</span></span>
                  </>
                )}
                {split && m.trades > 0 && <StyleSplit s={weekSplit(wi)} n={n} />}
                {w.spills && (
                  <span className="cal-full dim" title="The whole week, including days in the other month">
                    <span className="full">FULL WK </span>
                    <span className={pnlClass(w.pnl)}><span className="full">{money(w.pnl)}</span><span className="compact">{compactMoney(w.pnl)}</span></span>
                    <span className="full"> · {n(w)}</span>
                  </span>
                )}
              </a>
            </div>
            );
          })}

        </div>
      </section>
      <div className="dim small">P&amp;L lands on the day it's booked (ET). Trims on their day, the rest on the close. Darker = bigger day. 📄 = trade review. ✓ / ◐ = daily journal done / morning only (see REVIEW).</div>
    </main>
  );
}

/** The daily journal's state in a P&L cell: ✓ done, ◐ morning only. */
function DailyMark({ s }: { s: ReturnType<typeof dayStatus> }) {
  return s === "none" ? null : <> <Mark m={DAY_MARK[s]} /></>;
}

/**
 * The REVIEW view (§6.7i, Q89): each trading day, week and the month marked
 * reviewed or missed, with the streak. The whole account, whatever the filters.
 */
function ReviewMonth({ j, month, entries, head }: { j: Journal; month: string; entries: ReturnType<typeof useEntries>; head: React.ReactNode }) {
  const traded = useMemo(() => tradingDays(j.trades), [j]);
  const { weeks } = monthGrid([], month, { pnl: "net", startsOn: j.startsOn });
  const fiveDay = !weeks.some((w) => w.days.some((d) => d.inMonth && isWeekend(d.date) && (traded.has(d.date) || entries.daily.has(d.date))));
  const shown = (date: string) => !fiveDay || !isWeekend(date);
  const dows = Array.from({ length: 7 }, (_, i) => addDays(weeks[0]!.start, i)).filter(shown).map((d) => DOW[dayOfWeek(d)]!);
  const days = weeks.flatMap((w) => w.days).filter((d) => d.inMonth && traded.has(d.date) && d.date <= j.today);
  const done = days.filter((d) => dayStatus(entries.daily.get(d.date)) === "done").length;
  const weekKeys = [...new Set(weeks.map((w) => weekOfRow(w.start)))];
  const weekMarks = new Map(weekKeys.map((m) => [m, weekMark(m, j.today, entries, traded)]));
  const weeksDone = [...weekMarks.values()].filter((m) => m === "done").length;
  const weeksDue = [...weekMarks.values()].filter((m) => m !== "none").length;
  const mm = monthMark(month, j.today, entries, traded);
  const run = streak(j.today, entries, traded);
  return (
    <main className="page">
      {head}
      <section className="panel" aria-label={`${monthLabel(month)} reviews`}>
        <div className="panel-head">
          <h2><a href={`#/month/${month}`}>{monthLabel(month)}</a> <Mark m={PERIOD_MARK[mm]} label="Monthly review" /></h2>
          <span className="muted small">DAYS {done}/{days.length} · WEEKS {weeksDone}/{weeksDue}</span>
          <span className="grow" />
          <span className={`small ${run ? "gain b" : "muted"}`} title="Trading days in a row with the report card done">STREAK {run}</span>
        </div>
        <div className={fiveDay ? "cal weekdays" : `cal starts-${j.startsOn}`} role="grid">
          <div className="cal-row head" role="row">
            {dows.map((d) => <div key={d} role="columnheader">{d}</div>)}
            <div role="columnheader">WEEK</div>
          </div>
          {weeks.map((w) => {
            const monday = weekOfRow(w.start);
            const wm = weekMarks.get(monday)!;
            return (
              <div key={w.start} className="cal-row" role="row">
                {w.days.filter((d) => shown(d.date)).map((d) => {
                  const m = d.inMonth ? dayMark(d.date, j.today, entries, traded) : "none";
                  const cls = `cal-cell review ${d.inMonth ? "" : "out"} ${d.date === j.today ? "today" : ""} rv-${m}`;
                  return (
                    <a key={d.date} role="gridcell" className={cls} href={`#/day/${d.date}`} aria-label={`${d.date}: ${DAY_MARK[m].title}`}>
                      <span className="cal-date">{Number(d.date.slice(8))}</span>
                      <span className="rv-big"><Mark m={DAY_MARK[m]} /></span>
                    </a>
                  );
                })}
                <a role="gridcell" className={`cal-cell week review rv-${wm}`} href={`#/week/${monday}`} aria-label={`Week of ${monday}: ${PERIOD_MARK[wm].title}`}>
                  <span className="cal-date muted">WK</span>
                  <span className="rv-big"><Mark m={PERIOD_MARK[wm]} /></span>
                </a>
              </div>
            );
          })}
        </div>
      </section>
      <div className="dim small">✓ done · ◐ morning only · <span className="loss">●</span> traded, not reviewed · ○ today or still running. Click a day, week or the month to write it. The streak counts trading days in a row with the report card done; today never breaks it.</div>
    </main>
  );
}
