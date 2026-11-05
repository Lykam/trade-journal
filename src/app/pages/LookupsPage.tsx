// Single-stock inverse ETF lookup (SPEC §6): type a ticker (either side) to find it in the
// curated table. No trade data needed, so this needs no `data` prop.
import { useState } from "react";
import { searchInverseEtfs } from "../../core/lookups/lookups";

export function LookupsPage() {
  const [query, setQuery] = useState("");
  const rows = searchInverseEtfs(query);

  return (
    <main className="page">
      <header className="page-head"><h1>LOOKUPS</h1></header>
      <section className="panel" aria-label="Single-stock inverse ETFs">
        <div className="panel-head">
          <h2>Inverse ETFs · {rows.length}</h2>
          <span className="grow" />
          <input
            className="input narrow"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setQuery("")}
            placeholder="Ticker, e.g. NVDA or TSLQ"
            spellCheck={false}
            autoFocus
          />
        </div>
        <div className="scroll-x">
          <table className="grid dense lookups">
            <thead><tr><th>ETF</th><th>UNDERLYING</th><th className="num" title="Leverage">LEV</th><th>ISSUER</th></tr></thead>
            <tbody>
              {(() => {
                let band = 0;
                return rows.map((r, i) => {
                  if (i === 0 || rows[i - 1]!.underlying !== r.underlying) band++;
                  return (
                    <tr key={r.symbol} className={band % 2 ? "band" : ""}>
                      <td><b>{r.symbol}</b></td>
                      <td>{r.underlying}</td>
                      <td className="num">{r.leverage}x</td>
                      <td className="muted">{r.issuer}</td>
                    </tr>
                  );
                });
              })()}
            </tbody>
          </table>
          {!rows.length && <div className="empty">No inverse ETF on file for "{query}" — either none exists, or it's not in the curated list yet (see below).</div>}
        </div>
        <div className="dim small">
          Single-stock inverse ETFs only — curated from the owner's TradingView watchlist, not sector/index/commodity inverse ETFs. Refreshed manually, every so often.
        </div>
      </section>
    </main>
  );
}
