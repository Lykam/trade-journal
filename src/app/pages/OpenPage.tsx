import { useMemo } from "react";
import { openPositions, openTotals } from "../../core/dashboard/dashboard";
import type { DataBundle } from "../../core/types";
import { asOfText, OpenTable } from "../components/OpenPositions";
import { usePersisted } from "../data";
import { money, pnlClass } from "../format";

const FILTERS = ["all", "swing", "day"] as const;

/** Open Positions page (SPEC §6.1a). */
export function OpenPage({ data, now }: { data: DataBundle; now: string }) {
  const [filter, setFilter] = usePersisted("tj.openFilter", "all", FILTERS);
  const quotes = data.quotes?.quotes ?? {};
  const all = useMemo(() => openPositions(data.derived.trades, quotes, now), [data, quotes, now]);
  const rows = filter === "all" ? all : all.filter((r) => r.trade.style === filter);
  const t = openTotals(rows);
  const cells = [
    { label: "UNREALIZED", value: money(t.unrealized), sub: "OPEN SHARES @ LAST", cls: pnlClass(t.unrealized) },
    { label: "REALIZED (TRIMS)", value: money(t.realized), sub: `FROM ${rows.reduce((n, r) => n + r.trims.length, 0)} TRIMS`, cls: pnlClass(t.realized) },
    { label: "TOTAL OPEN P&L", value: money(t.total), sub: "REALIZED + UNREALIZED", cls: pnlClass(t.total) },
    { label: "MARKET VALUE", value: money(t.marketValue, { sign: false }), sub: `COST ${money(t.costBasis, { sign: false })}`, cls: "" },
    { label: "OPEN POSITIONS", value: String(t.count), sub: `${t.green} GREEN · ${t.red} RED${t.unpriced ? ` · ${t.unpriced} UNPRICED` : ""}`, cls: "" },
  ];
  return (
    <main className="page">
      <header className="page-head">
        <h1>OPEN POSITIONS <span className="sub">/ {t.count} OPEN · PRICES {asOfText(t)} (YAHOO){t.stale ? ` · * ${t.stale} STALE` : ""}</span></h1>
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
      <OpenTable rows={rows} totals={t} />
      <div className="dim">
        REALIZED = P&amp;L LOCKED IN BY TRIMS (AVG-COST BASIS). UNREALIZED = SHARES × (LAST − AVG COST). TOTAL = BOTH. MAY DIFFER
        FROM SCHWAB'S TAX-LOT (FIFO) FIGURES BY DESIGN.
      </div>
    </main>
  );
}
