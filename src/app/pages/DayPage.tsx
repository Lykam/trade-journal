// Daily entry (SPEC §6.7i, Q89): the morning context written once before the
// open, and the report card after the close beside the day's facts and ideas.
import { useMemo } from "react";
import { MOODS, QUESTIONS, entryPath, field, mondayOf, validKey } from "../../core/cadence/entries";
import { dayFacts, type DayIdea } from "../../core/cadence/day";
import { addDays, dayOfWeek } from "../../core/calendar";
import { computeGauges } from "../../core/gauge/gauge";
import type { ViewState } from "../../core/journal/filter";
import type { Journal } from "../../core/journal/journal";
import type { DataBundle } from "../../core/types";
import { useDeploying, useEntries } from "../cadence";
import { EntryForm } from "../components/EntryForm";
import { DOW, money, pnlClass } from "../format";
import { reviewLink, tradeLink } from "./TradesPage";

/** The weekday before / after, skipping weekends. */
function stepWeekday(date: string, dir: 1 | -1): string {
  let d = addDays(date, dir);
  while (dayOfWeek(d) % 6 === 0) d = addDays(d, dir);
  return d;
}

/** "Regime RISK-ON · Day gauge FULL · Swing gauge HALF": what the app knew when the morning was saved. */
function snapshotLine(data: DataBundle, trades: Journal["trades"], now: string): string {
  const parts: string[] = [];
  const regime = data.regime?.snapshot.state;
  if (regime) parts.push(`Regime ${regime.toUpperCase()}`);
  const g = computeGauges({ trades, config: data.config, now, quotes: data.quotes?.quotes ?? {} });
  if (g.day.state) parts.push(`Day gauge ${g.day.state.toUpperCase()}`);
  if (g.swing.state) parts.push(`Swing gauge ${g.swing.state.toUpperCase()}`);
  return parts.join(" · ");
}

function IdeaRow({ d, j, view }: { d: DayIdea; j: Journal; view: ViewState }) {
  const reviews = j.reviews.byIdea.get(d.idea.id) ?? [];
  return (
    <tr>
      <td className="b">{d.idea.underlying}</td>
      <td className="muted small">{d.idea.style.toUpperCase()}</td>
      <td className={`num ${pnlClass(d.pnl)}`}>{money(d.pnl)}</td>
      <td className="muted small">{d.trades.length} trade{d.trades.length === 1 ? "" : "s"}</td>
      <td>
        {reviews.length
          ? reviews.map((r) => <a key={r.id} className="chip" href={reviewLink(r.id)}>REVIEWED</a>)
          : <a className="small" href={tradeLink(d.trades[0]!.id, view)}>REVIEW →</a>}
      </td>
    </tr>
  );
}

export function DayPage({ data, journal: j, date, view, now }: { data: DataBundle; journal: Journal; date: string; view: ViewState; now: string }) {
  const entries = useEntries(data);
  const deploying = useDeploying(data);
  const facts = useMemo(() => dayFacts(date, j.trades, j.ideaById), [date, j]);
  const ok = validKey("daily", date);
  if (!ok) return <main className="page"><div className="empty">Not a date: {date}</div></main>;
  const entry = entries.daily.get(date) ?? null;
  const isToday = date === j.today;
  const snapshot = isToday ? snapshotLine(data, j.trades, now) : "";
  const dow = DOW[dayOfWeek(date)]!;

  const factsPanel = (
    <section className="panel" aria-label="The day in numbers">
      <div className="panel-head">
        <h2>THE DAY · <span className={pnlClass(facts.pnl)}>{facts.trades ? money(facts.pnl) : "NO TRADES"}</span></h2>
        {facts.trades > 0 && <span className="muted small">{facts.ideas.length} IDEA{facts.ideas.length === 1 ? "" : "S"} · {facts.trades} TRADE{facts.trades === 1 ? "" : "S"}</span>}
      </div>
      {facts.trades > 0 ? (
        <>
          <div className="row small">
            {facts.best && <span>BEST <b>{facts.best.idea.underlying}</b> <span className="gain">{money(facts.best.pnl)}</span></span>}
            {facts.worst && <span>WORST <b>{facts.worst.idea.underlying}</b> <span className="loss">{money(facts.worst.pnl)}</span></span>}
            {facts.afterFirstLoss && (
              <span title="Ideas opened after the day's first losing idea">
                AFTER FIRST LOSS <span className={pnlClass(facts.afterFirstLoss.pnl)}>{facts.afterFirstLoss.ideas ? money(facts.afterFirstLoss.pnl) : "—"}</span>
                <span className="dim"> · {facts.afterFirstLoss.ideas} idea{facts.afterFirstLoss.ideas === 1 ? "" : "s"}</span>
              </span>
            )}
          </div>
          <div className="scroll-x">
            <table className="grid">
              <tbody>{facts.ideas.map((d) => <IdeaRow key={d.idea.id} d={d} j={j} view={view} />)}</tbody>
            </table>
          </div>
        </>
      ) : (
        <div className="dim small">Nothing booked this day. The morning context is still worth writing.</div>
      )}
    </section>
  );

  return (
    <main className="page">
      <header className="page-head">
        <h1>
          DAILY JOURNAL <span className="sub">/ {dow} {date}</span>{" "}
          {deploying.has(entryPath("daily", date)) && <span className="chip accent" title="Saved; it stays for good once the site redeploys">DEPLOYING</span>}
        </h1>
        <div className="row">
          <a className="btn" href={`#/day/${stepWeekday(date, -1)}`} aria-label="Previous weekday">‹</a>
          <a className="btn" href={`#/day/${j.today}`}>TODAY</a>
          <a className="btn" href={`#/day/${stepWeekday(date, 1)}`} aria-label="Next weekday">›</a>
          <a className="btn" href={`#/week/${mondayOf(date)}`}>WEEK</a>
          <a className="btn" href={`#/cal?mode=review&month=${date.slice(0, 7)}`}>CALENDAR</a>
        </div>
      </header>
      {field(entry, "Snapshot") && <div className="muted small">SNAPSHOT AT SAVE · {field(entry, "Snapshot")}</div>}
      <EntryForm
        key={date}
        period="daily"
        entryKey={date}
        entry={entry}
        extraFields={snapshot ? { Snapshot: snapshot } : undefined}
        groups={[
          {
            title: "MORNING CONTEXT",
            note: "Before the open, once. Trade reviews lean on it.",
            picks: [{ field: "Market Mood", label: "MARKET MOOD", options: MOODS, hint: "One pick. The monthly review groups P&L by it." }],
            questions: QUESTIONS.daily.filter((q) => q.part === "morning"),
          },
          {
            title: "REPORT CARD",
            note: "After the close. Two minutes.",
            picks: [{ field: "Risk Plan Followed", label: "RISK PLAN FOLLOWED", options: ["YES", "NO"] }],
            questions: QUESTIONS.daily.filter((q) => q.part === "report"),
          },
        ]}
        aside={factsPanel}
      />
    </main>
  );
}
