// Journal (SPEC §6.7): Playbook reviews, newest first, filterable by the global
// filter bar, and a read-only review page with the linked idea's trades.
import { useMemo } from "react";
import type { ViewState } from "../../core/journal/filter";
import { filterReviews, groupPnl, type Journal } from "../../core/journal/journal";
import type { Review } from "../../core/reviews/join";
import type { Trade } from "../../core/types";
import { FilterBar, viewHref } from "../components/FilterBar";
import { LazyReview } from "../components/LazyReview";
import { Pnl } from "../components/Pnl";
import { EtfBadge, reviewLink, tradeLink } from "./TradesPage";

function ideaFor(j: Journal, r: Review) {
  const idea = j.ideaById.get(j.reviews.ideaOf.get(r.id) ?? "");
  const trades = (idea?.tradeIds ?? []).map((id) => j.tradeById.get(id)).filter((t): t is Trade => t !== undefined);
  return { idea, trades };
}


function StatusChip({ r }: { r: Review }) {
  if (!r.header.status) return <span className="dim">—</span>;
  return <span className={`chip ${r.header.status === "open" ? "accent" : ""}`}>{r.header.status.toUpperCase()}</span>;
}

export function JournalPage({ journal: j, view }: { journal: Journal; view: ViewState }) {
  const reviews = useMemo(() => filterReviews(j, view.filter), [j, view.filter]);
  const total = j.reviews.reviews.length;
  return (
    <main className="page">
      <header className="page-head">
        <h1>JOURNAL <span className="sub">/ {reviews.length}{reviews.length !== total ? ` OF ${total}` : ""} PLAYBOOK REVIEWS</span></h1>
      </header>
      <FilterBar view={view} journal={j} base="#/journal" count={false} />
      <section className="panel">
        {total === 0 ? (
          <div className="empty">
            No reviews found. Reviews are read from <code>Reviews/*.md</code> in the Playbook checkout (<code>PLAYBOOK_DIR</code>, default
            <code> ../Playbook</code>). Write one with <code>/playbook-review</code>, or start one from a trade's detail page.
          </div>
        ) : reviews.length === 0 ? (
          <div className="empty">No reviews match these filters.</div>
        ) : (
          <div className="scroll-x">
            <table className="grid">
              <thead>
                <tr>
                  <th>DATE</th><th>TICKER</th><th className="ph-hide">TYPE</th><th>STATUS</th><th className="ph-hide">CATEGORY</th>
                  <th className="num">IDEA {view.pnl.toUpperCase()} P&amp;L</th><th className="num ph-hide">TRADES</th><th className="ph-hide">IDEA</th>
                </tr>
              </thead>
              <tbody>
                {reviews.map((r) => {
                  const { idea, trades } = ideaFor(j, r);
                  return (
                    <tr key={r.id} className="clickable" onClick={() => (window.location.hash = reviewLink(r.id))}>
                      <td className="muted">{r.date ?? "—"}</td>
                      <td>
                        <a className="sym" href={reviewLink(r.id)}>{r.ticker ?? r.id}</a>
                        {r.underlying && r.underlying !== r.ticker && <span className="tag"> →{r.underlying}</span>}
                      </td>
                      <td className="muted ph-hide">{r.header.tradeType?.toUpperCase() ?? "—"}</td>
                      <td><StatusChip r={r} /></td>
                      <td className="muted ph-hide">{r.header.category ?? ""}</td>
                      <td className="num">{idea ? <Pnl p={groupPnl(j, trades, view.pnl)} b /> : <span className="dim">—</span>}</td>
                      <td className="num ph-hide">{idea ? trades.length : "—"}</td>
                      <td className="ph-hide">{idea ?
 <span className="muted small">{idea.style.toUpperCase()} · {idea.status.toUpperCase()}</span> : <span className="half small">NO MATCHING IDEA</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}

export function ReviewPage({ journal: j, id, view }: { journal: Journal; id: string; view: ViewState }) {
  const r = j.reviews.byId.get(id);
  const list = useMemo(() => filterReviews(j, view.filter), [j, view.filter]);
  const back = viewHref("#/journal", view);
  if (!r) {
    return (
      <main className="page">
        <header className="page-head"><h1>REVIEW <span className="sub">/ NOT FOUND</span></h1><a className="btn" href={back}>‹ JOURNAL</a></header>
        <div className="panel empty">No review with this name in the Playbook checkout.</div>
      </main>
    );
  }
  const { idea, trades } = ideaFor(j, r);
  const i = list.findIndex((x) => x.id === r.id);
  const newer = i > 0 ? list[i - 1] : undefined;
  const older = i >= 0 ? list[i + 1] : undefined;
  const nav = (x: Review | undefined) => (x ? `${reviewLink(x.id)}${back.slice("#/journal".length)}` : undefined);
  const method = j.reviews.method.get(r.id);
  return (
    <main className="page">
      <header className="page-head">
        <h1>{r.ticker ?? r.id} <span className="sub">· {r.date ?? "no date"} · {r.header.tradeType?.toUpperCase() ?? "REVIEW"}</span> <StatusChip r={r} /></h1>
        <nav className="row" aria-label="Review navigation">
          <a className="btn" href={back}>‹ JOURNAL</a>
          <a className={`btn ${newer ? "" : "disabled"}`} aria-disabled={!newer} href={nav(newer)}>‹ NEWER</a>
          <a className={`btn ${older ? "" : "disabled"}`} aria-disabled={!older} href={nav(older)}>OLDER ›</a>
        </nav>
      </header>

      <section className="panel" aria-label="Linked idea">
        <div className="panel-head">
          {idea ? (
            <>
              <h2>Idea: {idea.underlying} · {trades.length} trade{trades.length === 1 ? "" : "s"} · <Pnl p={groupPnl(j, trades, view.pnl)} /> {view.pnl.toUpperCase()}</h2>
              <span className="grow" />
              <span className="muted small">{idea.style.toUpperCase()} · OPENED {idea.date} · {idea.status.toUpperCase()} · LINKED BY {method === "idea-id" ? "IDEA ID" : method === "re-entry" ? "RE-ENTRY DATE" : "DATE + TICKER"}</span>
            </>
          ) : (
            <h2 className="half">No matching idea for {r.date} {r.ticker}: check the date and ticker, or add an Idea ID line</h2>
          )}
        </div>
        {idea && (
          <div className="strip">
            {trades.map((t) => (
              <a key={t.id} className="strip-item" href={tradeLink(t.id, view)}>
                <span className="sym">{t.symbol}</span> <EtfBadge t={t} />
                <span className="muted small">{t.openedAt.slice(5, 10)}{t.closedAt ? `→${t.closedAt.slice(5, 10)}` : " open"}</span>
                <Pnl p={groupPnl(j, [t], view.pnl)} b />
              </a>
            ))}
          </div>
        )}
      </section>

      <article className="panel md-wrap">
        <LazyReview path={r.path} markdown={r.markdown} />
      </article>
      <div className="dim small">Read-only. Reviews are written in Playbook with <code>/playbook-review</code>.</div>
    </main>
  );
}
