import { useState } from "react";
import { addDays, dayOfWeek } from "../../core/calendar";
import { weekStrip } from "../../core/dashboard/dashboard";
import type { Trade } from "../../core/types";
import { DOW, money, pnlClass } from "../format";

/**
 * Day cards for the gauge week, with arrows to step back through weeks (SPEC §6.1 item 4).
 * Saturday and Sunday only get a card when something was booked on them (#15).
 * A card is the P&L booked that day, trims included, and links to those trades (Q67).
 */
export function WeekStrip({ trades, today, startsOn, reviewDates }: { trades: Trade[]; today: string; startsOn: "monday" | "sunday"; reviewDates: Set<string> }) {
  const [offset, setOffset] = useState(0);
  const all = weekStrip(trades, addDays(today, offset * 7), startsOn);
  const cards = all.filter((d) => d.trades > 0 || dayOfWeek(d.date) % 6 !== 0);
  const range = `${all[0]!.date} – ${all[6]!.date}`;
  return (
    <section className="panel" aria-label={`Week ${range}, all styles`}>
      <div className="week">
        <button type="button" className="arrow" aria-label="Previous week" onClick={() => setOffset(offset - 1)}>‹</button>
        <div className={`days n${cards.length}`}>
          {cards.map((d) => (
            <a key={d.date} className={`day ${d.date === today ? "today" : ""}`} href={`#/trades?date=${d.date}&booked=1`} title={`${d.date} · all styles`}>
              <div className="muted">
                {DOW[dayOfWeek(d.date)]}<span className="wk-date"> {d.date.slice(5)}</span>
                {reviewDates.has(d.date) && <span title="A review exists for this day" aria-label="reviewed"> 📄</span>}
              </div>
              <div className={`pnl ${pnlClass(d.net)}`}>{d.trades ? money(d.net) : "0.00"}</div>
              <div className="muted">{d.trades} TRADE{d.trades === 1 ? "" : "S"}</div>
            </a>
          ))}
        </div>
        <button type="button" className="arrow" aria-label="Next week" disabled={offset >= 0} onClick={() => setOffset(offset + 1)}>›</button>
      </div>
      <div className="week-note dim small">ALL STYLES · {range}</div>
    </section>
  );
}
