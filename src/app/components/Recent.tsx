import { holdLabel, type Recent } from "../../core/dashboard/dashboard";
import { reviewsOf, type Journal } from "../../core/journal/journal";
import { dateOf, mmdd, money, pct, pnlClass, underlyingTag } from "../format";
import { tradeHref } from "./OpenPositions";

function Column({ r, journal }: { r: Recent; journal: Journal }) {
  const s = r.summary;
  const pad = Array.from({ length: Math.max(0, 10 - r.streak.length) });
  return (
    <section className="panel" aria-label={`Recent ${r.style} trades`}>
      <div className="panel-head recent-head">
        <h2>{r.style === "day" ? "Day · last 10" : "Swing · last 10"}</h2>
        {/* Newest first, left to right, like the list below it (#15). */}
        <div className="streak" aria-label={`Results newest to oldest: ${[...r.streak].reverse().join(", ")}`} title="Newest on the left">
          {[...r.streak].reverse().map((res, i) => <span key={i} className={`bg-${res}`} title={res ?? ""} />)}
          {pad.map((_, i) => <span key={`p${i}`} />)}
        </div>
        <span className="grow" />
        <span className="muted">
          {s.wins}W {s.losses}L{s.breakevens ? ` ${s.breakevens}BE` : ""} · <b className="text-1">{pct(s.winRate)}</b> · NET{" "}

          <b className={pnlClass(s.netPnl)}>{money(s.netPnl)}</b>
        </span>
        <a href={`#/trades?style=${r.style}`}>ALL TRADES ›</a>
      </div>
      {r.trades.length === 0 ? (
        <div className="empty">No closed {r.style} trades yet</div>
      ) : (
        <div className="scroll-x"><table className="grid dense">
          <tbody>
            {r.trades.map((t) => (
              <tr key={t.id} className="clickable" onClick={() => (window.location.hash = tradeHref(t.id))}>
                <td className="dot-cell"><span className={`dot bg-${t.result}`} aria-label={t.result ?? ""} /></td>
                <td className="muted">{mmdd(dateOf(t.closedAt!))}</td>
                <td>
                  <a className="sym" href={tradeHref(t.id)}>{t.symbol}</a> <span className="tag">{underlyingTag(t)}</span>
                </td>
                <td className="muted">{holdLabel(t)}</td>
                <td className="review-cell">
                  {reviewsOf(journal, t)[0] && (
                    <a href={`#/journal/${encodeURIComponent(reviewsOf(journal, t)[0]!.id)}`} title="Reviewed: open the review" aria-label="Reviewed" onClick={(e) => e.stopPropagation()}>📄</a>
                  )}
                </td>
                <td className={`num b ${pnlClass(t.netPnl)}`}>{money(t.netPnl)}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
    </section>
  );
}

/** Dashboard block 3 (SPEC §6.1 item 3). Counts trades, ignores the range selector. */
export function RecentTen({ day, swing, journal }: { day: Recent; swing: Recent; journal: Journal }) {
  return (
    <div className="two-col">
      <Column r={day} journal={journal} />
      <Column r={swing} journal={journal} />
    </div>
  );
}
