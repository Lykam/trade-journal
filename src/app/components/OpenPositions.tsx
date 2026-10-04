import type { OpenRow, OpenTotals } from "../../core/dashboard/dashboard";
import type { TradeEvent } from "../../core/types";
import { dateOf, mmdd, money, pnlClass, price, qty, signedPct, timeOf, underlyingTag } from "../format";

export const tradeHref = (id: string) => `#/trade/${id}`;

function Sym({ r, big }: { r: OpenRow; big?: boolean }) {
  const t = r.trade;
  return (
    <>
      <a className="sym" href={tradeHref(t.id)} style={big ? { fontSize: 15 } : undefined}>{t.symbol}</a>{" "}
      {underlyingTag(t) && <span className="tag">{underlyingTag(t)}</span>}
    </>
  );
}

function Last({ r }: { r: OpenRow }) {
  if (!r.quote) return <span className="half" title="No quote: left out of the swing gauge">—</span>;
  return (
    <span title={`${timeOf(r.quote.time)} ${dateOf(r.quote.time)}${r.quote.marketState ? ` · ${r.quote.marketState}` : ""}`}>
      {price(r.last)}
      {r.quote.isStale && <span className="half"> *</span>}
    </span>
  );
}

const trimText = (e: TradeEvent) => `${mmdd(dateOf(e.at))} −${qty(e.qty)} @${price(e.price)}`;

export function asOfText(totals: OpenTotals): string {
  if (!totals.pricesAsOf) return "NO PRICES";
  return `AS OF ${timeOf(totals.pricesAsOf)} ${mmdd(dateOf(totals.pricesAsOf))}`;
}

/** Dashboard block 2 (SPEC §6.1 item 2). */
export function OpenQuick({ rows, totals }: { rows: OpenRow[]; totals: OpenTotals }) {
  return (
    <section className="panel" aria-label="Open positions">
      <div className="panel-head">
        <h2>Open positions · {totals.count}</h2>
        {totals.count > 0 && (
          <>
            <span className="headline">UNREAL <b className={pnlClass(totals.unrealized)}>{money(totals.unrealized)}</b></span>
            <span className="headline">REALIZED (TRIMS) <b className={pnlClass(totals.realized)}>{money(totals.realized)}</b></span>
            <span className="headline">TOTAL <b className={pnlClass(totals.total)}>{money(totals.total)}</b></span>
          </>
        )}
        <span className="grow" />
        {totals.unpriced > 0 && <span className="half">{totals.unpriced} NOT PRICED</span>}
        {totals.stale > 0 && <span className="half">* {totals.stale} STALE</span>}
        <span className="dim">{asOfText(totals)}</span>
        <a href="#/open">DETAILS ›</a>
      </div>
      {rows.length === 0 ? (
        <div className="empty">No open positions</div>
      ) : (
        <div className="scroll-x">
          <table className="grid" style={{ minWidth: 1040 }}>
            <thead>
              <tr>
                <th>SYMBOL</th><th>OPENED</th><th>TRIMS</th><th className="num">SHARES</th><th className="num">AVG</th>
                <th className="num">LAST</th><th className="num">UNREAL</th><th className="num">%</th>
                <th className="num">REALIZED</th><th className="num">TOTAL</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.trade.id}>
                  <td><Sym r={r} /> <span className="accent small">{r.trade.style.toUpperCase()}</span></td>
                  <td style={{ color: "var(--text-2)" }}>{mmdd(dateOf(r.trade.openedAt))} <span className="dim">({r.daysHeld}d)</span></td>
                  <td style={{ color: "var(--text-2)" }}>{r.trims.length ? r.trims.map(trimText).join(", ") : "—"}</td>
                  <td className="num">{qty(r.shares)} <span className="dim">/ {qty(r.maxShares)}</span></td>
                  <td className="num">{price(r.avgCost)}</td>
                  <td className="num"><Last r={r} /></td>
                  <td className={`num b ${pnlClass(r.unrealized)}`}>{money(r.unrealized)}</td>
                  <td className={`num ${pnlClass(r.unrealized)}`}>{signedPct(r.unrealizedPct)}</td>
                  <td className={`num ${pnlClass(r.realized)}`}>{money(r.realized)}</td>
                  <td className={`num b ${pnlClass(r.total)}`}>{money(r.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

const KIND_LABEL: Record<TradeEvent["kind"], string> = { open: "OPEN", add: "ADD", trim: "TRIM", close: "CLOSE" };

export function Timeline({ r }: { r: OpenRow }) {
  return (
    <div className="timeline">
      {r.trade.events.map((e, i) => (
        <div className="ev" key={i}>
          <span className={`ev-${e.kind}`}>{KIND_LABEL[e.kind]}</span>
          <span style={{ color: "var(--text-2)" }}>{dateOf(e.at)}</span>
          <span>{e.kind === "open" || e.kind === "add" ? "BUY" : "SELL"} {qty(e.qty)} @ {price(e.price)}</span>
          {e.realized !== undefined && <span className={pnlClass(e.realized)}>{money(e.realized)}</span>}
        </div>
      ))}
      <div className="ev now">NOW {qty(r.shares)} sh @ {price(r.last)}{r.quote?.isStale ? " (stale)" : ""}</div>
    </div>
  );
}

/** Open Positions page table (SPEC §6.1a). */
export function OpenTable({ rows, totals }: { rows: OpenRow[]; totals: OpenTotals }) {
  if (rows.length === 0) return <section className="panel"><div className="empty">No open positions</div></section>;
  const unrealPct = totals.costBasis ? totals.unrealized / totals.costBasis : null;
  return (
    <section className="panel scroll-x" aria-label="Positions">
      <table className="grid" style={{ minWidth: 1180 }}>
        <thead>
          <tr style={{ borderBottom: "1px solid var(--border-strong)" }}>
            <th>SYMBOL</th><th>STYLE</th><th>OPENED</th><th className="num">DAYS</th><th className="num">SHARES</th>
            <th className="num">AVG COST</th><th className="num">LAST</th><th className="num">MKT VALUE</th>
            <th className="num">UNREAL</th><th className="num">UNREAL %</th><th className="num">REALIZED</th><th className="num">TOTAL</th>
          </tr>
        </thead>
        {rows.map((r) => (
          <tbody key={r.trade.id}>
            <tr>
              <td style={{ paddingTop: 10 }}><Sym r={r} big /></td>
              <td className="accent">{r.trade.style.toUpperCase()}</td>
              <td>{dateOf(r.trade.openedAt)}</td>
              <td className="num">{r.daysHeld}</td>
              <td className="num">{qty(r.shares)} <span className="dim">/ {qty(r.maxShares)}</span></td>
              <td className="num">{price(r.avgCost)}</td>
              <td className="num"><Last r={r} /></td>
              <td className="num" style={{ color: "var(--text-2)" }}>{money(r.marketValue, { sign: false })}</td>
              <td className={`num b ${pnlClass(r.unrealized)}`}>{money(r.unrealized)}</td>
              <td className={`num ${pnlClass(r.unrealized)}`}>{signedPct(r.unrealizedPct)}</td>
              <td className={`num ${pnlClass(r.realized)}`}>{money(r.realized)}</td>
              <td className={`num b ${pnlClass(r.total)}`}>{money(r.total)}</td>
            </tr>
            <tr style={{ borderTop: 0 }}>
              <td colSpan={12} style={{ padding: "0 14px 12px", whiteSpace: "normal" }}><Timeline r={r} /></td>
            </tr>
          </tbody>
        ))}
        <tbody>
          <tr className="total">
            <td colSpan={7} className="muted" style={{ letterSpacing: "0.08em" }}>
              TOTAL · {totals.count} POSITION{totals.count === 1 ? "" : "S"}{totals.unpriced ? ` · ${totals.unpriced} UNPRICED (NOT IN TOTALS)` : ""}
            </td>
            <td className="num" style={{ color: "var(--text-2)" }}>{money(totals.marketValue, { sign: false })}</td>
            <td className={`num b ${pnlClass(totals.unrealized)}`}>{money(totals.unrealized)}</td>
            <td className={`num ${pnlClass(totals.unrealized)}`}>{signedPct(unrealPct)}</td>
            <td className={`num ${pnlClass(totals.realized)}`}>{money(totals.realized)}</td>
            <td className={`num b ${pnlClass(totals.total)}`}>{money(totals.total)}</td>
          </tr>
        </tbody>
      </table>
    </section>
  );
}
