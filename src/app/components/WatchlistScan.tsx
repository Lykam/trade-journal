import { useState } from "react";
import type { WatchlistScanFile, WatchlistScanRow, WatchlistScanThesisFile, WatchlistScanTier } from "../../core/types";
import { useWatchlistScanDay } from "../data";
import { DOW, stamp } from "../format";
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

/** `chart`: load the TradingView widget only once this row is expanded (and only for high/watching
    tiers) — used by the history picker so picking a day never loads more than the rows you open. */
function Row({ r, chart = false }: { r: WatchlistScanRow; chart?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <li>
      <details open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
        <summary className="scan-summary">
          <span className={TIER_CLASS[r.tier]}>▌{r.ticker}</span> <b>{r.tactic}</b> <span className="chip">{r.confidence}</span>
          <span className="text-2">{r.keyLevel} · stop {r.stop}</span>
        </summary>
        <div className="scan-detail text-2">
          <div>{r.section} · rel strength {r.relStrength} · {r.earnings}</div>
          <div>{r.rationale}</div>
          {chart && open && (r.tier === "high" || r.tier === "watching") && (
            <TradingViewChart symbol={r.tvSymbol ?? r.ticker} range="12M" height={300} hideTopToolbar />
          )}
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

/**
 * Tonight's evening-thesis routine's forward-looking read for the next trading day, shown as a
 * draft preview — the morning routine re-pulls fresh premarket data, compares it against this,
 * and may confirm or revise every row before it ever reaches `watchlistScan`. Only rendered while
 * that comparison hasn't happened yet (load-bundle.ts hides it once the day is finalized).
 */
export function WatchlistScanThesisPreview({ thesis }: { thesis: WatchlistScanThesisFile | null }) {
  if (!thesis) return null;
  const t = thesis.tapeRead;
  const liveRows = thesis.rows.filter((r) => r.tier === "high" || r.tier === "watching");
  return (
    <section className="panel muted" aria-label="Evening thesis preview">
      <div className="row">
        <b>DRAFT — thesis for {thesis.thesisFor}</b>
        <span className="muted">AS OF {stamp(thesis.asOf)}</span>
      </div>
      <p className="text-2 small">
        Unconfirmed — written off last night's close. Tomorrow's 9am scan re-pulls fresh premarket data and will confirm or revise this before it's live.
      </p>
      <p className="text-2">{t.state}</p>
      {liveRows.length > 0 && (
        <div className="scan-cards">
          {liveRows.map((r) => <Card key={r.ticker} r={r} />)}
        </div>
      )}
      {liveRows.length === 0 && <p className="text-2 small">No live/watching setups in tonight's thesis.</p>}
    </section>
  );
}

const ALL_TIER_ORDER: WatchlistScanTier[] = ["high", "watching", "suppressed", "not_graded"];

/** "2026-11-09" -> "Mon 11/9/26" — DOW is Sun-first all-caps 3-letter codes (src/app/format.ts). */
function dayLabel(date: string): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const dow = DOW[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]!;
  return `${dow[0]}${dow.slice(1).toLowerCase()} ${m}/${d}/${String(y).slice(2)}`;
}

/** One foldable day in the history list — collapsed to just its date; opening it is what triggers
    the fetch (useWatchlistScanDay gets null until then), and each row's own chart stays behind its
    own fold (Row's `chart` prop), so opening a day never pulls in more than its text. */
function HistoryDay({ date }: { date: string }) {
  const [open, setOpen] = useState(false);
  const day = useWatchlistScanDay(open ? date : null);
  const grouped = day ? groupByTier(day.rows) : null;
  return (
    <li>
      <details open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
        <summary className="scan-summary">{dayLabel(date)}</summary>
        <div className="scan-detail text-2">
          {day === undefined && <p className="text-2 small">Loading…</p>}
          {day === null && <p className="text-2 small">Couldn't load this day — it may not be in this deploy yet.</p>}
          {day && (
            <>
              <div className="row">
                <b>{day.tapeRead.state}</b>
                <span className="muted">AS OF {stamp(day.asOf)}</span>
              </div>
              {ALL_TIER_ORDER.map((tier) => {
                const rows = grouped?.[tier];
                if (!rows?.length) return null;
                return (
                  <div key={tier}>
                    <div className="label small">{TIER_LABEL[tier]} ({rows.length})</div>
                    <ul className="regime-checklist">
                      {rows.map((r) => <Row key={r.ticker} r={r} chart />)}
                    </ul>
                  </div>
                );
              })}
            </>
          )}
        </div>
      </details>
    </li>
  );
}

/**
 * Past finalized days from watchlist-scans/, newest first — collapsed to just a date list;
 * opening a day is what fetches it (HistoryDay), so browsing years of history never costs more
 * than the one day, and the one row, you actually open.
 */
export function WatchlistScanHistory({ dates }: { dates: string[] }) {
  if (!dates.length) return null;
  return (
    <details className="panel" aria-label="Watchlist scan history">
      <summary className="panel-head">
        <h2>HISTORY ({dates.length} day{dates.length === 1 ? "" : "s"}) ▸</h2>
      </summary>
      <ul className="panel-pad regime-checklist">
        {dates.map((d) => <HistoryDay key={d} date={d} />)}
      </ul>
    </details>
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
