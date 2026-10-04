import { useState } from "react";
import { addDays, dayOfWeek } from "../../core/calendar";
import { weekStrip } from "../../core/dashboard/dashboard";
import type { Trade } from "../../core/types";
import { DOW, money, pnlClass } from "../format";

/** Seven day cards (the gauge week), with arrows to step back through weeks (SPEC §6.1 item 4). */
export function WeekStrip({ trades, today, startsOn, reviewDates }: { trades: Trade[]; today: string; startsOn: "monday" | "sunday"; reviewDates: Set<string> }) {
  const [offset, setOffset] = useState(0);
  const cards = weekStrip(trades, addDays(today, offset * 7), startsOn);
  const range = `${cards[0]!.date} – ${cards[6]!.date}`;
  return (
    <section className="panel scroll-x" aria-label={`Week ${range}`}>
      <div className="week">
        <button type="button" className="arrow" aria-label="Previous week" onClick={() => setOffset(offset - 1)}>‹</button>
        <div className="days">
          {cards.map((d) => (
            <a key={d.date} className={`day ${d.date === today ? "today" : ""}`} href={`#/trades?date=${d.date}`}>
              <div className="muted">{DOW[dayOfWeek(d.date)]} {d.date.slice(5)}{reviewDates.has(d.date) && <span title="A review exists for this day" aria-label="reviewed"> 📄</span>}</div>
              <div className={`pnl ${pnlClass(d.net)}`}>{d.trades ? money(d.net) : "0.00"}</div>
              <div className="muted">{d.trades} TRD</div>
            </a>
          ))}
        </div>
        <button type="button" className="arrow" aria-label="Next week" disabled={offset >= 0} onClick={() => setOffset(offset + 1)}>›</button>
      </div>
    </section>
  );
}
