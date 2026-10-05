// Trade detail (SPEC §6.4): header with Back / Previous / Next following the
// current filter and sort, stats, executions, timeline, idea, review notes and
// Playbook charts.
import { useMemo, useState } from "react";
import { buyFees, daysHeld, holdLabel } from "../../core/dashboard/dashboard";
import { quoteStatus } from "../../core/gauge/gauge";
import { tradeDate, type ViewState } from "../../core/journal/filter";
import { groupPnl, reviewsOf, type Journal } from "../../core/journal/journal";
import { neighbors, pageOf, tradeOrder, viewRows } from "../../core/journal/rows";
import { chartsFor } from "../../core/reviews/images";
import { cents, etDate } from "../../core/normalize/util";
import { markToMarket } from "../../core/trades/stats";
import type { DataBundle, Trade } from "../../core/types";
import { StagedPreview, useStagedOverrides } from "../components/BulkBar";
import { viewHref } from "../components/FilterBar";
import { Lightbox, type LightboxImage } from "../components/Lightbox";
import { Timeline } from "../components/OpenPositions";
import { Pnl } from "../components/Pnl";
import { LazyReview } from "../components/LazyReview";
import { copyText, useImageSrcs } from "../data";
import { mmdd, money, pnlClass, price, qty, realizedNote, signedPct, stamp, timeOf, whenOf } from "../format";
import { AUTO_TAGS } from "../../core/journal/tags";

import { EtfBadge, reviewLink, tradeLink } from "./TradesPage";

function Stat({ label, children, cls }: { label: string; children: React.ReactNode; cls?: string }) {
  return (
    <div className="stat">
      <span className="label small">{label}</span>
      <span className={cls}>{children}</span>
    </div>
  );
}

export function TradeDetail({ data, journal: j, id, view, now }: { data: DataBundle; journal: Journal; id: string; view: ViewState; now: string }) {
  const t = j.tradeById.get(id);
  const rows = useMemo(() => viewRows(j, view), [j, view]);
  if (!t) {
    return (
      <main className="page">
        <header className="page-head"><h1>TRADE <span className="sub">/ NOT FOUND</span></h1><a className="btn" href={viewHref("#/trades", view)}>‹ BACK</a></header>
        <div className="panel empty">No trade with this id in the current data.</div>
      </main>
    );
  }
  const order = tradeOrder(rows);
  const nb = neighbors(order, t.id);
  const back = viewHref("#/trades", { ...view, page: pageOf(rows, t.id) });
  // NEWER / OLDER only when the list is in date order, as on the review page; otherwise the steps follow another sort (#13).
  const steps = view.sort.key !== "date" ? { prev: "PREV", next: "NEXT" } : view.sort.dir === "desc" ? { prev: "NEWER", next: "OLDER" } : { prev: "OLDER", next: "NEWER" };
  const timed = t.broker === "webull" || j.fillById.get(t.fillIds[0] ?? "")?.timePrecision === "second";

  return (
    <main className="page">
      <header className="page-head">
        <h1>
          {t.symbol} <span className="sub">· {etDate(t.openedAt)}{timed ? ` ${timeOf(t.openedAt)}` : ""}</span>{" "}
          <EtfBadge t={t} /> {t.status !== "closed" && <span className={`chip ${t.status === "open" ? "accent" : "loss"}`}>{t.status.toUpperCase()}</span>}
          {t.excluded && <span className="chip">EXCLUDED</span>}
        </h1>
        <nav className="row" aria-label="Trade navigation">
          <a className="btn" href={back}>‹ BACK</a>
          <a className={`btn ${nb.prev ? "" : "disabled"}`} aria-disabled={!nb.prev} href={nb.prev ? tradeLink(nb.prev, view) : undefined}>‹ {steps.prev}</a>
          <span className="muted small">{nb.index >= 0 ? `${nb.index + 1} / ${nb.total}` : "NOT IN FILTER"}</span>
          <a className={`btn ${nb.next ? "" : "disabled"}`} aria-disabled={!nb.next} href={nb.next ? tradeLink(nb.next, view) : undefined}>{steps.next} ›</a>
        </nav>
      </header>
      <TagRow data={data} journal={j} t={t} />

      <div className="detail">
        <div className="col">
          <StatsPanel data={data} t={t} now={now} view={view} />
          <Executions journal={j} t={t} timed={timed} />
          <section className="panel">
            <div className="panel-head"><h2>Timeline</h2></div>
            <div style={{ padding: "10px 14px" }}>
              <Timeline trade={t} times={timed} now={t.status === "open" ? openNow(data, t, now) : undefined} />
            </div>
          </section>
          <IdeaPanel journal={j} t={t} view={view} />
        </div>
        <div className="col">
          <NotesPanel data={data} journal={j} t={t} />
        </div>
      </div>
      <Charts data={data} journal={j} t={t} />
    </main>
  );
}

function openNow(data: DataBundle, t: Trade, now: string) {
  const q = data.quotes?.quotes[t.symbol];
  return { shares: t.openQty, last: q?.price ?? null, stale: q ? quoteStatus(q, now).isStale : false };
}

function TagRow({ data, journal: j, t }: { data: DataBundle; journal: Journal; t: Trade }) {
  const tags = j.tags.get(t.id) ?? { auto: [], manual: t.tags, all: t.tags };
  const staging = useStagedOverrides(data);
  const { current, apply, discard, locked } = staging;
  const [adding, setAdding] = useState(false);
  const [tag, setTag] = useState("");
  const manual = current.trades[t.id]?.tags ?? t.tags;
  return (
    <section className="tagrow" aria-label="Tags">
      {/* Style, ETF and Reviewed already show in the header and stats (#13 row 107); a review Category stays. */}
      {tags.auto.filter((x) => !(AUTO_TAGS as readonly string[]).includes(x)).map((x) => <span key={x} className="chip auto" title="Automatic tag (review category)">{x}</span>)}
      {manual.map((x) => <span key={x} className="chip">{x}</span>)}
      {adding ? (
        <form className="row" onSubmit={(e) => { e.preventDefault(); if (tag.trim()) apply([t], { kind: "addTag", tag: tag.trim() }); setTag(""); }}>
          <input className="input" autoFocus value={tag} onChange={(e) => setTag(e.target.value)} placeholder="tag" aria-label="New tag" list="detail-tags" />
          <datalist id="detail-tags">{j.allTags.map((x) => <option key={x} value={x} />)}</datalist>
          <button type="submit" className="btn" disabled={locked}>ADD</button>
          <button type="button" className="btn ghost" disabled={locked} onClick={() => { setAdding(false); discard(); }}>CANCEL</button>
        </form>
      ) : (
        <button type="button" className="btn ghost" onClick={() => setAdding(true)}>ADD TAGS +</button>
      )}
      {(staging.staged || staging.committed) && <div style={{ flexBasis: "100%" }}><StagedPreview data={data} staging={staging} /></div>}
    </section>
  );
}

function StatsPanel({ data, t, now, view }: { data: DataBundle; t: Trade; now: string; view: ViewState }) {
  const bought = t.events.filter((e) => e.kind === "open" || e.kind === "add");
  const cost = bought.reduce((s, e) => s + e.qty * e.price, 0);
  const volume = t.events.reduce((s, e) => s + e.qty, 0) + t.unmatchedQty;
  const q = data.quotes?.quotes[t.symbol];
  const open = t.status === "open";
  const mark = open && q ? markToMarket(t, q.price) : null;
  const qs = q ? quoteStatus(q, now) : null;
  const hold = open ? `open ${daysHeld(t, now)}d` : holdLabel(t);
  const emph = (mode: "gross" | "net") => (view.pnl === mode ? "b" : "");
  // An open trade has no result yet: its mark comes first, and the closed-trade figures wait for the close (#14).
  const result = (n: number) => (open ? "—" : money(n));
  return (
    <section className="panel" aria-label="Stats">
      <div className="panel-head"><h2>Stats</h2></div>
      <div className="stats">
        {open && (
          <>
            <Stat label="TOTAL OPEN P&L" cls={`b ${pnlClass(mark?.total)}`}>{mark ? money(mark.total) : "—"}</Stat>
            <Stat label="UNREALIZED" cls={pnlClass(mark?.unrealized)}>{mark ? money(mark.unrealized) : "—"}</Stat>
            <Stat label="REALIZED">
              <span className={pnlClass(t.realizedPnl)}>{money(t.realizedPnl)}</span>{" "}
              <span className="dim">{realizedNote(t.events.filter((e) => e.kind === "trim").length, buyFees(t))}</span>
            </Stat>
            <Stat label="OPEN SHARES">{qty(t.openQty)} @ {price(t.avgCost)} avg</Stat>
            <Stat label="LAST">
              {q ? <>{price(q.price)} <span className={qs?.isStale ? "half" : "dim"}>{qs?.isStale ? `· STALE (${stamp(q.time)})` : stamp(q.time)}</span></> : <span className="half">not priced</span>}
            </Stat>
          </>
        )}
        <Stat label="SIZE">{qty(t.maxPosition)} sh</Stat>
        <Stat label="VOLUME">{qty(volume)}</Stat>
        <Stat label="FILLS">{t.fillIds.length}</Stat>
        <Stat label="AVG ENTRY">{price(t.avgEntry)}</Stat>
        <Stat label="AVG EXIT">{price(t.avgExit)}</Stat>
        <Stat label="GROSS P&L" cls={open ? "muted" : `${pnlClass(t.grossPnl)} ${emph("gross")}`}>{result(t.grossPnl)}</Stat>
        <Stat label="FEES">{money(t.fees, { sign: false })}</Stat>
        <Stat label="NET P&L" cls={open ? "muted" : `${pnlClass(t.netPnl)} ${emph("net")}`}>{result(t.netPnl)}</Stat>
        <Stat label="RETURN ON COST" cls={open ? "muted" : pnlClass(t.netPnl)}>{!open && cost ? signedPct(t.netPnl / cost) : "—"}</Stat>
        <Stat label="HOLD">{hold}</Stat>
        <Stat label="STYLE">{t.style.toUpperCase()}{t.sameDay && t.style === "swing" ? <span className="dim"> · same day</span> : null}</Stat>
        <Stat label="BROKER">{t.broker.toUpperCase()}</Stat>
        <Stat label="ACCOUNT">{t.account}</Stat>
        <Stat label="RESULT" cls={t.result ? (t.result === "win" ? "gain" : t.result === "loss" ? "loss" : "flat") : "muted"}>{t.result?.toUpperCase() ?? (open ? "OPEN" : "—")}</Stat>
        {t.instrument === "leveraged_etf" && (
          <Stat label="UNDERLYING">{t.underlying} · {t.leverage}x {t.direction === "inverse" ? "inverse" : "long"}</Stat>
        )}
      </div>
    </section>
  );
}

function Executions({ journal: j, t, timed }: { journal: Journal; t: Trade; timed: boolean }) {
  const fills = t.fillIds.map((id) => j.fillById.get(id));
  const missing = fills.some((f) => !f);
  // A position carried in from overrides.json openingPositions has a synthetic first fill (the trade id) that isn't a broker fill.
  const opening = !t.fillIds.includes(t.id) && t.events[0];
  return (
    <section className="panel" aria-label="Executions">
      <div className="panel-head"><h2>Fills · {t.fillIds.length}</h2></div>
      <div className="scroll-x">
        <table className="grid dense">
          <thead><tr><th>{timed ? "TIME (ET)" : "DATE"}</th><th>SIDE</th><th className="num">QTY</th><th className="num">PRICE</th><th className="num">FEES</th><th className="num">VALUE</th></tr></thead>
          <tbody>
            {opening && (
              <tr><td className="muted">{t.events[0]!.at.slice(0, 10)}</td><td className="muted" colSpan={5}>OPENING POSITION {qty(t.events[0]!.qty)} @ {price(t.events[0]!.price)} (overrides.json)</td></tr>
            )}
            {fills.map((f, i) =>
              f ? (
                <tr key={f.id}>
                  <td>{whenOf(f.executedAt, f.timePrecision)}</td>
                  <td className={f.side === "buy" ? "ev-open" : "ev-trim"}>{f.side.toUpperCase()}</td>
                  <td className="num">{qty(f.qty)}</td>
                  <td className="num">{price(f.price)}</td>
                  <td className="num">{money(f.fees, { sign: false })}</td>
                  <td className="num muted">{money(cents(f.qty * f.price), { sign: false })}</td>
                </tr>
              ) : (
                <tr key={t.fillIds[i]}><td className="dim" colSpan={6}>fill {t.fillIds[i]} not in the bundle</td></tr>
              ),
            )}
          </tbody>
        </table>
      </div>
      {missing && <div className="empty small">Some fills are missing from the data bundle.</div>}
    </section>
  );
}

function IdeaPanel({ journal: j, t, view }: { journal: Journal; t: Trade; view: ViewState }) {
  const idea = j.ideaById.get(t.ideaId);
  if (!idea) return null;
  const trades = idea.tradeIds.map((id) => j.tradeById.get(id)).filter((x) => x !== undefined);
  const counts = [...new Set(trades.map((x) => x.symbol))].map((s) => `${trades.filter((x) => x.symbol === s).length} ${s}`);
  return (
    <section className="panel" aria-label="Idea">
      <div className="panel-head">
        <h2>Idea: {idea.underlying} · {trades.length} trade{trades.length === 1 ? "" : "s"} · <Pnl p={groupPnl(j, trades, view.pnl)} /> {trades.length > 1 || idea.usedEtf ? `(${counts.join(", ")})` : ""}</h2>
        <span className="grow" />
        <span className="muted small">{idea.style.toUpperCase()} · OPENED {idea.date} · {idea.status.toUpperCase()}</span>
      </div>
      <div className="scroll-x"><table className="grid dense">
        <tbody>
          {trades.map((x) => (
            <tr key={x.id} className={x.id === t.id ? "current" : ""}>
              <td style={{ width: 14 }}>{x.id === t.id ? <span className="accent">▶</span> : null}</td>
              <td>{x.id === t.id ? <b>{x.symbol}</b> : <a className="sym" href={tradeLink(x.id, view)}>{x.symbol}</a>} <EtfBadge t={x} /></td>
              <td className="muted">{tradeDate(x)}</td>
              <td className="muted">{x.status === "open" ? "open" : holdLabel(x)}</td>
              <td className="num"><Pnl p={groupPnl(j, [x], view.pnl)} /></td>
            </tr>
          ))}
        </tbody>
      </table></div>
    </section>
  );
}

function NotesPanel({ data, journal: j, t }: { data: DataBundle; journal: Journal; t: Trade }) {
  const reviews = reviewsOf(j, t);
  const idea = j.ideaById.get(t.ideaId);
  const command = `/playbook-review ${idea?.underlying ?? t.underlying} ${idea?.date ?? etDate(t.openedAt)}`;
  const [copied, setCopied] = useState<"" | "ok" | "fail">("");
  const staging = useStagedOverrides(data);
  const { staged, apply, locked } = staging;
  const [note, setNote] = useState(t.note ?? "");
  if (reviews.length) {
    return (
      <section className="panel notes" aria-label="Review">
        {reviews.map((r) => (
          <div key={r.id}>
            <div className="panel-head">
              <h2>Idea review · {r.date ? mmdd(r.date) : "no date"}{r.header.status ? ` · ${r.header.status}` : ""}</h2>
              <span className="grow" />
              <a href={reviewLink(r.id)}>FULL REVIEW ›</a>
            </div>
            <div className="md-wrap"><LazyReview path={r.path} markdown={r.markdown} /></div>
          </div>
        ))}
      </section>
    );
  }
  return (
    <section className="panel notes" aria-label="Notes">
      <div className="panel-head"><h2>Notes</h2><span className="grow" /><span className="dim small">NOT REVIEWED YET</span></div>
      <div className="notes-body">
        <label className="label small" htmlFor="quick-note">QUICK NOTE</label>
        <textarea id="quick-note" className="input" rows={2} value={note} placeholder="One or two lines…" onChange={(e) => setNote(e.target.value)} />
        <div className="row">
          <button type="button" className="btn" disabled={locked || note === (t.note ?? "")} onClick={() => apply([t], { kind: "setNote", note })}>SAVE NOTE</button>
          {staged && <span className="dim small">previewed below; commit to save</span>}
        </div>
        <StagedPreview data={data} staging={staging} onDiscard={() => setNote(t.note ?? "")} />
        <div className="start-review">
          <button type="button" className="btn primary" onClick={async () => setCopied((await copyText(command)) ? "ok" : "fail")}>START REVIEW</button>
          <code>{command}</code>
          {copied === "ok" && <span className="gain small">COPIED, paste it into Claude in Playbook</span>}
          {copied === "fail" && <span className="half small">Clipboard blocked; copy the command above</span>}
        </div>
      </div>
    </section>
  );
}

function Charts({ data, journal: j, t }: { data: DataBundle; journal: Journal; t: Trade }) {
  const idea = j.ideaById.get(t.ideaId);
  const trades = (idea?.tradeIds ?? [t.id]).map((id) => j.tradeById.get(id)).filter((x) => x !== undefined);
  const dates = new Set([...(idea ? [idea.date] : []), ...trades.flatMap((x) => [etDate(x.openedAt), ...(x.closedAt ? [etDate(x.closedAt)] : [])])]);
  const charts = chartsFor(data.playbook?.images ?? [], dates, [t.underlying, ...(idea?.symbolsTraded ?? [t.symbol])]);
  const srcs = useImageSrcs(charts.map((c) => c.path));
  const images: Array<LightboxImage & { kind: string; date: string }> = charts.flatMap((c) => {
    const src = srcs.get(c.path);
    return src === null ? [] : [{ src: src ?? "", caption: `${c.name} · ${c.date}`, kind: c.kind, date: c.date }];
  });
  const [open, setOpen] = useState<number | null>(null);
  return (
    <section className="panel" aria-label="Charts">
      <div className="panel-head"><h2>Charts · {images.length}</h2><span className="dim small">PLAYBOOK IMAGES/{[...dates].sort().join(", ")}</span></div>
      {images.length === 0 ? (
        <div className="empty">No charts saved for this trade. Use <code>/chart-image</code> in Playbook.</div>
      ) : (
        <div className="gallery">
          {images.map((img, i) => (
            <button type="button" key={img.caption} className="thumb" disabled={!img.src} onClick={() => setOpen(i)} aria-label={`Open ${img.caption}`}>
              {img.src ? <img src={img.src} alt={img.caption} loading="lazy" /> : <span className="thumb-wait dim small">DECRYPTING…</span>}
              <span className="small"><b>{img.kind.toUpperCase()}</b> <span className="muted">{img.date}</span></span>
            </button>
          ))}
        </div>
      )}
      <Lightbox images={images} index={open} onIndex={setOpen} />
    </section>
  );
}
