// Errors (SPEC §6.7a, Q77): Darvas's table of errors. Every reviewed losing idea
// with the error its review names, so the mistakes that repeat stand out.
import { useMemo } from "react";
import { errorTable, type Journal } from "../../core/journal/journal";
import { money } from "../format";
import { Pnl } from "../components/Pnl";
import { reviewLink } from "./TradesPage";

export function ErrorsPage({ journal: j }: { journal: Journal }) {
  const rows = useMemo(() => errorTable(j), [j]);
  const total = rows.reduce((s, r) => s + r.idea.netPnl, 0);
  const missing = rows.filter((r) => r.error === null).length;
  return (
    <main className="page">
      <header className="page-head">
        <h1>ERRORS <span className="sub">/ {rows.length} REVIEWED LOSS{rows.length === 1 ? "" : "ES"}{rows.length ? ` · ${money(total)}` : ""}</span></h1>
      </header>
      <div className="dim small">
        Every losing trade's review, and the error that caused the loss. Read down the list for the ones that repeat.
        {missing > 0 && <> {missing} still {missing === 1 ? "has" : "have"} no error written.</>}
      </div>
      <section className="panel">
        {rows.length === 0 ? (
          <div className="empty">
            No reviewed losing trades yet. When a reviewed trade closes at a loss, <code>/playbook-review</code> asks “What was the error?” and the answer shows here.
          </div>
        ) : (
          <div className="scroll-x">
            <table className="grid">
              <thead>
                <tr><th>DATE</th><th>TICKER</th><th className="ph-hide">TYPE</th><th className="num">NET P&amp;L</th><th>ERROR</th></tr>
              </thead>
              <tbody>
                {rows.map(({ idea, review, error }) => (
                  <tr key={idea.id} className="clickable" onClick={() => (window.location.hash = reviewLink(review.id))}>
                    <td className="muted">{idea.date}</td>
                    <td><a className="sym" href={reviewLink(review.id)}>{idea.underlying}</a></td>
                    <td className="muted ph-hide">{idea.style.toUpperCase()}</td>
                    <td className="num"><Pnl p={{ value: idea.netPnl, open: false }} b /></td>
                    <td className="error-text">
                      {error ?? <span className="half" title="Add it under “## The Error” in the review">NOT WRITTEN</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
