// Trades (SPEC §6.3): filtered, sortable table, one row per trade or per idea,
// paginated at 50, with bulk-select actions previewed against overrides.json.
import { Fragment, useMemo, useState } from "react";
import { queryOf, tradeDate, viewToParams, type SortKey, type ViewState } from "../../core/journal/filter";
import { groupPnl, reviewsOf, type Journal } from "../../core/journal/journal";
import { paginate, summarizeRows, viewRows, type Row } from "../../core/journal/rows";
import { holdLabel } from "../../core/dashboard/dashboard";
import type { DataBundle, Trade } from "../../core/types";
import { BulkBar } from "../components/BulkBar";
import { FilterBar, viewHref } from "../components/FilterBar";
import { Pnl } from "../components/Pnl";
import { go } from "../data";
import { mmdd, money, pct, pnlClass, qty } from "../format";

export const tradeLink = (id: string, v: ViewState) => `#/trade/${id}${queryOf(viewToParams(v, { page: false }))}`;
export const reviewLink = (id: string) => `#/journal/${encodeURIComponent(id)}`;

const COLUMNS: Array<{ key: SortKey; label: string; num?: boolean; title?: string }> = [
  { key: "date", label: "DATE" },
  { key: "symbol", label: "SYMBOL" },
  { key: "style", label: "STYLE" },
  { key: "volume", label: "VOLUME", num: true, title: "Shares bought + sold" },
  { key: "executions", label: "EXEC", num: true, title: "Fills" },
  { key: "hold", label: "HOLD" },
  { key: "pnl", label: "P&L", num: true },
  { key: "review", label: "REVIEW" },
  { key: "notes", label: "NOTES" },
  { key: "tags", label: "TAGS" },
];

function rowHold(r: Row): string {
  if (r.kind === "trade" || r.trades.length === 1) return r.open ? `open ${r.holdDays}d` : holdLabel(r.trades[0]!);
  if (r.open) return `open ${r.holdDays}d`;
  if (r.holdMinutes !== null && r.holdDays === 0) return holdLabel({ ...r.trades[0]!, holdMinutes: r.holdMinutes });
  return r.holdDays === 0 ? "same day" : `${r.holdDays} day${r.holdDays === 1 ? "" : "s"}`;
}

export function EtfBadge({ t }: { t: Pick<Trade, "instrument" | "underlying" | "leverage" | "direction"> }) {
  if (t.instrument !== "leveraged_etf") return null;
  return <span className="chip etf" title={`${t.leverage}x ${t.direction} single-stock ETF`}>ETF→{t.underlying}</span>;
}

function Tags({ r, j }: { r: Row; j: Journal }) {
  const auto = new Set(r.trades.flatMap((t) => j.tags.get(t.id)?.auto ?? []));
  const shown = r.tags.filter((x) => x !== "Day" && x !== "Swing" && x !== "Reviewed" && x !== "ETF");
  return (
    <span className="tags">
      {shown.slice(0, 3).map((t) => <span key={t} className={`chip ${auto.has(t) ? "auto" : ""}`}>{t}</span>)}
      {shown.length > 3 && <span className="dim">+{shown.length - 3}</span>}
    </span>
  );
}

export function TradesPage({ data, journal: j, view }: { data: DataBundle; journal: Journal; view: ViewState }) {
  const rows = useMemo(() => viewRows(j, view), [j, view]);
  const summary = summarizeRows(rows, view.pnl);
  const { items, page, pages } = paginate(rows, view.page);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const href = (v: Partial<ViewState>) => viewHref("#/trades", { ...view, ...v });

  const pageIds = items.flatMap((r) => r.trades.map((t) => t.id));
  const allOnPage = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  const toggle = (ids: string[], on: boolean) => {
    const next = new Set(selected);
    ids.forEach((id) => (on ? next.add(id) : next.delete(id)));
    setSelected(next);
  };
  const sortBy = (key: SortKey) =>
    go(href({ sort: { key, dir: view.sort.key === key ? (view.sort.dir === "asc" ? "desc" : "asc") : key === "symbol" || key === "style" ? "asc" : "desc" }, page: 1 }));

  const unit = view.count === "idea" ? "IDEAS" : "TRADES";
  return (
    <main className="page">
      <header className="page-head">
        <h1>TRADES <span className="sub">/ {summary.rows} {unit}{view.count === "idea" ? ` · ${summary.trades} TRADES` : ""}</span></h1>
      </header>
      <FilterBar view={view} journal={j} base="#/trades" />

      <section className="panel statrow" aria-label="Summary">
        <div><div className="label small">{view.pnl.toUpperCase()} P&amp;L</div><div className={`v ${pnlClass(summary.pnl)}`}>{money(summary.pnl)}</div><div className="muted small">REALIZED, CLOSED</div></div>
        <div><div className="label small">WIN % ({unit})</div><div className="v">{pct(summary.winRate, 1)}</div><div className="muted small">{summary.wins}W {summary.losses}L {summary.breakevens}BE · ON NET</div></div>
        <div><div className="label small">{unit}</div><div className="v">{summary.rows}</div><div className="muted small">{view.count === "idea" ? `${summary.trades} TRADES` : `${new Set(rows.flatMap((r) => r.trades.map((t) => t.ideaId))).size} IDEAS`}</div></div>
        <div><div className="label small">VOLUME</div><div className="v">{qty(summary.volume)}</div><div className="muted small">SHARES</div></div>
      </section>

      {selected.size > 0 && <BulkBar data={data} journal={j} selected={selected} onClear={() => setSelected(new Set())} />}

      <section className="panel">
        {rows.length === 0 ? (
          <div className="empty">No trades match these filters.</div>
        ) : (
          <div className="scroll-x">
            <table className="grid trades">
              <thead>
                <tr>
                  <th style={{ width: 28 }}>
                    <input type="checkbox" aria-label="Select all on this page" checked={allOnPage} onChange={(e) => toggle(pageIds, e.target.checked)} />
                  </th>
                  {COLUMNS.map((c) => {
                    const on = view.sort.key === c.key;
                    return (
                      <th key={c.key} className={c.num ? "num" : ""} aria-sort={on ? (view.sort.dir === "asc" ? "ascending" : "descending") : "none"} title={c.title}>
                        <button type="button" className={`sort ${on ? "on" : ""}`} onClick={() => sortBy(c.key)}>
                          {c.key === "pnl" ? `${view.pnl.toUpperCase()} P&L` : c.label}
                          <span aria-hidden="true">{on ? (view.sort.dir === "asc" ? " ▲" : " ▼") : ""}</span>
                        </button>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {items.map((r) => {
                  const ids = r.trades.map((t) => t.id);
                  const isIdea = r.kind === "idea";
                  const isOpen = expanded.has(r.id);
                  const first = r.trades[0]!;
                  const review = reviewsOf(j, first)[0];
                  const onRow = () => {
                    if (isIdea && r.trades.length > 1) setExpanded((s) => { const n = new Set(s); if (n.has(r.id)) n.delete(r.id); else n.add(r.id); return n; });
                    else go(tradeLink(first.id, view));
                  };
                  return (
                    <Fragment key={r.id}>
                      <tr className={`clickable ${first.excluded && !isIdea ? "excluded" : ""}`} onClick={onRow}>
                        <td onClick={(e) => e.stopPropagation()}>
                          <input type="checkbox" aria-label={`Select ${r.symbol} ${r.date}`} checked={ids.every((id) => selected.has(id))} onChange={(e) => toggle(ids, e.target.checked)} />
                        </td>
                        <td className="muted">
                          {r.firstDate !== r.date ? <>{mmdd(r.firstDate)}→{mmdd(r.date)}</> : r.date}
                        </td>
                        <td>
                          {isIdea && r.trades.length > 1 && <span className="caret" aria-hidden="true">{isOpen ? "▾" : "▸"} </span>}
                          <a className="sym" href={tradeLink(first.id, view)} onClick={(e) => e.stopPropagation()}>{r.symbol}</a>{" "}
                          {isIdea ? (
                            <span className="tag">{r.trades.length > 1 ? `${r.trades.length} TRADES` : ""}{r.symbols.some((s) => s !== r.symbol) ? ` ${r.symbols.join("/")}` : ""}</span>
                          ) : (
                            <EtfBadge t={first} />
                          )}
                          {r.open && <span className="chip accent">OPEN</span>}
                          {first.status === "unmatched" && <span className="chip loss">UNMATCHED</span>}
                          {first.excluded && !isIdea && <span className="chip">EXCL</span>}
                        </td>
                        <td className="muted">{r.style.toUpperCase()}</td>
                        <td className="num">{qty(r.volume)}</td>
                        <td className="num">{r.executions}</td>
                        <td className="muted">{rowHold(r)}</td>
                        <td className="num"><Pnl p={groupPnl(j, r.trades, view.pnl)} b /></td>
                        <td onClick={(e) => e.stopPropagation()}>
                          {review ? <a href={reviewLink(review.id)} title="Open review" aria-label="Open review">📄</a> : null}
                        </td>
                        <td className="note" title={r.note}>{r.note}</td>
                        <td><Tags r={r} j={j} /></td>
                      </tr>
                      {isIdea && isOpen && r.trades.map((t) => (
                        <tr key={t.id} className="clickable sub" onClick={() => go(tradeLink(t.id, view))}>
                          <td onClick={(e) => e.stopPropagation()}>
                            <input type="checkbox" aria-label={`Select ${t.symbol} trade`} checked={selected.has(t.id)} onChange={(e) => toggle([t.id], e.target.checked)} />
                          </td>
                          <td className="muted">↳ {mmdd(tradeDate(t))}</td>
                          <td><a className="sym" href={tradeLink(t.id, view)}>{t.symbol}</a> <EtfBadge t={t} /></td>
                          <td className="muted">{t.style.toUpperCase()}</td>
                          <td className="num">{qty(t.events.reduce((s, e) => s + e.qty, 0))}</td>
                          <td className="num">{t.fillIds.length}</td>
                          <td className="muted">{t.status === "open" ? "open" : holdLabel(t)}</td>
                          <td className="num"><Pnl p={groupPnl(j, [t], view.pnl)} /></td>
                          <td />
                          <td className="note" title={t.note}>{t.note}</td>
                          <td />
                        </tr>
                      ))}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {pages > 1 && (
        <nav className="pager" aria-label="Pages">
          <a className={`btn ${page === 1 ? "disabled" : ""}`} href={href({ page: page - 1 })} aria-disabled={page === 1}>‹ PREV</a>
          <span className="muted">PAGE {page} / {pages} · {(page - 1) * 50 + 1}–{Math.min(page * 50, rows.length)} OF {rows.length}</span>
          <a className={`btn ${page === pages ? "disabled" : ""}`} href={href({ page: page + 1 })} aria-disabled={page === pages}>NEXT ›</a>
        </nav>
      )}
    </main>
  );
}
