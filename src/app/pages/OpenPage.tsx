import { useMemo } from "react";
import { accountValues } from "../../core/account/value";
import { openPositions, openTotals } from "../../core/dashboard/dashboard";
import { cents } from "../../core/normalize/util";
import type { DataBundle } from "../../core/types";
import { AccountLine, OpenTable } from "../components/OpenPositions";
import { usePersisted } from "../data";
import { money, pnlClass, realizedNote, stamp } from "../format";

const FILTERS = ["all", "swing", "day"] as const;

/** Open Positions page (SPEC §6.1a). */
export function OpenPage({ data, now }: { data: DataBundle; now: string }) {
  const [filter, setFilter] = usePersisted("tj.openFilter", "all", FILTERS);
  const quotes = data.quotes?.quotes ?? {};
  const accounts = useMemo(() => accountValues(data.derived.trades, data.config, quotes, now), [data, quotes, now]);
  const all = useMemo(() => openPositions(data.derived.trades, quotes, now, accounts), [data, quotes, now, accounts]);
  const rows = filter === "all" ? all : all.filter((r) => r.trade.style === filter);
  const t = openTotals(rows);
  const trims = rows.reduce((n, r) => n + r.trims.length, 0);
  const fees = cents(rows.reduce((s, r) => s + r.buyFees, 0));
  const cells = [
    { label: "UNREALIZED", value: money(t.unrealized), sub: "", cls: pnlClass(t.unrealized) },
    // Buy fees count as realized (Q44); saying so keeps a fee-only red tile from reading as a losing trim (#14).
    { label: "REALIZED", value: money(t.realized), sub: realizedNote(trims, fees), cls: pnlClass(t.realized) },
    { label: "TOTAL OPEN P&L", value: money(t.total), sub: "", cls: pnlClass(t.total) },
    { label: "MARKET VALUE", value: money(t.marketValue, { sign: false }), sub: `COST ${money(t.costBasis, { sign: false })}`, cls: "" },
    { label: "OPEN POSITIONS", value: String(t.count), sub: `${t.green} GREEN · ${t.red} RED${t.unpriced ? ` · ${t.unpriced} UNPRICED` : ""}`, cls: "" },
  ];
  return (
    <main className="page">
      <header className="page-head">
        <h1>OPEN POSITIONS <span className="sub">/ {t.count} · {t.pricesAsOf ? `PRICES ${stamp(t.pricesAsOf)}` : "NO PRICES"}{t.stale ? ` · ${t.stale} STALE` : ""}</span></h1>
        <div className="seg" role="group" aria-label="Style">
          {FILTERS.map((f) => (
            <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)}>{f.toUpperCase()}</button>
          ))}
        </div>
      </header>
      <section className="panel totals" aria-label="Totals">
        {cells.map((c) => (
          <div key={c.label}>
            <div className="label small">{c.label}</div>
            <div className={`v ${c.cls}`}>{c.value}</div>
            <div className="muted small">{c.sub}</div>
          </div>
        ))}
      </section>
      {accounts.size > 0 && <section className="panel" aria-label="Accounts"><AccountLine accounts={accounts} /></section>}
      <OpenTable rows={rows} totals={t} acct={accounts.size > 0} />
      <div className="dim small" title="Realized = locked in by trims, less buy fees. Unrealized = shares × (last − avg cost). Total = both.">
        Average-cost basis; may differ from Schwab's FIFO tax lots.
      </div>

    </main>
  );
}
