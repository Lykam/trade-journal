// Shared data types for the trade-history contract (docs/SPEC.md §3).

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
  gauge: {
    baselineDays: number;
    excludeCurrentWeekFromBaseline: boolean;
    minSample: { day: number; swing: number };
    bands: { halfSizeBelowPts: number; quarterSizeBelowPts: number };
    swingIncludesOpenPositions: boolean;
  };
}

export interface TradeOverride {
  style?: Style;
  exclude?: boolean;
  tags?: string[];
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
