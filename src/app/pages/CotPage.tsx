// COT page (SPEC §6.7d, Q83): a Crowded-Market-Report style board of the futures
// markets, after Jason Shapiro: the selected market's net contracts chart and
// stocks/ETFs to trade it with, then every market's positioning and heads-up
// (filter to HEADS UP, sort MOST CROWDED). Public CFTC and Yahoo data from cot.json's
// board (SPEC §5.8); ranks are recomputed here for the chosen lookback.
import { useMemo, useRef } from "react";
import { BOARD_SECTORS, boardMarket, NEAR, summarize, TICKER_NOTES, tradeIdeas, type BoardSummary, type HeadsUp, type RankBasis } from "../../core/cot/board";
import { BUY_ZONE, NEUTRAL, releaseDate, SELL_ZONE } from "../../core/cot/cot";
import type { DataBundle } from "../../core/types";
import { contracts, CotChart, futPrice } from "../components/CotChart";
import { usePersisted } from "../data";
import { mmdd, stamp } from "../format";

const LOOKBACKS = ["26", "52", "156"] as const;
const BASES = ["pct", "contracts"] as const;
const RANGES = ["52", "104", "156"] as const;
const SHOWS = ["all", "watch"] as const;
const SORTS = ["sector", "crowded"] as const;
const TONE = { buy: "gain", sell: "loss", warn: "half", info: "text-2" } as const;
/** Priority at or above this counts as HEADS UP (the table filter, the default chart): a live signal or a zone. Near a zone doesn't. */
const WATCH = 3;
/** How far the large specs are from neutral: what MOST CROWDED sorts by. */
const crowding = (s: BoardSummary) => (s.spec.rank === null ? -1 : Math.abs(s.spec.rank - NEUTRAL));
const MINUS = "−";

const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const lbLabel = (lb: string) => (lb === "156" ? "3Y" : `${lb}W`);
const signedPct = (n: number | null, digits = 1) => (n === null ? "—" : `${n > 0 ? "+" : n < 0 ? MINUS : ""}${Math.abs(n).toFixed(digits)}%`);

function Seg<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: readonly { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="fgroup">
      <span className="flabel">{label}</span>
      <div className="seg" role="group" aria-label={label}>
        {options.map((o) => (
          <button key={o.value} type="button" aria-pressed={value === o.value} onClick={() => onChange(o.value)}>{o.label}</button>
        ))}
      </div>
    </div>
  );
}

/** 0–100 bar like the dashboard card's: zones tinted, a tick at 50, the reading as a needle. */
function Meter({ v, label }: { v: number | null; label: string }) {
  const W = 90, H = 12, x = (n: number) => (n / 100) * W;
  return (
    <svg className="cotb-meter" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={label}>
      <rect x="0" y="3" width={W} height="6" className="f-dim" opacity="0.35" />
      <rect x="0" y="3" width={x(BUY_ZONE)} height="6" className="f-gain" opacity="0.6" />
      <rect x={x(SELL_ZONE)} y="3" width={W - x(SELL_ZONE)} height="6" className="f-loss" opacity="0.6" />
      <line x1={x(NEUTRAL)} x2={x(NEUTRAL)} y1="1" y2="11" className="chart-ref" />
      {v !== null && <rect x={Math.min(W - 3, Math.max(0, x(v) - 1.5))} y="0" width="3" height={H} className="cot-needle" />}
    </svg>
  );
}

const rankCls = (v: number | null) => (v === null ? "muted" : v <= BUY_ZONE ? "gain b" : v >= SELL_ZONE ? "loss b" : v <= BUY_ZONE + NEAR || v >= SELL_ZONE - NEAR ? "half" : "");

function Heads({ heads, max }: { heads: HeadsUp[]; max?: number }) {
  const list = max ? heads.slice(0, max) : heads;
  if (!list.length) return <span className="dim">—</span>;
  return (
    <>
      {list.map((h, i) => (
        <span key={i} className={TONE[h.tone]}>{i > 0 && <span className="dim"> · </span>}{h.text}</span>
      ))}
    </>
  );
}

const tvHref = (sym: string) => `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(sym)}`;

function Tickers({ syms, cls, notes }: { syms: string[]; cls: string; notes?: boolean }) {
  return (
    <>
      {syms.map((t, i) => (
        <span key={t}>
          {i > 0 && <span className="dim"> · </span>}
          <a className={`b ${cls}`} href={tvHref(t)} target="_blank" rel="noopener noreferrer" title={TICKER_NOTES[t] ?? t} onClick={(e) => e.stopPropagation()}>{t}</a>
          {notes && TICKER_NOTES[t] && <span className="muted"> {TICKER_NOTES[t]}</span>}
        </span>
      ))}
    </>
  );
}

/** One line: the stocks/ETFs for the side to act on, or the buy side (muted) when there's nothing to act on. */
function TradeWith({ s }: { s: BoardSummary }) {
  const t = tradeIdeas(s.market.id);
  if (s.side === "long") return t.long.length ? <><span className="gain">BUY </span><Tickers syms={t.long} cls="gain" /></> : <span className="dim">—</span>;
  if (s.side === "short") return t.short.length ? <><span className="loss">INVERSE </span><Tickers syms={t.short} cls="loss" /></> : <span className="dim">{t.long.length ? `NO INVERSE · TRIM ${t.long[0]}` : "—"}</span>;
  return t.long.length ? <Tickers syms={t.long} cls="muted" /> : <span className="dim">—</span>;
}

/** Both sides with what each symbol is, the side to act on highlighted. */
function TradeBlock({ s }: { s: BoardSummary }) {
  const t = tradeIdeas(s.market.id);
  // The side to act on is colored with a bar at its left; the other side's symbols stay plain text, not accent links.
  const row = (label: string, syms: string[], cls: string, on: boolean, empty: string) => (
    <div className={`cotb-trade-row${on ? ` on ${cls}` : ""}`}>
      <span className="flabel">{label}</span>
      <span className="small">{syms.length ? <Tickers syms={syms} cls={on ? cls : "text-2"} notes /> : <span className={on ? "" : "dim"}>{empty}</span>}</span>
    </div>
  );
  return (
    <div className="cotb-trade">
      <span className="label">TRADE IT WITH</span>
      {row("IF IT RISES", t.long, "gain", s.side === "long", "Nothing listed")}
      {row("IF IT FALLS", t.short, "loss", s.side === "short", s.side === "short" && t.long.length ? `No inverse ETF · trim longs in ${t.long[0]}` : "No inverse ETF")}
      {t.note && <p className="muted small">{t.note}</p>}
    </div>
  );
}

function Rules() {
  const rules: [string, string][] = [
    ["READ", "Legacy report, futures only. Net = longs − shorts per group: large specs (non-commercial, the trend followers), commercials (hedgers, their mirror) and small traders. The three nets add up to zero."],
    ["RANK", "Where a group's net sits between its lowest (0) and highest (100) over the lookback. 3Y on % of open interest is the system the dashboard gauge uses; 26W on contracts reads like the TradingView indicator."],
    ["ZONES", `Large specs ≤ ${BUY_ZONE}: crowded short, look to buy ("when it goes to zero, I look to be a buyer"). ≥ ${SELL_ZONE}: crowded long, look to sell. A 3-year extreme can be ordinary over 10 years: check MOST SHORT SINCE.`],
    ["ENTER", "A zone only arms it. Wait for a reversal day: undercut the 10-day low, then close up on the day in the upper half of its range (mirror for shorts). Best: bad news the market shrugs off."],
    ["MANAGE", `Stop at the reversal day's low (high). Out when the rank is back to ${NEUTRAL}. Signals use the 3Y % of OI rank and the front-month future's daily bars (SPY, QQQ and DIA for the indices, like the dashboard).`],
    ["CAVEATS", "Backtested only on the stock indices, where longs worked and shorts didn't. Front-month bars jump at rolls. Data is Tuesday's, released Friday 3:30 PM ET. COT alone is never the trade."],
  ];
  return (
    <details className="panel cotb-rules">
      <summary className="panel-head"><h2>▸ How to read it</h2></summary>
      <dl className="kv small">
        {rules.map(([k, v]) => (
          <div key={k} className="cot-rule">
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

export function CotPage({ data, params }: { data: DataBundle; params: URLSearchParams }) {
  const board = data.cot?.board;
  const [lookback, setLookback] = usePersisted("cot.lookback", "156", LOOKBACKS);
  const [basis, setBasis] = usePersisted<RankBasis>("cot.basis", "pct", BASES);
  const [range, setRange] = usePersisted("cot.range", "104", RANGES);
  const [show, setShow] = usePersisted("cot.show", "all", SHOWS);
  const [sort, setSort] = usePersisted("cot.sort", "sector", SORTS);
  const chartRef = useRef<HTMLElement>(null);
  const chartHead = useRef<HTMLHeadingElement>(null);

  const rows = useMemo(() => {
    if (!board) return [];
    const out: BoardSummary[] = [];
    for (const d of board.markets) {
      const m = boardMarket(d.id);
      if (m) out.push(summarize(m, d, Number(lookback), basis));
    }
    return out;
  }, [board, lookback, basis]);

  if (!board || !rows.length)
    return (
      <main className="page">
        <header className="page-head"><h1>COT <span className="sub">/ FUTURES POSITIONING</span></h1></header>
        <div className="panel empty">No COT board yet. It's fetched with the post-close regime run (npm run cot) and shows here after the next deploy.</div>
      </main>
    );

  const watch = [...rows].filter((s) => s.priority >= WATCH).sort((a, b) => b.priority - a.priority);
  const picked = params.get("m");
  // Default chart: the top heads-up you can act on in stocks (something listed for its side).
  const actionable = (s: BoardSummary) => s.side !== null && tradeIdeas(s.market.id)[s.side].length > 0;
  const sel = rows.find((s) => s.market.id === picked) ?? watch.find(actionable) ?? watch[0] ?? rows[0]!;
  const report = rows.map((s) => s.data.report).filter((d): d is string => d !== null).sort().at(-1) ?? null;
  const select = (id: string) => {
    window.location.hash = `#/cot?m=${encodeURIComponent(id)}`;
    // Focus follows the scroll, so a keyboard user lands on the chart, not back in the table.
    requestAnimationFrame(() => {
      chartRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
      chartHead.current?.focus({ preventScroll: true });
    });
  };

  const listed = show === "watch" ? rows.filter((s) => s.priority >= WATCH) : rows;
  const groups =
    sort === "sector"
      ? BOARD_SECTORS.map((sector) => ({ sector, items: listed.filter((s) => s.market.sector === sector) })).filter((g) => g.items.length)
      : [{ sector: null, items: [...listed].sort((a, b) => crowding(b) - crowding(a) || b.priority - a.priority) }];
  const tvUrl = `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(sel.market.tv)}`;

  return (
    <main className="page cotb">
      <header className="page-head">
        <h1>
          COT{" "}
          <span className="sub">
            / {rows.length} FUTURES
            {report && <> · <span className="nowrap">REPORT TUE {mmdd(report)}</span> · <span className="nowrap">NEXT FRI {mmdd(releaseDate(addDays(report, 7)))}</span></>}
            {board.stale && <span className="half"> · STALE</span>}
          </span>
        </h1>
        <span className="muted small">AS OF {stamp(board.asOf)} ET</span>
      </header>

      <div className="cotb-controls">
        <Seg label="LOOKBACK" value={lookback} onChange={setLookback} options={LOOKBACKS.map((v) => ({ value: v, label: lbLabel(v) }))} />
        <Seg label="RANK ON" value={basis} onChange={setBasis} options={[{ value: "pct", label: "% OF OI" }, { value: "contracts", label: "CONTRACTS" }]} />
        <Seg label="CHART" value={range} onChange={setRange} options={RANGES.map((v) => ({ value: v, label: `${Number(v) / 52}Y` }))} />
      </div>

      <section className="panel" ref={chartRef} aria-label={`${sel.market.name} chart`}>
        <div className="panel-head">
          <h2 ref={chartHead} tabIndex={-1}>{sel.market.id} · {sel.market.name}</h2>
          <span>
            <b>{futPrice(sel.price)}</b> <span className={sel.priceChg === null ? "muted" : sel.priceChg >= 0 ? "gain" : "loss"}>{signedPct(sel.priceChg)} WK</span>
          </span>
          <span className="small" title={`${lbLabel(lookback)} ranks, 0–100`}>
            <span className="muted">{lbLabel(lookback)} RANK · SPECS </span><b className={rankCls(sel.spec.rank)}>{sel.spec.rank?.toFixed(0) ?? "—"}</b>
            <span className="muted"> · COMM </span><b className={rankCls(sel.comm.rank)}>{sel.comm.rank?.toFixed(0) ?? "—"}</b>
            <span className="muted"> · SMALL </span><b className={rankCls(sel.small.rank)}>{sel.small.rank?.toFixed(0) ?? "—"}</b>
          </span>
          <span className="grow" />
          <a className="small" href={tvUrl} target="_blank" rel="noopener noreferrer">{sel.market.tv} IN TRADINGVIEW ↗</a>
        </div>
        <div className="cotb-chart-body">
          <p className="small cotb-sel-heads"><Heads heads={sel.heads} /></p>
          <TradeBlock s={sel} />
          <CotChart key={sel.market.id} name={sel.market.name} weeks={sel.weeks} range={Number(range)} lookback={Number(lookback)} basis={basis} />
        </div>
      </section>

      <section className="panel" aria-label="All markets">
        <div className="panel-head">
          <h2>Markets</h2>
          <Seg label="SHOW" value={show} onChange={setShow} options={[{ value: "all", label: `ALL ${rows.length}` }, { value: "watch", label: `HEADS UP ${watch.length}` }]} />
          <Seg label="SORT" value={sort} onChange={setSort} options={[{ value: "sector", label: "SECTOR" }, { value: "crowded", label: "MOST CROWDED" }]} />
        </div>
        <div className="scroll-x">
          <table className="grid dense cotb-table">
            <thead>
              <tr>
                <th scope="col">MKT</th>
                <th scope="col">LARGE SPECS {lbLabel(lookback)}</th>
                <th scope="col">HEADS UP</th>
                <th scope="col">TRADE WITH</th>
                <th scope="col" className="num">LAST</th>
                <th scope="col" className="num">WK</th>
                <th scope="col" className="num" title="Large specs rank 4 weeks ago">4W AGO</th>
                <th scope="col" className="num" title="Commercials rank">COMM</th>
                <th scope="col" className="num" title="Small traders rank">SMALL</th>
                <th scope="col" className="num" title="Large specs net contracts">SPECS NET</th>
                <th scope="col" className="num" title="Change in large specs net contracts on the week">WK CHG</th>
              </tr>
            </thead>
            {groups.map((g) => (
              <tbody key={g.sector ?? "all"}>
                {g.sector && (
                  <tr className="cotb-sector">
                    <th colSpan={11} scope="colgroup"><span>{g.sector.toUpperCase()}</span></th>
                  </tr>
                )}
                {g.items.map((s) => (
                  <tr key={s.market.id} className={`clickable${s === sel ? " cotb-on" : ""}`} onClick={() => select(s.market.id)}>
                    <td>
                      <button type="button" className="linkish b" onClick={(e) => { e.stopPropagation(); select(s.market.id); }} title={s.market.name} aria-current={s === sel ? "true" : undefined}>{s.market.id}</button>
                      <span className="muted cotb-name"> {s.market.name}</span>
                    </td>
                    <td>
                      <span className="cotb-meter-cell">
                        <Meter v={s.spec.rank} label={`${s.market.name} large specs rank ${s.spec.rank?.toFixed(0) ?? "unknown"} of 100`} />
                        <b className={`cotb-rank ${rankCls(s.spec.rank)}`}>{s.spec.rank === null ? "—" : s.spec.rank.toFixed(0)}</b>
                      </span>
                    </td>
                    <td className="small cotb-heads-cell"><Heads heads={s.heads} max={2} /></td>
                    <td className="small cotb-trade-cell"><TradeWith s={s} /></td>
                    <td className="num">{futPrice(s.price)}</td>
                    <td className={`num ${s.priceChg === null ? "muted" : s.priceChg >= 0 ? "gain" : "loss"}`}>{signedPct(s.priceChg)}</td>
                    <td className="num muted">{s.spec4w === null ? "—" : s.spec4w.toFixed(0)}</td>
                    <td className={`num ${rankCls(s.comm.rank)}`}>{s.comm.rank === null ? "—" : s.comm.rank.toFixed(0)}</td>
                    <td className={`num ${rankCls(s.small.rank)}`}>{s.small.rank === null ? "—" : s.small.rank.toFixed(0)}</td>
                    <td className="num">{contracts(s.spec.net)}</td>
                    <td className={`num ${s.spec.chg === null || s.spec.chg === 0 ? "muted" : s.spec.chg > 0 ? "gain" : "loss"}`}>{contracts(s.spec.chg)}</td>
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
        </div>
        <p className="muted small cotb-foot">
          Ranks: {lbLabel(lookback)}, {basis === "pct" ? "net % of OI" : "net contracts"}. Signals always use 3Y, % of OI. Prices: front-month, weekly.
        </p>
      </section>

      <Rules />
    </main>
  );
}
