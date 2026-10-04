import type { DataBundle } from "../../core/types";
import { holdLabel } from "../../core/dashboard/dashboard";
import { dateOf, money, pnlClass, price, qty, underlyingTag } from "../format";

/** Placeholder for pages that arrive in a later milestone (SPEC §9). */
export function Stub({ title, milestone, params }: { title: string; milestone: number; params?: URLSearchParams }) {
  const filter = params && [...params].map(([k, v]) => `${k}=${v}`).join(" · ");
  return (
    <main className="page">
      <header className="page-head"><h1>{title}</h1></header>
      <div className="panel empty">
        Arrives in milestone {milestone}.{filter ? <> Requested filter: <span className="accent">{filter}</span></> : null}
      </div>
    </main>
  );
}

/** Minimal trade view until Trade detail lands in milestone 3. */
export function TradeStub({ data, id }: { data: DataBundle; id: string }) {
  const t = data.derived.trades.find((x) => x.id === id);
  if (!t) return <Stub title="TRADE" milestone={3} />;
  return (
    <main className="page">
      <header className="page-head">
        <h1>{t.symbol} <span className="sub">{underlyingTag(t)} · {dateOf(t.openedAt)} · {t.style.toUpperCase()} · {t.broker.toUpperCase()}</span></h1>
        <button type="button" className="btn" onClick={() => history.back()}>‹ BACK</button>
      </header>
      <section className="panel" style={{ padding: "12px 14px", display: "flex", flexWrap: "wrap", gap: "8px 24px" }}>
        <span className="muted">STATUS <b style={{ color: "var(--text)" }}>{t.status}</b></span>
        <span className="muted">MAX <b style={{ color: "var(--text)" }}>{qty(t.maxPosition)}</b></span>
        <span className="muted">ENTRY <b style={{ color: "var(--text)" }}>{price(t.avgEntry)}</b></span>
        <span className="muted">EXIT <b style={{ color: "var(--text)" }}>{price(t.avgExit)}</b></span>
        <span className="muted">NET <b className={pnlClass(t.netPnl)}>{money(t.netPnl)}</b></span>
        <span className="muted">HOLD <b style={{ color: "var(--text)" }}>{holdLabel(t) || "open"}</b></span>
      </section>
      <section className="panel scroll-x">
        <table className="grid">
          <thead><tr><th>EVENT</th><th>WHEN</th><th className="num">QTY</th><th className="num">PRICE</th><th className="num">REALIZED</th></tr></thead>
          <tbody>
            {t.events.map((e, i) => (
              <tr key={i}>
                <td className={`ev-${e.kind}`}>{e.kind.toUpperCase()}</td>
                <td>{t.broker === "webull" ? new Date(e.at).toLocaleString("en-US", { timeZone: "America/New_York" }) : dateOf(e.at)}</td>
                <td className="num">{qty(e.qty)}</td>
                <td className="num">{price(e.price)}</td>
                <td className={`num ${pnlClass(e.realized)}`}>{e.realized === undefined ? "" : money(e.realized)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <div className="panel empty">Full trade detail (executions, idea, review, charts) arrives in milestone 3.</div>
    </main>
  );
}
