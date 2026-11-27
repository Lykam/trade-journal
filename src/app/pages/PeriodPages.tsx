// Weekly film study (Q91) and monthly review (Q92), SPEC §6.7i: the facts laid
// out to read, then a few questions saved to Playbook's Journal/.
import { useMemo } from "react";
import { answer, entryPath, mondayOf, moodOf, QUESTIONS, validKey, weekDays } from "../../core/cadence/entries";
import { bestWorst, monthFacts, periodIdeas, weekErrors, type Group, type PeriodIdea } from "../../core/cadence/period";
import { dayMark, tradingDays } from "../../core/cadence/status";
import { addDays, dayOfWeek } from "../../core/calendar";
import { nextMonth, prevMonth, type ViewState } from "../../core/journal/filter";
import type { Journal } from "../../core/journal/journal";
import { chartsFor } from "../../core/reviews/images";
import type { DataBundle } from "../../core/types";
import { useDeploying, useEntries } from "../cadence";
import { EntryForm } from "../components/EntryForm";
import { useImageSrcs } from "../data";
import { DOW, money, monthLabel, pnlClass } from "../format";
import { reviewLink, tradeLink } from "./TradesPage";

const MARK_ICON = { done: "✓", morning: "◐", missed: "●", today: "○", none: "" } as const;
const MARK_CLS = { done: "gain", morning: "accent", missed: "loss", today: "accent", none: "" } as const;

function Deploying({ show }: { show: boolean }) {
  return show ? <span className="chip accent" title="Saved; it stays for good once the site redeploys">DEPLOYING</span> : null;
}

/** One idea in the film study: its chart (when uploaded), P&L, play and grade, and links. */
function FilmCard({ p, data, view, src }: { p: PeriodIdea; data: DataBundle; view: ViewState; src: (path: string) => string | null | undefined }) {
  const charts = chartsFor(data.playbook?.images ?? [], [p.idea.date, ...p.dates], [p.idea.underlying, ...p.idea.symbolsTraded]);
  const chart = charts.find((c) => c.kind === "intraday") ?? charts[0];
  const url = chart ? src(chart.path) : null;
  const h = p.review?.header;
  return (
    <div className="film-card">
      <div className="row">
        <a className="sym b" href={tradeLink(p.trades[0]!.id, view)}>{p.idea.underlying}</a>
        <span className="muted small">{p.dates.map((d) => DOW[dayOfWeek(d)]).join(" ")} · {p.idea.style.toUpperCase()}</span>
        <span className="grow" />
        <span className={`b ${pnlClass(p.pnl)}`}>{money(p.pnl)}</span>
      </div>
      {chart ? (url ? <img className="film-img" src={url} alt={`${p.idea.underlying} ${chart.kind} chart`} loading="lazy" /> : <div className="film-img empty small">{url === null ? "Chart unavailable" : "Loading chart…"}</div>)
        : <div className="film-img empty small dim">No chart uploaded</div>}
      <div className="small">
        {p.review ? (
          <>
            {h?.play && <span className="chip">{h.play}</span>} {h?.grade && <span className="chip">{h.grade}</span>}{" "}
            <a href={reviewLink(p.review.id)}>review →</a>
            {h?.error && <div className="muted">Error: {h.error}</div>}
          </>
        ) : <a href={tradeLink(p.trades[0]!.id, view)}>Not reviewed. Review →</a>}
      </div>
    </div>
  );
}

export function WeekPage({ data, journal: j, monday, view }: { data: DataBundle; journal: Journal; monday: string; view: ViewState }) {
  const entries = useEntries(data);
  const deploying = useDeploying(data);
  const ok = validKey("weekly", monday);
  const traded = useMemo(() => tradingDays(j.trades), [j]);
  const ideas = useMemo(() => (ok ? periodIdeas(j, monday, addDays(monday, 6)) : []), [j, monday, ok]);
  const { best, worst } = bestWorst(ideas);
  const errors = useMemo(() => (ok ? weekErrors(j, monday) : []), [j, monday, ok]);
  const chartPaths = [...best, ...worst].flatMap((p) => chartsFor(data.playbook?.images ?? [], [p.idea.date, ...p.dates], [p.idea.underlying, ...p.idea.symbolsTraded]).map((c) => c.path));
  const srcs = useImageSrcs(chartPaths);
  if (!ok) return <main className="page"><div className="empty">Not a week (use its Monday): {monday}. <a href={`#/week/${mondayOf(monday)}`}>Go to that week →</a></div></main>;
  const days = weekDays(monday).filter((d) => dayOfWeek(d) % 6 !== 0 || traded.has(d) || entries.daily.has(d));
  const pnlOf = (d: string) => ideas.reduce((s, p) => s + (p.dates.includes(d) ? p.pnl / p.dates.length : 0), 0);
  const total = ideas.reduce((s, p) => s + p.pnl, 0);
  const entry = entries.weekly.get(monday) ?? null;

  const facts = (
    <>
      <section className="panel" aria-label="The week by day">
        <div className="panel-head">
          <h2>THE WEEK · <span className={pnlClass(total)}>{ideas.length ? money(Math.round(total * 100) / 100) : "NO TRADES"}</span></h2>
          <span className="muted small">{ideas.length} IDEA{ideas.length === 1 ? "" : "S"} · {ideas.filter((p) => p.pnl > 0).length}W {ideas.filter((p) => p.pnl < 0).length}L</span>
        </div>
        <div className="scroll-x"><table className="grid">
          <tbody>
            {days.map((d) => {
              const e = entries.daily.get(d);
              const m = dayMark(d, j.today, entries, traded);
              const going = answer(e, "Market Going In").split(/\r?\n/)[0] ?? "";
              return (
                <tr key={d}>
                  <td><a href={`#/day/${d}`}>{DOW[dayOfWeek(d)]} {d.slice(5)}</a></td>
                  <td className={MARK_CLS[m]} title={m}>{MARK_ICON[m]}</td>
                  <td>{moodOf(e) ? <span className="chip">{moodOf(e)}</span> : <span className="dim">—</span>}</td>
                  <td className="small">{going || <span className="dim">No morning context</span>}</td>
                  <td className="num">{traded.has(d) ? <span className={pnlClass(pnlOf(d))}>{money(Math.round(pnlOf(d) * 100) / 100)}</span> : <span className="dim">—</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table></div>
        <div className="dim small">A swing idea's P&L is split evenly across the days it booked on.</div>
      </section>

      <section className="panel" aria-label="Film study">
        <div className="panel-head"><h2>FILM STUDY</h2><span className="dim small">The week's best and worst ideas side by side. What did the winners share? When should you have seen the losers?</span></div>
        <div className="film">
          <div>
            <div className="label small gain">BEST {best.length}</div>
            {best.length ? best.map((p) => <FilmCard key={p.idea.id} p={p} data={data} view={view} src={(x) => srcs.get(x)} />) : <div className="dim small">No winners.</div>}
          </div>
          <div>
            <div className="label small loss">WORST {worst.length}</div>
            {worst.length ? worst.map((p) => <FilmCard key={p.idea.id} p={p} data={data} view={view} src={(x) => srcs.get(x)} />) : <div className="dim small">No losers.</div>}
          </div>
        </div>
      </section>

      <section className="panel" aria-label="Errors this week">
        <div className="panel-head"><h2>ERRORS THIS WEEK <span className="muted">· {errors.length}</span></h2><span className="dim small">From the week's trade reviews. REPEAT: twice this week, or also in the four weeks before.</span></div>
        {errors.length ? (
          <ul className="plain-list">
            {errors.map((e) => (
              <li key={e.error}>
                {e.repeat && <span className="chip loss">REPEAT</span>} {e.error}{" "}
                {e.reviews.map((r) => <a key={r.id} className="dim small" href={reviewLink(r.id)}> {r.ticker ?? r.id}</a>)}
              </li>
            ))}
          </ul>
        ) : <div className="dim small">No errors named in this week's reviews.</div>}
      </section>
    </>
  );

  return (
    <main className="page">
      <header className="page-head">
        <h1>WEEKLY REVIEW <span className="sub">/ week of {monday}</span> <Deploying show={deploying.has(entryPath("weekly", monday))} /></h1>
        <div className="row">
          <a className="btn" href={`#/week/${addDays(monday, -7)}`} aria-label="Previous week">‹</a>
          <a className="btn" href={`#/week/${mondayOf(j.today)}`}>THIS WEEK</a>
          <a className="btn" href={`#/week/${addDays(monday, 7)}`} aria-label="Next week">›</a>
          <a className="btn" href={`#/cal?mode=review&month=${monday.slice(0, 7)}`}>CALENDAR</a>
        </div>
      </header>
      <EntryForm key={monday} period="weekly" entryKey={monday} entry={entry} aside={facts}
        groups={[{ title: "THE REVIEW", note: "Four questions, after the last session of the week.", questions: QUESTIONS.weekly }]} />
    </main>
  );
}

function GroupTable({ title, rows, note }: { title: string; rows: Group[]; note?: string }) {
  return (
    <div className="month-group">
      <div className="label small">{title}</div>
      {rows.length ? (
        <table className="grid">
          <tbody>
            {rows.map((g) => (
              <tr key={g.label}>
                <td>{g.label}</td>
                <td className="num muted small">{g.ideas} · {Math.round((g.wins / g.ideas) * 100)}% W</td>
                <td className={`num ${pnlClass(g.pnl)}`}>{money(g.pnl)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <div className="dim small">{note ?? "Nothing yet."}</div>}
    </div>
  );
}

export function MonthPage({ data, journal: j, month }: { data: DataBundle; journal: Journal; month: string }) {
  const entries = useEntries(data);
  const deploying = useDeploying(data);
  const ok = validKey("monthly", month);
  const traded = useMemo(() => tradingDays(j.trades), [j]);
  const f = useMemo(() => (ok ? monthFacts(j, month, entries, traded) : null), [j, month, entries, traded, ok]);
  if (!ok || !f) return <main className="page"><div className="empty">Not a month: {month}</div></main>;
  const entry = entries.monthly.get(month) ?? null;

  const facts = (
    <section className="panel" aria-label="The month in numbers">
      <div className="panel-head">
        <h2>{monthLabel(month)} · <span className={pnlClass(f.pnl)}>{f.ideas ? money(f.pnl) : "NO TRADES"}</span></h2>
        <span className="muted small">{f.ideas} IDEAS · {f.ideas ? Math.round((f.wins / f.ideas) * 100) : 0}% WIN</span>
        <span className="grow" />
        <span className="small" title="Daily report cards done / trading days; weekly reviews done / weeks with trades">
          REVIEWED <b>{f.coverage.daysDone}/{f.coverage.days}</b> DAYS · <b>{f.coverage.weeksDone}/{f.coverage.weeks}</b> WEEKS
        </span>
      </div>
      <div className="month-groups">
        <GroupTable title="BY PLAY" rows={f.byPlay} />
        <GroupTable title="BY GRADE" rows={f.byGrade} />
        <GroupTable title="BY STYLE" rows={f.byStyle} />
        <GroupTable title="BY MARKET MOOD" rows={f.byMood} />
        <GroupTable title="BY ERROR" rows={f.byError} note="No errors named in reviews." />
      </div>
      <div className="dim small">Ideas grouped on the P&amp;L they booked this month. Play and grade come from each idea's latest review; mood from the daily journal of its first booked day.</div>
    </section>
  );

  return (
    <main className="page">
      <header className="page-head">
        <h1>MONTHLY REVIEW <span className="sub">/ {monthLabel(month)}</span> <Deploying show={deploying.has(entryPath("monthly", month))} /></h1>
        <div className="row">
          <a className="btn" href={`#/month/${prevMonth(month)}`} aria-label="Previous month">‹</a>
          <a className="btn" href={`#/month/${j.today.slice(0, 7)}`}>THIS MONTH</a>
          <a className="btn" href={`#/month/${nextMonth(month)}`} aria-label="Next month">›</a>
          <a className="btn" href={`#/cal?mode=review&month=${month}`}>CALENDAR</a>
        </div>
      </header>
      <EntryForm key={month} period="monthly" entryKey={month} entry={entry} aside={facts}
        groups={[{ title: "THE REVIEW", note: "Read the numbers first. Then four questions.", questions: QUESTIONS.monthly }]} />
    </main>
  );
}
