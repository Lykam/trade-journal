// Shared data types for the trade-history contract (docs/SPEC.md §3).
import type { RegimeSnapshot } from "./regime/regime.ts";

export type Broker = "schwab" | "webull";
export type Side = "buy" | "sell";
export type Style = "day" | "swing";

export interface Fill {
  id: string;
  broker: Broker;
  account: string;
  symbol: string;
  assetType: "equity";
  side: Side;
  qty: number;
  price: number;
  fees: number;
  executedAt: string; // ISO 8601 with ET offset
  timePrecision: "second" | "day";
  seq: number;
  source: string;
  importedAt: string;
}

export interface FillsFile {
  schemaVersion: 1;
  fills: Fill[];
}

export interface Config {
  timezone: string;
  weekStartsOn: "monday" | "sunday";
  accounts: string[];
  /** Schwab account id from the export file name (Trading_XXX<id>_Transactions_…) → account label. */
  schwabAccounts: Record<string, string>;
  webullAccount: string;
  styleByAccount: Record<string, Style>;
  /** Setup/Entry pill values shown before any trade uses them, keyed by style; values used on trades are added automatically. */
  setupPresets?: Record<Style, string[]>;
  entryPresets?: Record<Style, string[]>;
  gauge: {
    /** Days of closed trades in the gauge average; null = all time (Q74). */
    baselineDays: number | null;
    excludeCurrentWeekFromBaseline: boolean;
    minSample: { day: number; swing: number };
    bands: { halfSizeBelowPts: number; quarterSizeBelowPts: number };
    swingIncludesOpenPositions: boolean;
  };
  /** Account label → its starting balance and the actual values entered since (Q68). */
  balances?: Record<string, AccountBalance>;
}

/** An account's money, for its value and each holding's share of it (Q68). */
export interface AccountBalance {
  /** Cash in the account on `date` (ET), before that day's trades. Trades opened earlier are left out. */
  start: { date: string; amount: number };
  /** Actual account values entered from the broker; the latest one corrects any drift. */
  checkpoints?: AccountCheckpoint[];
}

export interface AccountCheckpoint {
  /** ET date whose close the value is for. */
  date: string;
  /** Total account value (cash + positions) the broker showed. */
  value: number;
  /** Price of each symbol held at that close, as entered (a symbol left out counts at cost). */
  marks: Record<string, number>;
}

export interface TradeOverride {
  style?: Style;
  exclude?: boolean;
  tags?: string[];
  /** Daily setup: one per trade, picked from values used on past trades of the same style. */
  setup?: string;
  /** Intraday entry trigger: one per trade, same style-scoped value list as setup. */
  entry?: string;
  note?: string;
  ideaId?: string;
}

export interface OpeningPosition {
  account: string;
  symbol: string;
  qty: number;
  avgPrice: number;
  openedAt: string; // YYYY-MM-DD
}

export interface Overrides {
  trades: Record<string, TradeOverride>;
  openingPositions: OpeningPosition[];
}

export interface SymbolInfo {
  underlying: string;
  type: "leveraged_etf";
  leverage: number;
  direction: "long" | "inverse";
  issuer?: string;
}

export type SymbolsMap = Record<string, SymbolInfo>;

export interface TradeEvent {
  kind: "open" | "add" | "trim" | "close";
  at: string;
  qty: number;
  price: number;
  realized?: number;
  /** open and add only: the buy's fees, when non-zero (they count in realizedPnl). */
  fees?: number;
}

export type TradeStatus = "open" | "closed" | "unmatched";
export type TradeResult = "win" | "loss" | "breakeven";

export interface Trade {
  id: string;
  ideaId: string;
  account: string;
  broker: Broker;
  symbol: string;
  underlying: string;
  instrument: "stock" | "leveraged_etf";
  leverage: number;
  direction: "long" | "inverse";
  style: Style;
  sameDay: boolean;
  openedAt: string;
  closedAt: string | null;
  status: TradeStatus;
  maxPosition: number;
  openQty: number;
  /** Shares sold beyond the position (only when status = "unmatched"). */
  unmatchedQty: number;
  avgEntry: number;
  avgExit: number | null;
  grossPnl: number;
  fees: number;
  netPnl: number;
  result: TradeResult | null;
  holdMinutes: number | null;
  fillIds: string[];
  avgCost: number;
  realizedPnl: number;
  events: TradeEvent[];
  tags: string[];
  setup?: string;
  entry?: string;
  note?: string;
  excluded: boolean;
}

export interface Idea {
  id: string;
  underlying: string;
  accounts: string[];
  symbolsTraded: string[];
  usedEtf: boolean;
  style: Style;
  date: string;
  tradeIds: string[];
  netPnl: number;
  status: "open" | "closed";
}

export interface DerivedTrades {
  generated: true;
  generator: string;
  trades: Trade[];
  ideas: Idea[];
}

/** One price for a held symbol (SPEC §5.4). */
export interface Quote {
  price: number;
  /** When the price was set (Yahoo regularMarketTime), ISO 8601. */
  time: string;
  marketState?: string;
  /** The last fetch for this symbol failed and this is a carried-over price. */
  stale?: true;
}

/** quotes.json: written by build/fetch-quotes.ts, never committed. */
export interface QuotesFile {
  /** Time of the last successful fetch. */
  asOf: string;
  /** Time of the last attempt, successful or not. */
  attemptedAt?: string;
  quotes: Record<string, Quote>;
}

/** regime.json: written by build/fetch-regime.ts (SPEC §5.6), never committed. */
export interface RegimeFile {
  /** Time of the last successful computation. */
  asOf: string;
  /** Time of the last attempt, successful or not. */
  attemptedAt?: string;
  /** The last fetch failed; this snapshot was carried over from a previous run. */
  stale?: true;
  snapshot: RegimeSnapshot;
}

/** How strongly a row's entry tactic is currently confirmed (watchlist-scan skill). */
export type WatchlistScanTier = "high" | "watching" | "suppressed" | "not_graded";

/** One ticker's grade from the watchlist-scan skill (undercut & reclaim, oops reversal, ugly-close + gap-up, or regime-gated CANSLIM breakout). */
export interface WatchlistScanRow {
  ticker: string;
  /** Exchange-qualified TradingView symbol (e.g. "NYSE:SPOT") for the chart widget — a bare
      ticker can be ambiguous (multiple listings/instruments share it) and the widget then falls
      back to a consolidated tape feed that doesn't render daily history properly. Falls back to
      `ticker` when absent (suppressed/not_graded rows don't get a chart, so don't need this). */
  tvSymbol?: string;
  /** The watchlist's own section tag the ticker was under (e.g. "LONG", "TRACKING"). */
  section: string;
  tactic: string;
  /** Free-text confidence as graded (e.g. "HIGH", "WATCHING (weak)") — tier below is what the UI groups/colors by. */
  confidence: string;
  tier: WatchlistScanTier;
  keyLevel: string;
  stop: string;
  relStrength: string;
  earnings: string;
  rationale: string;
}

/** The index-level read (EMA posture, rotation tell) that gates which tactics are favored (watchlist-scan skill). Distinct from the quantitative RegimeSnapshot above — not to be confused with it in the UI. */
export interface WatchlistScanTapeRead {
  state: string;
  evidence: string;
  rotationTell: string;
  favoredTactics: string;
  suppressedTactics: string;
  excludedTactic: string;
  sourceWatchlist: string;
}

/**
 * watchlist-scan.json: written by the Claude "watchlist-scan" skill and committed into the
 * trade-history checkout (unlike quotes/regime, it can't be regenerated at build time — it
 * depends on a live TradingView MCP session, not a public API CI can call). Read directly by
 * build/load-bundle.ts, no schema validation.
 */
export interface WatchlistScanFile {
  /** When the skill ran this scan. */
  asOf: string;
  tapeRead: WatchlistScanTapeRead;
  rows: WatchlistScanRow[];
}

/**
 * <date>-pm-thesis.json: the evening-thesis cloud routine's forward-looking read for the next
 * trading day, written the night before. Same shape as WatchlistScanFile plus `thesisFor`. Shown
 * as an unconfirmed preview only until the morning routine finalizes that day (see
 * build/load-bundle.ts's readWatchlistScanThesis) — never a substitute for `watchlistScan`.
 */
export interface WatchlistScanThesisFile extends WatchlistScanFile {
  /** The trading day (YYYY-MM-DD, America/New_York) this thesis is forecasting. */
  thesisFor: string;
}

/** One Playbook review as read from disk (SPEC §6.7, §6.11). */
export interface ReviewFile {
  /** Path relative to the Playbook root, e.g. "Reviews/2026-07-27-ABC.md". */
  path: string;
  markdown: string;
}

/** Playbook content the app reads: review markdown plus the list of chart images. */
export interface PlaybookData {
  reviews: ReviewFile[];
  /** Image paths relative to the Playbook root, e.g. "Images/2026-07-27/ABC-daily.png". */
  images: string[];
}

/** Everything the app reads: served by the dev plugin in dev, decrypted from data.enc in production. */
export interface DataBundle {
  config: Config;
  symbols: SymbolsMap;
  derived: DerivedTrades;
  /** Broker fills (without source file names), for Trade detail executions and override previews. */
  fills: Fill[];
  overrides: Overrides;
  quotes: QuotesFile | null;
  regime: RegimeFile | null;
  /** null until the watchlist-scan skill has been run at least once and committed to trade-history. */
  watchlistScan: WatchlistScanFile | null;
  /** The evening-thesis routine's draft for the next trading day, while it's still unconfirmed —
      null once the morning routine finalizes that day (its archive file exists) or no thesis has
      been written yet. */
  watchlistScanThesis: WatchlistScanThesisFile | null;
  /** Dated archives available in watchlist-scans/ (YYYY-MM-DD), newest first — the Setups history
      picker fetches one on demand (build/load-bundle.ts dev, img/-style encrypted blobs in prod),
      never bundled eagerly. Empty when no archives exist yet. */
  watchlistScanHistory: string[];
  /** Production only: watchlist-scan history date → its encrypted file name in scans/ (an HMAC, like imageFiles). Absent in dev. */
  watchlistScanHistoryFiles?: Record<string, string>;
  /** null when no Playbook checkout is available. */
  playbook: PlaybookData | null;
  /** Production only: Playbook image path → its encrypted file name in img/ (an HMAC, Q34). Absent in dev. */
  imageFiles?: Record<string, string>;
  loadedAt: string;
  /** The trade-history commit the bundle was built from (absent when the checkout isn't a git repo). */
  history?: { sha: string; date: string } | null;
  /** Latest `importedAt` per broker (fills themselves carry none in the bundle), for the top bar's import dates. */
  imports?: Partial<Record<Broker, string>>;
}
