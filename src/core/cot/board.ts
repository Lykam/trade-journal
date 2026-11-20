// COT board (SPEC §5.8): Jason Shapiro's Crowded Market Report view across the
// futures markets: each trader group's net position, its rank in its own
// history, a one-line heads-up per market, and the weekly series a chart needs
// (price, net contracts, rank). Pure, like cot.ts: build/fetch-cot.ts fetches,
// this computes, and the COT page re-ranks in the browser for its lookback.
// Runtime imports only from ./cot.ts, with the extension: build/fetch-cot.ts loads this natively.
import {
  BUY_ZONE,
  EDGE,
  extremeOf,
  LOOKBACK_WEEKS,
  netPct,
  NEUTRAL,
  oscillator,
  rank,
  releaseDate,
  SELL_ZONE,
  STALE_DAYS,
  walkSignal,
  zoneOf,
  type CotMarketSnapshot,
  type CotReport,
  type CotSignal,
  type CotZone,
  type DailyBar,
} from "./cot.ts";

const DAY_MS = 86_400_000;
const dayNum = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
const daysBetween = (a: string, b: string) => Math.round((dayNum(b) - dayNum(a)) / DAY_MS);
const etDate = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(iso));
/** Monday of the week holding `date` ("YYYY-MM-DD"), in UTC calendar terms. */
export const mondayOf = (date: string): string => {
  const t = dayNum(date);
  const dow = new Date(t).getUTCDay(); // 0 = Sunday
  return new Date(t - ((dow + 6) % 7) * DAY_MS).toISOString().slice(0, 10);
};
/** Six significant digits: enough for any futures price, and a smaller bundle. */
const sig = (n: number) => Number(n.toPrecision(6));

export const BOARD_SECTORS = ["Currencies", "Energies", "Metals", "Softs", "Grains", "Livestock", "Rates", "Indices", "Crypto"] as const;
export type BoardSector = (typeof BOARD_SECTORS)[number];

export interface BoardMarket {
  /** The futures root, e.g. "SI". */
  id: string;
  name: string;
  sector: BoardSector;
  /** CFTC contract market code (legacy report); stable across the contract's renames. */
  code: string;
  /** Yahoo symbol for the front-month future's bars. */
  yahoo: string;
  /** TradingView continuous symbol, for the "open in TradingView" link. */
  tv: string;
}

const mk = (id: string, name: string, sector: BoardSector, code: string, tv: string, yahoo = `${id}=F`): BoardMarket => ({ id, name, sector, code, yahoo, tv });

/**
 * The markets on the board: the futures in Shapiro's Crowded Market Report watchlist,
 * plus rates and livestock. Codes and symbols checked against the CFTC API and Yahoo on 2026-11-19.
 */
export const BOARD_MARKETS: readonly BoardMarket[] = [
  mk("6A", "Australian dollar", "Currencies", "232741", "CME:6A1!"),
  mk("6N", "New Zealand dollar", "Currencies", "112741", "CME:6N1!"),
  mk("6C", "Canadian dollar", "Currencies", "090741", "CME:6C1!"),
  mk("6E", "Euro", "Currencies", "099741", "CME:6E1!"),
  mk("6B", "British pound", "Currencies", "096742", "CME:6B1!"),
  mk("6S", "Swiss franc", "Currencies", "092741", "CME:6S1!"),
  mk("6J", "Japanese yen", "Currencies", "097741", "CME:6J1!"),
  mk("6M", "Mexican peso", "Currencies", "095741", "CME:6M1!"),
  mk("DX", "US dollar index", "Currencies", "098662", "ICEUS:DX1!", "DX-Y.NYB"),
  mk("CL", "Crude oil (WTI)", "Energies", "067651", "NYMEX:CL1!"),
  mk("HO", "Heating oil (ULSD)", "Energies", "022651", "NYMEX:HO1!"),
  mk("RB", "Gasoline (RBOB)", "Energies", "111659", "NYMEX:RB1!"),
  mk("NG", "Natural gas", "Energies", "023651", "NYMEX:NG1!"),
  mk("GC", "Gold", "Metals", "088691", "COMEX:GC1!"),
  mk("SI", "Silver", "Metals", "084691", "COMEX:SI1!"),
  mk("HG", "Copper", "Metals", "085692", "COMEX:HG1!"),
  mk("PL", "Platinum", "Metals", "076651", "NYMEX:PL1!"),
  mk("PA", "Palladium", "Metals", "075651", "NYMEX:PA1!"),
  mk("SB", "Sugar", "Softs", "080732", "ICEUS:SB1!"),
  mk("KC", "Coffee", "Softs", "083731", "ICEUS:KC1!"),
  mk("CC", "Cocoa", "Softs", "073732", "ICEUS:CC1!"),
  mk("CT", "Cotton", "Softs", "033661", "ICEUS:CT1!"),
  mk("OJ", "Orange juice", "Softs", "040701", "ICEUS:OJ1!"),
  mk("LBR", "Lumber", "Softs", "058644", "CME:LBR1!"),
  mk("ZC", "Corn", "Grains", "002602", "CBOT:ZC1!"),
  mk("ZS", "Soybeans", "Grains", "005602", "CBOT:ZS1!"),
  mk("ZM", "Soybean meal", "Grains", "026603", "CBOT:ZM1!"),
  mk("ZL", "Soybean oil", "Grains", "007601", "CBOT:ZL1!"),
  mk("ZW", "Wheat (Chicago)", "Grains", "001602", "CBOT:ZW1!"),
  mk("KE", "Wheat (KC)", "Grains", "001612", "KCBT:KE1!"),
  mk("ZO", "Oats", "Grains", "004603", "CBOT:ZO1!"),
  mk("LE", "Live cattle", "Livestock", "057642", "CME:LE1!"),
  mk("GF", "Feeder cattle", "Livestock", "061641", "CME:GF1!"),
  mk("HE", "Lean hogs", "Livestock", "054642", "CME:HE1!"),
  mk("ZB", "30-year bond", "Rates", "020601", "CBOT:ZB1!"),
  mk("ZN", "10-year note", "Rates", "043602", "CBOT:ZN1!"),
  mk("ZF", "5-year note", "Rates", "044601", "CBOT:ZF1!"),
  mk("ZT", "2-year note", "Rates", "042601", "CBOT:ZT1!"),
  mk("ES", "S&P 500", "Indices", "13874A", "CME_MINI:ES1!"),
  mk("NQ", "Nasdaq-100", "Indices", "209742", "CME_MINI:NQ1!"),
  mk("YM", "Dow", "Indices", "124603", "CBOT_MINI:YM1!"),
  mk("RTY", "Russell 2000", "Indices", "239742", "CME_MINI:RTY1!"),
  mk("BTC", "Bitcoin", "Crypto", "133741", "CME:BTC1!"),
  mk("ETH", "Ether", "Crypto", "146021", "CME:ETH1!"),
];

export const boardMarket = (id: string): BoardMarket | undefined => BOARD_MARKETS.find((m) => m.id === id);

/**
 * Stocks and ETFs to act on a market without trading futures. `long` gains when the market
 * rises (for a crowded short: look to buy); `short` gains when it falls (inverse ETFs, for a
 * crowded long). Empty when nothing listed tracks it; `note` says why or what's loose.
 * Every symbol was checked on Yahoo 2026-11-19.
 */
export interface TradeIdeas {
  long: string[];
  short: string[];
  note?: string;
}

const NO_INVERSE_FX = "No inverse ETF for this currency; UUP (dollar up) is the usual stand-in.";
const SOFTS_NONE = "No listed ETF tracks it any more; stay with the futures view or skip.";
const LIVESTOCK = "No cattle or hog ETF. Meat packers (TSN, HRL) buy livestock, so they tend to do better when it's cheap: a loose, inverse link.";

export const TRADE_IDEAS: Readonly<Record<string, TradeIdeas>> = {
  "6A": { long: ["FXA"], short: ["UUP"], note: NO_INVERSE_FX },
  "6N": { long: ["ENZL"], short: ["UUP"], note: "No New Zealand dollar ETF; ENZL is New Zealand stocks. UUP (dollar up) for the other side." },
  "6C": { long: ["FXC", "EWC"], short: ["UUP"], note: NO_INVERSE_FX },
  "6E": { long: ["FXE"], short: ["EUO", "UUP"] },
  "6B": { long: ["FXB", "EWU"], short: ["UUP"], note: NO_INVERSE_FX },
  "6S": { long: ["FXF"], short: ["UUP"], note: NO_INVERSE_FX },
  "6J": { long: ["FXY"], short: ["YCS"] },
  "6M": { long: ["EWW"], short: ["UUP"], note: "No peso ETF; EWW (Mexico stocks) moves with the peso." },
  DX: { long: ["UUP"], short: ["UDN"] },
  CL: { long: ["USO", "XLE", "XOP", "OXY", "XOM"], short: ["SCO", "DRIP"] },
  HO: { long: ["CRAK", "VLO", "MPC", "PSX"], short: [], note: "No heating oil ETF. Refiners earn on the crack spread, so it's a loose link." },
  RB: { long: ["UGA", "VLO", "MPC"], short: [], note: "Refiners earn on the crack spread: a loose link." },
  NG: { long: ["UNG", "BOIL", "EQT", "AR", "RRC"], short: ["KOLD"] },
  GC: { long: ["GLD", "IAU", "GDX", "NEM"], short: ["GLL", "DUST"] },
  SI: { long: ["SLV", "SIL", "PAAS", "AG"], short: ["ZSL"] },
  HG: { long: ["CPER", "COPX", "FCX", "SCCO"], short: [] },
  PL: { long: ["PPLT", "SBSW"], short: [] },
  PA: { long: ["PALL", "SBSW"], short: [] },
  SB: { long: ["CANE"], short: [] },
  KC: { long: [], short: [], note: `${SOFTS_NONE} Starbucks (SBUX) buys coffee: a loose, inverse link.` },
  CC: { long: [], short: [], note: `${SOFTS_NONE} Hershey (HSY) buys cocoa: a loose, inverse link.` },
  CT: { long: [], short: [], note: SOFTS_NONE },
  OJ: { long: [], short: [], note: SOFTS_NONE },
  LBR: { long: ["WOOD", "WY", "LPX", "UFPI"], short: [] },
  ZC: { long: ["CORN", "DBA", "ADM"], short: [] },
  ZS: { long: ["SOYB", "DBA", "ADM", "BG"], short: [] },
  ZM: { long: ["SOYB", "BG"], short: [], note: "No meal ETF; SOYB and the crushers (BG) are the nearest." },
  ZL: { long: ["SOYB", "DAR", "BG"], short: [], note: "No soybean oil ETF; DAR (renewable diesel feedstock) and the crushers are the nearest." },
  ZW: { long: ["WEAT", "DBA"], short: [] },
  KE: { long: ["WEAT", "DBA"], short: [] },
  ZO: { long: ["DBA"], short: [], note: "No oats ETF; DBA is a broad farm basket." },
  LE: { long: [], short: [], note: LIVESTOCK },
  GF: { long: [], short: [], note: LIVESTOCK },
  HE: { long: [], short: [], note: LIVESTOCK },
  ZB: { long: ["TLT", "TMF"], short: ["TBT", "TMV"] },
  ZN: { long: ["IEF"], short: ["PST"] },
  ZF: { long: ["IEI"], short: [] },
  ZT: { long: ["SHY"], short: [] },
  ES: { long: ["SPY", "SPXL"], short: ["SH", "SPXU"] },
  NQ: { long: ["QQQ", "TQQQ"], short: ["PSQ", "SQQQ"] },
  YM: { long: ["DIA", "UDOW"], short: ["DOG", "SDOW"] },
  RTY: { long: ["IWM", "TNA"], short: ["RWM", "TZA"] },
  BTC: { long: ["IBIT", "MSTR", "COIN"], short: ["BITI", "SBIT"] },
  ETH: { long: ["ETHA"], short: ["ETHD"] },
};

/** What a symbol is, shown next to it: leverage, what it tracks, and thin volume (under ~100k shares a day). */
export const TICKER_NOTES: Readonly<Record<string, string>> = {
  FXA: "AUD, thin", ENZL: "NZ stocks, thin", FXC: "CAD, thin", EWC: "Canada stocks", FXE: "EUR", EUO: "2x short EUR, thin",
  FXB: "GBP, thin", EWU: "UK stocks", FXF: "CHF, thin", FXY: "JPY", YCS: "2x short JPY, thin", EWW: "Mexico stocks",
  UUP: "dollar up", UDN: "dollar down, thin",
  USO: "crude", XLE: "energy stocks", XOP: "oil & gas E&P", SCO: "2x short crude", DRIP: "2x short E&P",
  CRAK: "refiners", UGA: "gasoline, thin", UNG: "nat gas", BOIL: "2x nat gas", KOLD: "2x short nat gas",
  GLD: "gold", IAU: "gold", GDX: "gold miners", GLL: "2x short gold", DUST: "2x short gold miners",
  SLV: "silver", SIL: "silver miners", ZSL: "2x short silver", CPER: "copper", COPX: "copper miners",
  PPLT: "platinum", PALL: "palladium", SBSW: "PGM miner", CANE: "sugar", WOOD: "timber, thin",
  CORN: "corn", SOYB: "soybeans, thin", WEAT: "wheat", DBA: "farm basket",
  TLT: "20+Y treasuries", TMF: "3x 20+Y", TBT: "2x short 20+Y", TMV: "3x short 20+Y", IEF: "7–10Y", PST: "2x short 7–10Y, thin",
  IEI: "3–7Y", SHY: "1–3Y",
  SPXL: "3x", SH: "short", SPXU: "3x short", TQQQ: "3x", PSQ: "short", SQQQ: "3x short", UDOW: "3x", DOG: "short",
  SDOW: "3x short", TNA: "3x", RWM: "short", TZA: "3x short",
  IBIT: "bitcoin", BITI: "short bitcoin", SBIT: "2x short bitcoin", ETHA: "ether", ETHD: "2x short ether",
};

export const tradeIdeas = (id: string): TradeIdeas => TRADE_IDEAS[id] ?? { long: [], short: [] };

/** Weekly rows kept per market: three years to chart plus a three-year lookback before the first one. */
export const BOARD_WEEKS = 2 * LOOKBACK_WEEKS;

/** One week of a market: the report in it (if any) and the future's weekly bar (if any). */
export interface BoardWeek {
  /** Monday of the week, "YYYY-MM-DD". */
  w: string;
  /** The report's Tuesday; null for a week without a report (usually the current one). */
  d: string | null;
  oi: number | null;
  /** Net contracts (long − short): large specs (non-commercial), commercials, small traders (non-reportable). */
  spec: number | null;
  comm: number | null;
  small: number | null;
  /** The front-month future's weekly close; null when Yahoo had no bar. */
  c: number | null;
}

/**
 * A BoardWeek as stored in cot.json, a tuple to keep the bundle small (keys would be a quarter of it):
 * [w, report day offset from w (1 = Tuesday) or null, oi, spec, comm, small, c].
 */
export type BoardRow = [string, number | null, number | null, number | null, number | null, number | null, number | null];

const addDays = (d: string, n: number) => new Date(dayNum(d) + n * DAY_MS).toISOString().slice(0, 10);

export const encodeWeek = (x: BoardWeek): BoardRow => [x.w, x.d === null ? null : daysBetween(x.w, x.d), x.oi, x.spec, x.comm, x.small, x.c];

export const decodeRow = ([w, off, oi, spec, comm, small, c]: BoardRow): BoardWeek => ({
  w, d: off === null ? null : addDays(w, off), oi, spec, comm, small, c,
});

export interface BoardMarketData {
  id: string;
  /** Latest report Tuesday; null if none was fetched. */
  report: string | null;
  /** The latest report was released more than STALE_DAYS ago, or this entry was carried over from a failed fetch. */
  stale: boolean;
  /** Weeks oldest first, at most BOARD_WEEKS with a report plus any after; decode with {@link decodeRow}. */
  rows: BoardRow[];
  /** Large specs' latest net % of OI against all the history fetched; null without a full lookback. */
  extreme: CotMarketSnapshot["extreme"] | null;
  /** The reversal-confirmed signal on the system settings (3-year % of OI rank, SPEC §5.7); null without bars. */
  signal: CotSignal | null;
  /** The symbol the signal was walked on: the future, or the index ETF the dashboard gauge uses. */
  signalOn: string | null;
}

export interface CotBoard {
  asOf: string;
  /** The last fetch failed; this board was carried over. */
  stale?: true;
  markets: BoardMarketData[];
}

/** Merge reports and weekly bars by week (oldest first), from the first report on, keeping the last `n` weeks with a report plus any after. */
export function buildWeeks(reports: CotReport[], weekly: DailyBar[], n = BOARD_WEEKS): BoardWeek[] {
  const rows = new Map<string, BoardWeek>();
  const row = (w: string) => {
    let r = rows.get(w);
    if (!r) rows.set(w, (r = { w, d: null, oi: null, spec: null, comm: null, small: null, c: null }));
    return r;
  };
  for (const r of reports) {
    const x = row(mondayOf(r.date));
    x.d = r.date;
    x.oi = r.openInterest;
    x.spec = r.largeSpec[0] - r.largeSpec[1];
    x.comm = r.commercial[0] - r.commercial[1];
    x.small = r.small[0] - r.small[1];
  }
  const firstReport = reports.length ? mondayOf(reports.reduce((a, r) => (r.date < a ? r.date : a), reports[0]!.date)) : null;
  for (const b of weekly) {
    const w = mondayOf(b.date);
    if (firstReport && w < firstReport) continue;
    row(w).c = sig(b.close);
  }
  const all = [...rows.values()].sort((a, b) => a.w.localeCompare(b.w));
  let kept = 0;
  let start = all.length;
  while (start > 0 && kept < n) if (all[--start]!.d) kept++;
  return all.slice(start);
}

export function computeBoardMarket(market: BoardMarket, reports: CotReport[], weekly: DailyBar[], daily: DailyBar[], now: string): BoardMarketData {
  const sorted = [...reports].sort((a, b) => a.date.localeCompare(b.date));
  const spec = sorted.map((r) => netPct(r.largeSpec, r.openInterest));
  const osc = sorted.length ? rank(spec, sorted.length - 1) : null;
  const report = sorted.at(-1)?.date ?? null;
  const bars = [...daily].sort((a, b) => a.date.localeCompare(b.date));
  return {
    id: market.id,
    report,
    stale: report === null || daysBetween(releaseDate(report), etDate(now)) > STALE_DAYS,
    rows: buildWeeks(sorted, weekly).map(encodeWeek),
    extreme: osc === null ? null : extremeOf(spec, sorted.map((r) => r.date), osc),
    signal: osc === null || !bars.length ? null : walkSignal(oscillator(sorted), bars),
    signalOn: osc === null || !bars.length ? null : market.yahoo,
  };
}

/**
 * The board at `now`, keyed by CFTC code (reports) and Yahoo symbol (bars). A market with no
 * reports this time keeps its entry from `prev`, marked stale; one never fetched is left out.
 */
export function computeBoard(
  reports: Record<string, CotReport[]>,
  weekly: Record<string, DailyBar[]>,
  daily: Record<string, DailyBar[]>,
  now: string,
  prev?: CotBoard | null,
): CotBoard {
  const markets: BoardMarketData[] = [];
  for (const m of BOARD_MARKETS) {
    const r = reports[m.code];
    if (r?.length) markets.push(computeBoardMarket(m, r, weekly[m.yahoo] ?? [], daily[m.yahoo] ?? [], now));
    else {
      const old = prev?.markets.find((p) => p.id === m.id);
      if (old) markets.push({ ...old, stale: true });
    }
  }
  return { asOf: now, markets };
}

// ---------------------------------------------------------------- in the browser

export type BoardGroup = "spec" | "comm" | "small";
/** Rank the net as % of open interest (the system, comparable across years) or in raw contracts (as COT charts plot it). */
export type RankBasis = "pct" | "contracts";

/**
 * Each week's rank (0–100) of a group's net within the trailing `lookback` reports. Weeks
 * without a report carry the previous report's rank, so step lines run to the current week;
 * null before a full lookback.
 */
export function rankSeries(weeks: BoardWeek[], group: BoardGroup, lookback: number, basis: RankBasis): (number | null)[] {
  const values: number[] = [];
  const out: (number | null)[] = [];
  let last: number | null = null;
  for (const w of weeks) {
    const net = w[group];
    if (w.d !== null && net !== null) {
      values.push(basis === "pct" ? (w.oi ? (100 * net) / w.oi : 0) : net);
      last = rank(values, values.length - 1, lookback);
    }
    out.push(last);
  }
  return out;
}

export interface HeadsUp {
  text: string;
  /** buy/sell: a zone or signal for that side; warn: near a zone or worth a look; info: context. */
  tone: "buy" | "sell" | "warn" | "info";
}

export interface GroupNow {
  /** Net contracts at the latest report, and the change from the report before. */
  net: number | null;
  chg: number | null;
  /** % of open interest. */
  pct: number | null;
  rank: number | null;
}

export interface BoardSummary {
  market: BoardMarket;
  data: BoardMarketData;
  /** data.rows decoded, for the chart. */
  weeks: BoardWeek[];
  /** Latest weekly close and its % change from the week before. */
  price: number | null;
  priceChg: number | null;
  spec: GroupNow;
  comm: GroupNow;
  small: GroupNow;
  /** Large-spec rank 4 reports earlier. */
  spec4w: number | null;
  zone: CotZone | null;
  /** The side to act on, if any: a live SYSTEM signal's side, else the zone's (buy → long, sell → short). */
  side: "long" | "short" | null;
  heads: HeadsUp[];
  /** Higher = more worth a look: a live signal, then a zone, then near one; ties by distance from 50. */
  priority: number;
}

/** How close to a zone counts as "near". */
export const NEAR = 10;
/** A 4-week rank move this big is flagged. */
export const FAST_SHIFT = 50;

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const monthYear = (d: string) => `${MONTHS[+d.slice(5, 7) - 1]} ${d.slice(0, 4)}`;
const yearsBetween = (a: string, b: string) => daysBetween(a, b) / 365.25;
const fmtPrice = (n: number) => (Math.abs(n) >= 1000 ? n.toFixed(0) : Math.abs(n) >= 10 ? n.toFixed(2) : n.toPrecision(4));

/** The latest state of one market at a lookback and basis, with its heads-up lines. */
export function summarize(market: BoardMarket, data: BoardMarketData, lookback: number, basis: RankBasis): BoardSummary {
  const weeks = data.rows.map(decodeRow);
  const reported = weeks.filter((w) => w.d !== null);
  const latest = reported.at(-1);
  const prior = reported.at(-2);
  const ranks = { spec: rankSeries(weeks, "spec", lookback, basis), comm: rankSeries(weeks, "comm", lookback, basis), small: rankSeries(weeks, "small", lookback, basis) };
  const lastIdx = latest ? weeks.lastIndexOf(latest) : -1;
  const group = (g: BoardGroup): GroupNow => {
    const net = latest?.[g] ?? null;
    const before = prior?.[g] ?? null;
    return {
      net,
      chg: net !== null && before !== null ? net - before : null,
      pct: net !== null && latest?.oi ? (100 * net) / latest.oi : null,
      rank: lastIdx >= 0 ? ranks[g][lastIdx]! : null,
    };
  };
  const spec = group("spec");
  const comm = group("comm");
  const small = group("small");
  const idx4 = reported.length > 4 ? weeks.lastIndexOf(reported.at(-5)!) : -1;
  const spec4w = idx4 >= 0 ? ranks.spec[idx4]! : null;

  const closes = weeks.filter((w) => w.c !== null);
  const price = closes.at(-1)?.c ?? null;
  const prevClose = closes.at(-2)?.c ?? null;
  const priceChg = price !== null && prevClose ? (100 * (price - prevClose)) / prevClose : null;

  const r = spec.rank;
  const zone = r === null ? null : zoneOf(r);
  const heads: HeadsUp[] = [];
  let priority = 0;

  const s = data.signal;
  if (s?.state === "confirmed") {
    const long = s.side === "long";
    heads.push({ text: `${long ? "▲ IN LONG" : "▼ IN SHORT"} SINCE ${s.since!.slice(5)} · STOP ${fmtPrice(s.stop!)}${data.signalOn && data.signalOn !== market.yahoo ? ` (${data.signalOn})` : ""}`, tone: long ? "buy" : "sell" });
    priority = 5;
  } else if (s?.state === "armed") {
    const long = s.side === "long";
    const trig = s.trigger == null ? "" : ` · TRIGGER ${long ? "<" : ">"} ${fmtPrice(s.trigger)}${data.signalOn && data.signalOn !== market.yahoo ? ` (${data.signalOn})` : ""}`;
    heads.push({ text: `ARMED ${long ? "LONG" : "SHORT"}${trig}`, tone: "warn" });
    priority = 4;
  }

  if (r !== null) {
    if (r <= BUY_ZONE) {
      heads.push({ text: "CROWDED SHORT · BUY ON A REVERSAL", tone: "buy" });
      priority = Math.max(priority, 3);
    } else if (r >= SELL_ZONE) {
      heads.push({ text: "CROWDED LONG · SELL ON A REVERSAL", tone: "sell" });
      priority = Math.max(priority, 3);
    } else if (r <= BUY_ZONE + NEAR) {
      heads.push({ text: `NEAR BUY ZONE (${(r - BUY_ZONE).toFixed(0)} AWAY)`, tone: "warn" });
      priority = Math.max(priority, 2);
    } else if (r >= SELL_ZONE - NEAR) {
      heads.push({ text: `NEAR SELL ZONE (${(SELL_ZONE - r).toFixed(0)} AWAY)`, tone: "warn" });
      priority = Math.max(priority, 2);
    }
  }

  const e = data.extreme;
  if (e && zone && zone !== "neutral" && data.report) {
    const dir = e.side === "short" ? "SHORT" : "LONG";
    if (e.since === null) heads.push({ text: `MOST ${dir} ON RECORD`, tone: "warn" });
    else if (yearsBetween(e.since, data.report) >= 1) heads.push({ text: `MOST ${dir} SINCE ${monthYear(e.since)}`, tone: "info" });
  }

  const hi = (x: number | null) => x !== null && x >= 100 - EDGE;
  const lo = (x: number | null) => x !== null && x <= EDGE;
  if (hi(small.rank) && lo(r)) heads.push({ text: "SMALL TRADERS LONG VS SPECS", tone: "info" });
  else if (lo(small.rank) && hi(r)) heads.push({ text: "SMALL TRADERS SHORT VS SPECS", tone: "info" });

  if (r !== null && spec4w !== null && Math.abs(r - spec4w) >= FAST_SHIFT)
    heads.push({ text: `FAST MOVE ${spec4w.toFixed(0)} → ${r.toFixed(0)} IN 4W`, tone: "info" });

  if (data.stale) heads.push({ text: "STALE DATA", tone: "warn" });

  const dist = r === null ? 0 : Math.abs(r - NEUTRAL) / 100;
  const live = s && (s.state === "confirmed" || s.state === "armed") ? s.side : null;
  const side = live ?? (zone === "buy" ? "long" : zone === "sell" ? "short" : null);
  return { market, data, weeks, price, priceChg, spec, comm, small, spec4w, zone, side, heads, priority: priority + dist };
}
