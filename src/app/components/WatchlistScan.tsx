import type { WatchlistScanFile, WatchlistScanRow, WatchlistScanTier } from "../../core/types";
import { stamp } from "../format";
import { TradingViewChart } from "./TradingViewChart";

const CARD_TIERS: WatchlistScanTier[] = ["high", "watching"];

const LIST_TIER_ORDER: WatchlistScanTier[] = ["suppressed", "not_graded"];
const TIER_LABEL: Record<WatchlistScanTier, string> = {
  high: "Live setups",
  watching: "Watching — shakeout happened, confirmation pending",
  suppressed: "Regime-suppressed breakout candidates",
  not_graded: "Not graded — earnings/news-driven, or avoid",
};
const TIER_CLASS: Record<WatchlistScanTier, string> = { high: "gain", watching: "half", suppressed: "muted", not_graded: "muted" };

function groupByTier(rows: WatchlistScanRow[]): Partial<Record<WatchlistScanTier, WatchlistScanRow[]>> {
  const out: Partial<Record<WatchlistScanTier, WatchlistScanRow[]>> = {};
  for (const r of rows) (out[r.tier] ??= []).push(r);
  return out;
}

function Row({ r }: { r: WatchlistScanRow }) {
  return (
    <li>
      <details>
        <summary className="scan-summary">
          <span className={TIER_CLASS[r.tier]}>▌{r.ticker}</span> <b>{r.tactic}</b> <span className="chip">{r.confidence}</span>
          <span className="text-2">{r.keyLevel} · stop {r.stop}</span>
        </summary>
        <div className="scan-detail text-2">
          <div>{r.section} · rel strength {r.relStrength} · {r.earnings}</div>
          <div>{r.rationale}</div>
        </div>
      </details>
    </li>
  );
}

/** High/watching tiers get a chart card instead of a collapsed row — these are the names worth a
    second look, so the daily shape is worth showing up front rather than behind a click. */
function Card({ r }: { r: WatchlistScanRow }) {
  return (
    <div className="scan-card panel">
      <div className="scan-card-head">
        <span className={TIER_CLASS[r.tier]}>▌{r.ticker}</span> <b>{r.tactic}</b> <span className="chip">{r.confidence}</span>
      </div>
      <div className="text-2 small">{r.keyLevel} · stop {r.stop}</div>
      <div className="text-2 small">{r.section} · rel strength {r.relStrength} · {r.earnings}</div>
      <p className="text-2 small scan-card-rationale">{r.rationale}</p>
      <TradingViewChart symbol={r.tvSymbol ?? r.ticker} range="12M" height={300} hideTopToolbar />
    </div>
  );
}

/** Entry-tactic grades from the watchlist-scan skill: undercut & reclaim, oops reversal, ugly-close + gap-up ORB, and a regime-gated CANSLIM breakout. Distinct from the quantitative RegimeCard above it — this is a narrative tape read gating which tactics apply. VWAP recovery is intentionally not scored. */
export function WatchlistScanCard({ w }: { w: WatchlistScanFile | null }) {
  if (!w) {
    return (
      <section className="panel" aria-label="Watchlist scan">
        <div className="muted">No watchlist scan yet — run the watchlist-scan Claude skill and commit its output to trade-history.</div>
      </section>
    );
  }
  const grouped = groupByTier(w.rows);
  const t = w.tapeRead;
  return (
    <section className="panel" aria-label="Watchlist scan">
      <div className="row">
        <b>{t.state}</b>
        <span className="muted">AS OF {stamp(w.asOf)}</span>
      </div>
      <p className="text-2">{t.evidence}</p>
      <p className="text-2">{t.rotationTell}</p>
      <div className="row text-2">
        <span><b>Favored:</b> {t.favoredTactics}</span>
        <span><b>Suppressed:</b> {t.suppressedTactics}</span>
        <span><b>Excluded:</b> {t.excludedTactic}</span>
      </div>
      {(() => {
        const cardRows = CARD_TIERS.flatMap((tier) => grouped[tier] ?? []);
        if (!cardRows.length) return null;
        return (
          <div>
            <div className="label small">Live setups ({cardRows.length})</div>
            <div className="scan-cards">
              {cardRows.map((r) => <Card key={r.ticker} r={r} />)}
            </div>
          </div>
        );
      })()}
      {LIST_TIER_ORDER.map((tier) => {
        const rows = grouped[tier];
        if (!rows?.length) return null;
        return (
          <div key={tier}>
            <div className="label small">{TIER_LABEL[tier]} ({rows.length})</div>
            <ul className="regime-checklist">
              {rows.map((r) => <Row key={r.ticker} r={r} />)}
            </ul>
          </div>
        );
      })}
      <p className="muted small">Source: {t.sourceWatchlist}</p>
    </section>
  );
}
