// Setups (watchlist-scan skill): entry-tactic grades for the TradingView "Ready" watchlist,
// committed into trade-history by Claude since the scan needs a live TradingView MCP session.
import type { DataBundle } from "../../core/types";
import { WatchlistScanCard, WatchlistScanThesisPreview } from "../components/WatchlistScan";

export function SetupsPage({ data }: { data: DataBundle }) {
  return (
    <main className="page">
      <header className="page-head">
        <h1>SETUPS <span className="sub">/ WATCHLIST SCAN</span></h1>
      </header>
      <WatchlistScanThesisPreview thesis={data.watchlistScanThesis} />
      <WatchlistScanCard w={data.watchlistScan} />
    </main>
  );
}
