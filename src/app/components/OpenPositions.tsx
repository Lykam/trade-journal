import { useState } from "react";
import type { AccountValue } from "../../core/account/value";
import { sortOpenRows, type OpenRow, type OpenSort, type OpenTotals } from "../../core/dashboard/dashboard";
import type { Trade, TradeEvent } from "../../core/types";
import { dateOf, mmdd, money, pct, pnlClass, price, qty, realizedNote, signedPct, stamp, timeOf, etfBadge } from "../format";

export const tradeHref = (id: string) => `#/trade/${id}`;

function Sym({ r, big }: { r: OpenRow; big?: boolean }) {
  const t = r.trade;
  return (
    <>
      <a className={`sym ${big ? "big" : ""}`} href={tradeHref(t.id)}>{t.symbol}</a>{" "}
      {etfBadge(t) && <span className="tag">{etfBadge(t)}</span>}
    </>
  );
}

function Last({ r }: { r: OpenRow }) {
  if (!r.quote) return <span className="half" title="No quote: left out of the swing gauge">—</span>;
  return (
    <span title={`${timeOf(r.quote.time)} ${dateOf(r.quote.time)}${r.quote.marketState ? ` · ${r.quote.marketState}` : ""}`}>
      {price(r.last)}
      {/* A stale price says how old it is on the row itself (#14). */}
      {r.quote.isStale && <span className="half"> * {stamp(r.quote.time)}</span>}
    </span>
  );
}

const realizedTitle = (r: OpenRow) => `${realizedNote(r.trims.length, r.buyFees)} (average-cost basis)`;

const trimText = (e: TradeEvent) => `${mmdd(dateOf(e.at))} −${qty(e.qty)} @${price(e.price)}`;

/** One line per account with a balance (Q68): its value, cash and the share in cash. */
export function AccountLine({ accounts }: { accounts: Map<string, AccountValue> }) {
  if (!accounts.size) return null;
  return (
    <div className="acct-line">
      {[...accounts.values()].map((a) => (
        <span key={a.account} className="headline" title={acctTitle(a)}>
          {a.account.toUpperCase()} <b>{money(a.value, { sign: false })}</b>
          <span className="muted"> · CASH {money(a.cash, { sign: false })} ({pct(a.value > 0 ? a.cash / a.value : null, 1)})</span>
          {a.atCost > 0 && <span className="half"> · {a.atCost} AT COST</span>}
        </span>
      ))}
      <a href="#/settings" className="small">EDIT ›</a>
    </div>
  );
}

function acctTitle(a: AccountValue): string {
  const base = `Started ${money(a.balance.start.amount, { sign: false })} on ${a.balance.start.date}; cash = start + every buy and sale since.`;
  const cp = a.checkpoint
    ? ` Actual ${money(a.checkpoint.value, { sign: false })} entered for ${a.checkpoint.date}, a ${money(a.adjustment)} correction.`
    : " No actual value entered yet.";
  return base + cp + (a.atCost ? " Positions without a price count at cost." : "");
}

/** Dashboard block 2 (SPEC §6.1 item 2). */
export function OpenQuick({ rows, totals, accounts = new Map() }: { rows: OpenRow[]; totals: OpenTotals; accounts?: Map<string, AccountValue> }) {
  const acct = accounts.size > 0;
  return (
    <section className="panel" aria-label="Open positions">
      <div className="panel-head">
        <h2>Open positions · {totals.count}</h2>
        {totals.count > 0 && (
          <>
            <span className="headline">UNREALIZED <b className={pnlClass(totals.unrealized)}>{money(totals.unrealized)}</b></span>
            <span className="headline">REALIZED <b className={pnlClass(totals.realized)}>{money(totals.realized)}</b></span>
            <span className="headline">TOTAL <b className={pnlClass(totals.total)}>{money(totals.total)}</b></span>
          </>
        )}
        <span className="grow" />
        {totals.unpriced > 0 && <span className="half">{totals.unpriced} NOT PRICED</span>}
        {totals.stale > 0 && <span className="half">* {totals.stale} STALE</span>}
        {!totals.pricesAsOf && totals.count > 0 && <span className="dim">NO PRICES</span>}
        <a href="#/open">ALL OPEN ›</a>

      </div>
      <AccountLine accounts={accounts} />
      {rows.length === 0 ? (
        <div className="empty">No open positions</div>
      ) : (
        <div className="scroll-x">
          <table className="grid open-quick">
            <thead>
              <tr>
                <th>SYMBOL</th><th className="ph-hide">OPENED</th><th className="ph-hide">TRIMS</th><th className="num ph-hide">SHARES</th><th className="num ph-hide">AVG</th>
                <th className="num ph-hide">LAST</th>{acct && <th className="num ph-hide" title="Share of the account's value">% ACCT</th>}<th className="num ph-hide">UNREALIZED</th><th className="num">%</th>
                <th className="num ph-hide">REALIZED</th><th className="num">TOTAL</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.trade.id}>
                  <td><Sym r={r} /> <span className="accent small">{r.trade.style.toUpperCase()}</span></td>
                  <td className="text-2 ph-hide">{mmdd(dateOf(r.trade.openedAt))} <span className="dim">({r.daysHeld}d)</span></td>
                  <td className="text-2 ph-hide">{r.trims.length ? r.trims.map(trimText).join(", ") : "—"}</td>
                  <td className="num ph-hide">{qty(r.shares)} <span className="dim">/ {qty(r.maxShares)}</span></td>
                  <td className="num ph-hide">{price(r.avgCost)}</td>
                  <td className="num ph-hide"><Last r={r} /></td>
                  {acct && <td className="num ph-hide">{pct(r.acctShare, 1)}</td>}
                  <td className={`num b ph-hide ${pnlClass(r.unrealized)}`}>{money(r.unrealized)}</td>
                  <td className={`num ${pnlClass(r.unrealized)}`}>{signedPct(r.unrealizedPct)}</td>
                  <td className={`num ph-hide ${pnlClass(r.realized)}`} title={realizedTitle(r)}>{money(r.realized)}</td>
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

/** OPEN / ADD / TRIM / CLOSE events, plus a NOW card while the position is open (Open Positions, Trade detail). */
export function Timeline({ trade, now, times }: { trade: Trade; now?: { shares: number; last: number | null; stale?: boolean }; times?: boolean }) {
  return (
    <div className="timeline">
      {trade.events.map((e, i) => (
        <div className="ev" key={i}>
          <span className={`ev-${e.kind}`}>{KIND_LABEL[e.kind]}</span>
          <span className="text-2">{dateOf(e.at)}{times ? ` ${timeOf(e.at)}` : ""}</span>
          <span>{e.kind === "open" || e.kind === "add" ? "BUY" : "SELL"} {qty(e.qty)} @ {price(e.price)}</span>
          {e.realized !== undefined && <span className={pnlClass(e.realized)}>{money(e.realized)}</span>}
        </div>
      ))}
      {now && <div className="ev now">NOW {qty(now.shares)} sh @ {price(now.last)}{now.stale ? " (stale)" : ""}</div>}
    </div>
  );
}

/** `phone`: still shown below 640 px, where the rest is hidden so P&L never falls off-screen (#17). */
const OPEN_COLUMNS: Array<{ key: OpenSort; label: string; num?: boolean; phone?: boolean }> = [
  { key: "symbol", label: "SYMBOL", phone: true }, { key: "style", label: "STYLE" }, { key: "opened", label: "OPENED" },
  { key: "days", label: "DAYS", num: true, phone: true }, { key: "shares", label: "SHARES", num: true }, { key: "avg", label: "AVG COST", num: true },
  { key: "last", label: "LAST", num: true }, { key: "value", label: "MARKET VALUE", num: true }, { key: "acct", label: "% OF ACCT", num: true }, { key: "unrealized", label: "UNREALIZED", num: true },
  { key: "pct", label: "UNREALIZED %", num: true, phone: true }, { key: "realized", label: "REALIZED", num: true }, { key: "total", label: "TOTAL", num: true, phone: true },
];
const ph = (key: OpenSort) => (OPEN_COLUMNS.find((c) => c.key === key)!.phone ? "" : "ph-hide");

/** Adds or trims make a timeline worth a line; a plain open is already the row itself (#14). */
const hasHistory = (t: Trade) => t.events.some((e) => e.kind === "add" || e.kind === "trim");

/** Open Positions page table (SPEC §6.1a), sortable on every column. */
export function OpenTable({ rows, totals, acct = false }: { rows: OpenRow[]; totals: OpenTotals; acct?: boolean }) {
  // % OF ACCT only once an account has a balance (Q68).
  const columns = acct ? OPEN_COLUMNS : OPEN_COLUMNS.filter((c) => c.key !== "acct");
  const [sort, setSort] = useState<{ key: OpenSort; dir: 1 | -1 }>({ key: "opened", dir: 1 });
  if (rows.length === 0) return <section className="panel"><div className="empty">No open positions</div></section>;
  const unrealPct = totals.costBasis ? totals.unrealized / totals.costBasis : null;
  const sorted = sortOpenRows(rows, sort.key, sort.dir);
  const by = (key: OpenSort) =>
    setSort((s) => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : key === "symbol" || key === "style" || key === "opened" ? 1 : -1 }));
  return (
    <section className="panel scroll-x" aria-label="Positions">
      <table className="grid open-table">
        <thead>
          <tr>
            {columns.map((c) => {
              const on = sort.key === c.key;
              return (
                <th key={c.key} className={`${c.num ? "num" : ""} ${ph(c.key)}`} aria-sort={on ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
                  <button type="button" className={`sort ${on ? "on" : ""}`} onClick={() => by(c.key)}>
                    {c.label}<span aria-hidden="true">{on ? (sort.dir === 1 ? " ▲" : " ▼") : ""}</span>
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        {sorted.map((r) => (
          <tbody key={r.trade.id}>
            <tr>
              <td className="sym-cell"><Sym r={r} big /></td>
              <td className="accent ph-hide">{r.trade.style.toUpperCase()}</td>
              <td className="ph-hide">{dateOf(r.trade.openedAt)}</td>
              <td className="num">{r.daysHeld}</td>
              <td className="num ph-hide">{qty(r.shares)} <span className="dim">/ {qty(r.maxShares)}</span></td>
              <td className="num ph-hide">{price(r.avgCost)}</td>
              <td className="num ph-hide"><Last r={r} /></td>
              <td className="num text-2 ph-hide">{money(r.marketValue, { sign: false })}</td>
              {acct && <td className="num ph-hide">{pct(r.acctShare, 1)}</td>}
              <td className={`num b ph-hide ${pnlClass(r.unrealized)}`}>{money(r.unrealized)}</td>
              <td className={`num ${pnlClass(r.unrealized)}`}>{signedPct(r.unrealizedPct)}</td>
              <td className={`num ph-hide ${pnlClass(r.realized)}`} title={realizedTitle(r)}>{money(r.realized)}</td>
              <td className={`num b ${pnlClass(r.total)}`}>{money(r.total)}</td>
            </tr>
            {hasHistory(r.trade) && (
              <tr className="timeline-row">
                <td colSpan={columns.length}><Timeline trade={r.trade} now={{ shares: r.shares, last: r.last, stale: r.quote?.isStale }} /></td>
              </tr>
            )}
          </tbody>
        ))}
        <tbody>
          <tr className="total">
            {/* Phone shows SYMBOL and DAYS before % and TOTAL, so its label spans two columns (#17). */}
            <td colSpan={2} className="muted spaced ph-only">TOTAL · {totals.count}</td>
            <td colSpan={7} className="muted spaced ph-hide">

              TOTAL · {totals.count} POSITION{totals.count === 1 ? "" : "S"}{totals.unpriced ? ` · ${totals.unpriced} UNPRICED (NOT IN TOTALS)` : ""}
            </td>
            <td className="num text-2 ph-hide">{money(totals.marketValue, { sign: false })}</td>
            {acct && <td className="num ph-hide">{pct(sumShare(rows), 1)}</td>}
            <td className={`num b ph-hide ${pnlClass(totals.unrealized)}`}>{money(totals.unrealized)}</td>
            <td className={`num ${pnlClass(totals.unrealized)}`}>{signedPct(unrealPct)}</td>
            <td className={`num ph-hide ${pnlClass(totals.realized)}`}>{money(totals.realized)}</td>

            <td className={`num b ${pnlClass(totals.total)}`}>{money(totals.total)}</td>
          </tr>
        </tbody>
      </table>
    </section>
  );
}

/** The shown rows' combined share of their accounts (rows without a balance add nothing). */
const sumShare = (rows: OpenRow[]) => (rows.some((r) => r.acctShare !== null) ? rows.reduce((s, r) => s + (r.acctShare ?? 0), 0) : null);
