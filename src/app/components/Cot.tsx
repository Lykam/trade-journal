import { useId, useState } from "react";
import {
  BUY_ZONE,
  NEUTRAL,
  releaseDate,
  SELL_ZONE,
  type CotBrake,
  type CotMarketSnapshot,
  type CotSide,
  type CotSignal,
} from "../../core/cot/cot";
import type { CotFile } from "../../core/types";
import { mmdd, price, stamp } from "../format";

const ZONE_LABEL = { buy: "BUY ZONE", neutral: "NEUTRAL", sell: "SELL ZONE" } as const;
const ZONE_CLASS = { buy: "gain", neutral: "muted", sell: "loss" } as const;
const SIDE = { long: "LONG", short: "SHORT" } as const;
const MINUS = "−";
/** How close to a zone counts as "near": the brake could turn on with the next Friday report. */
const NEAR = 10;
/** Short signals are shown but flagged: they lost in every backtest (SPEC §5.7). */
const WEAK = "WEAK IN BACKTESTS";

const sign = (n: number) => (n > 0 ? "+" : n < 0 ? MINUS : "");
const signedPct = (n: number) => `${sign(n)}${Math.abs(n).toFixed(1)}%`;
const contracts = (n: number) => `${sign(n)}${Math.abs(Math.round(n)).toLocaleString("en-US")}`;
const pctAway = (from: number, to: number) => `${Math.abs((100 * (to - from)) / from).toFixed(1)}%`;
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** "½ SIZE (NQ, YM)" or "NO BRAKE": the brake for one direction. It only ever cuts size. */
export function brakeLabel(b: CotBrake): string {
  return b.multiplier < 1 ? `${b.multiplier === 0.5 ? "½" : `×${b.multiplier}`} SIZE (${b.against.join(", ")})` : "NO BRAKE";
}

/** Why the brake is on, in words. */
export function brakeReason(side: CotSide, b: CotBrake): string {
  if (b.multiplier >= 1) return side === "long" ? "No index in the sell zone." : "No index in the buy zone.";
  return side === "long"
    ? `${b.against.join(", ")} in the sell zone. Large specs crowded long.`
    : `${b.against.join(", ")} in the buy zone. Large specs crowded short.`;
}

/** The row's status: what the signal is, what it needs, or how close the index is to a zone. Null = nothing to say. */
function status(m: CotMarketSnapshot): { text: string; cls: string; weak: boolean } | null {
  const s = m.signal;
  const weak = s.side === "short";
  if (s.state === "confirmed") {
    const stop = s.stop!;
    const away = s.lastClose ? ` (${pctAway(s.lastClose, stop)} AWAY)` : "";
    const arrow = s.side === "long" ? "▲" : "▼";
    return {
      text: `${arrow} ${SIDE[s.side!]} SINCE ${mmdd(s.since!)} · ${m.etf} ${price(s.entry)} → STOP ${price(stop)}${away} · EXIT AT ${NEUTRAL} (NOW ${m.osc.toFixed(0)})`,
      cls: weak ? "muted b" : "gain b",
      weak,
    };
  }
  if (s.state === "armed") {
    const trig = s.trigger;
    const need =
      trig == null
        ? "WAITING FOR A REVERSAL DAY"
        : s.side === "long"
          ? `NEEDS ${m.etf} < ${price(trig)}, THEN A CLOSE UP IN THE UPPER HALF`
          : `NEEDS ${m.etf} > ${price(trig)}, THEN A CLOSE DOWN IN THE LOWER HALF`;
    return { text: `ARMED ${SIDE[s.side!]} · ${need}`, cls: "half", weak };
  }
  if (m.osc < SELL_ZONE && m.osc >= SELL_ZONE - NEAR)
    return { text: `NEAR SELL ZONE (${(SELL_ZONE - m.osc).toFixed(0)}) · LONGS ½ AT ≥ ${SELL_ZONE}`, cls: "half", weak: false };
  if (m.osc > BUY_ZONE && m.osc <= BUY_ZONE + NEAR)
    return { text: `NEAR BUY ZONE (${(m.osc - BUY_ZONE).toFixed(0)}) · INVERSE ETFS ½ AT ≤ ${BUY_ZONE}`, cls: "half", weak: false };
  return null;
}

/** The one rule that applies to the market's current state, shown under it in DETAILS. */
function ruleNow(m: CotMarketSnapshot): string {
  const s = m.signal;
  if (s.state === "confirmed")
    return `In the trade. Out at the stop, or when the rank gets back to ${NEUTRAL}.`;
  if (s.state === "armed")
    return s.side === "long"
      ? "Armed. Next it needs a session that undercuts the 10-day low and closes up in the upper half of its range. Best when bad news can't push it lower."
      : "Armed. Next it needs a session that takes out the 10-day high and closes down in the lower half of its range. Best when good news can't lift it.";
  if (m.zone !== "neutral") return "In the zone, not armed. Re-arms the session after a stop or a new report.";
  return `Neutral, no edge. Watch Friday's report for ≤ ${BUY_ZONE} or ≥ ${SELL_ZONE}.`;
}

function lastText(l: CotSignal["last"]): string | null {
  if (!l) return null;
  const what = l.kind === "expired" ? "EXPIRED (NO TRADE)" : l.kind === "stopped" ? "STOPPED" : "EXITED AT NEUTRAL";
  return `${SIDE[l.side]} ${what} ${mmdd(l.date)}${l.ret === null ? "" : ` ${signedPct(l.ret)}`}`;
}

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const monthYear = (d: string) => `${MONTHS[+d.slice(5, 7) - 1]} ${d.slice(0, 4)}`;
const yearsBetween = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / (365.25 * 86_400_000);

/**
 * The large specs against all history, only when it's a real long-history extreme: at least a
 * year since they were more extreme, or never (Shapiro: a 1-year extreme may be nothing over 10).
 */
function extremeText(m: CotMarketSnapshot): string | null {
  const e = m.extreme;
  if (!e) return null;
  const side = e.side === "short" ? "SHORT" : "LONG";
  if (e.since === null) return `MOST ${side} ON RECORD (SINCE ${e.first.slice(0, 4)})`;
  const y = yearsBetween(e.since, m.report);
  return y >= 1 ? `MOST ${side} SINCE ${monthYear(e.since)} (${y.toFixed(1)}Y)` : null;
}

/** 0–100 bar: buy zone (left) tinted green, sell zone (right) red, a tick at 50, the reading as a needle. */
function Meter({ m, label }: { m: CotMarketSnapshot; label: string }) {
  const W = 120, H = 14, x = (v: number) => (v / 100) * W;
  return (
    <svg className="cot-meter" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={label}>
      <rect x="0" y="4" width={W} height="6" className="f-dim" opacity="0.35" />
      <rect x="0" y="4" width={x(BUY_ZONE)} height="6" className="f-gain" opacity="0.6" />
      <rect x={x(SELL_ZONE)} y="4" width={W - x(SELL_ZONE)} height="6" className="f-loss" opacity="0.6" />
      <line x1={x(NEUTRAL)} x2={x(NEUTRAL)} y1="2" y2="12" className="chart-ref" />
      <rect x={Math.min(W - 3, Math.max(0, x(m.osc) - 1.5))} y="0" width="3" height={H} className="cot-needle" />
    </svg>
  );
}

/** The last 52 weekly ranks: zone bands like the meter, a dotted 50, tick labels, and a dot on the latest. */
function Spark({ m }: { m: CotMarketSnapshot }) {
  const W = 180, H = 44, PAD = 16, w = W - PAD;
  const y = (v: number) => H - 2 - (v / 100) * (H - 4);
  const x = (i: number) => (i / Math.max(1, m.spark.length - 1)) * w;
  const pts = m.spark.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const last = m.spark.at(-1);
  const vals = m.spark.length ? `low ${Math.min(...m.spark).toFixed(0)}, high ${Math.max(...m.spark).toFixed(0)}, now ${last?.toFixed(0)}` : "no data";
  return (
    <figure className="cot-spark-wrap">
      <figcaption className="label small">52W RANK</figcaption>
      <svg className="cot-spark" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${m.name}: large-spec rank over ${m.spark.length} weeks, ${vals}`}>
        <rect x="0" y={y(BUY_ZONE)} width={w} height={y(0) - y(BUY_ZONE)} className="f-gain" opacity="0.15" />
        <rect x="0" y={y(100)} width={w} height={y(SELL_ZONE) - y(100)} className="f-loss" opacity="0.15" />
        <line x1="0" x2={w} y1={y(NEUTRAL)} y2={y(NEUTRAL)} className="chart-ref" />
        {[SELL_ZONE, NEUTRAL, BUY_ZONE].map((v) => (
          <text key={v} x={W - 1} y={y(v) + 3} textAnchor="end" className="chart-text">{v}</text>
        ))}
        <polyline points={pts} className="cot-line" />
        {last !== undefined && <circle cx={x(m.spark.length - 1)} cy={y(last)} r="2.5" className="cot-needle" />}
      </svg>
    </figure>
  );
}

/** Large specs, commercials and small traders aligned: net % of OI now and a year ago, and the 3-year rank. */
function Groups({ m }: { m: CotMarketSnapshot }) {
  const smallTag = m.smallRank === null ? "" : m.smallRank >= SELL_ZONE ? "CROWDED LONG" : m.smallRank <= BUY_ZONE ? "CROWDED SHORT" : "";
  const rows = [
    { name: "LARGE SPECS", now: m.net.largeSpec, ago: m.net1y?.largeSpec, rank: m.osc, note: "THE SIGNAL", signal: true },
    { name: "COMMERCIALS", now: m.net.commercial, ago: m.net1y?.commercial, rank: m.commRank ?? null, note: "", signal: false },
    { name: "SMALL", now: m.net.small, ago: m.net1y?.small, rank: m.smallRank, note: smallTag, signal: false },
  ];
  return (
    <table className="cot-groups">
      <thead>
        <tr>
          <td></td>
          <th scope="col">NET %OI</th>
          <th scope="col">1Y AGO</th>
          <th scope="col">3Y RANK</th>
          <td></td>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.name} className={r.signal ? "b" : undefined}>
            <th scope="row">{r.name}</th>
            <td>{signedPct(r.now)}</td>
            <td className="muted">{r.ago === undefined ? "—" : signedPct(r.ago)}</td>
            <td>{r.rank === null ? "—" : r.rank.toFixed(0)}</td>
            <td className={r.signal ? "muted" : "half"}>{r.note}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Row({ m, more }: { m: CotMarketSnapshot; more: boolean }) {
  const st = status(m);
  const ext = extremeText(m);
  const last = lastText(m.signal.last);
  const c = m.contracts;
  const label = `${m.name} large specs ${m.osc.toFixed(0)} of 100, ${ZONE_LABEL[m.zone].toLowerCase()}${st ? `, ${st.text.toLowerCase()}` : ", no signal"}`;
  return (
    <li className="cot-row">
      <div className="cot-main">
        <b className="cot-name">{m.id}</b>
        <Meter m={m} label={label} />
        <b className="cot-osc">{m.osc.toFixed(0)}</b>
        <span className={ZONE_CLASS[m.zone]}>{ZONE_LABEL[m.zone]}</span>
        {st && (
          <span className="cot-status">
            <span className={st.cls}>{st.text}</span>
            {st.weak && <span className="muted"> · {WEAK}</span>}
          </span>
        )}
        {ext && m.zone !== "neutral" && <span className="accent">{ext}</span>}
        {m.stale && <span className="half">STALE</span>}
      </div>
      {more && (
        <div className="cot-detail">
          <Spark m={m} />
          <div className="cot-facts">
            <Groups m={m} />
            <dl className="kv small">
              <dt>RANK BEFORE</dt>
              <dd>4W AGO {m.osc4w === null ? "—" : m.osc4w.toFixed(0)} · 1Y AGO {m.osc1y === null ? "—" : m.osc1y.toFixed(0)}</dd>
              <dt>ALL HISTORY</dt>
              <dd className={ext ? "accent" : "muted"}>{ext ? `LARGE SPECS ${ext}` : "Not a long-history extreme"}</dd>
              {c && (
                <>
                  <dt>CONTRACTS</dt>
                  <dd>
                    LARGE SPECS {contracts(c.largeSpec.net)} <span className="muted">(3Y {contracts(c.largeSpec.min)} … {contracts(c.largeSpec.max)})</span>
                    {" · "}COMMERCIALS {contracts(c.commercial.net)} <span className="muted">(3Y {contracts(c.commercial.min)} … {contracts(c.commercial.max)})</span>
                  </dd>
                </>
              )}
              <dt>LAST SIGNAL</dt>
              <dd className="muted">{last ?? "—"}</dd>
            </dl>
            {m.divergence && (
              <p className="accent small">
                {m.divergence === "small-long-large-short"
                  ? "Small traders crowded long, large specs crowded short. Late 1999 looked like this. The top came after the large specs got squeezed out."
                  : "Small traders crowded short, large specs crowded long. Late 1999 in reverse."}
              </p>
            )}
            <p className="text-2 small">↳ {ruleNow(m)}</p>
          </div>
        </div>
      )}
    </li>
  );
}

/** The rules in plain terms, written to work on any COT market (SPEC §5.7). */
function CotRules({ id }: { id: string }) {
  const rules: [string, string][] = [
    ["READ", "Legacy report, futures only. Large specs' net (long − short) as % of open interest, ranked over 3 years. 0 = most short, 100 = most long. Commercials are the mirror."],
    ["ZONES", `≤ ${BUY_ZONE} buy zone ("when it goes to zero, I look to be a buyer"). ≥ ${SELL_ZONE} sell zone. Check the long history. A 3-year extreme can be normal over 10. Levels, not weekly changes.`],
    ["ENTER", "A zone only arms it. A reversal day confirms it. Long: undercut the 10-day low, then close up in the upper half of the range. Shorts are the mirror. Best when bad news can't push it lower."],
    ["MANAGE", `Stop = the reversal day's low (high for shorts). Exit when the rank gets back to ${NEUTRAL}. Zone ends before a reversal → expired, no trade. Stopped while the zone holds → re-arms.`],
    ["SIZE", "Sell zone → swing longs ½. Buy zone → inverse ETFs ½. Never sizes up. Day trades untouched."],
    ["TIMING", "Tuesday data, released Friday 3:30 PM ET, used from the next session. Over 2 weeks old = stale, ignored."],
    ["RECORD", "Longs worked on the S&P, Nasdaq and Dow. Shorts failed in backtests, so the short side is mostly a brake. COT alone is never the trade."],
  ];
  return (
    <dl className="cot-rules kv small" id={id}>
      {rules.map(([k, v]) => (
        <div key={k} className="cot-rule">
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** One braked direction as a state, like the regime strip's ▌ marker. */
function BrakeTag({ label, b }: { label: string; b: CotBrake }) {
  return <span className="half b">▌{label} ½ ({b.against.join(", ")})</span>;
}

/** COT positioning (SPEC §5.7): large-spec crowding per index, the reversal-confirmed signal, and the swing sizing brake. */
export function CotCard({ c }: { c: CotFile | null | undefined }) {
  const [more, setMore] = useState(false);
  const [rules, setRules] = useState(false);
  const detailsId = useId();
  const rulesId = useId();
  if (!c || !c.snapshot.markets.length) return null;
  const { markets, brake } = c.snapshot;
  const report = markets.map((m) => m.report).sort().at(-1)!;
  const nextRelease = releaseDate(addDays(report, 7));
  const braked = brake.long.multiplier < 1 || brake.short.multiplier < 1;
  return (
    <section className="panel regime cot" aria-label="COT positioning">
      <div className="regime-head">
        <span className="label">POSITIONING · COT</span>
        {!braked && <span className="muted b">NO COT BRAKE</span>}
        {brake.long.multiplier < 1 && <BrakeTag label="SWING LONGS" b={brake.long} />}
        {brake.short.multiplier < 1 && <BrakeTag label="INVERSE ETFS" b={brake.short} />}
        <span className="muted">
          REPORT {mmdd(report)} · NEXT FRI {mmdd(nextRelease)}
          {c.stale && <span className="half"> · STALE</span>}
        </span>
        <span className="cot-toggles">
          <button type="button" className="btn ghost small" aria-expanded={more} aria-controls={detailsId} onClick={() => setMore(!more)}>
            {more ? "▾ LESS" : "▸ DETAILS"}
          </button>
          <button type="button" className="btn ghost small" aria-expanded={rules} aria-controls={rulesId} onClick={() => setRules(!rules)}>
            {rules ? "▾ RULES" : "▸ RULES"}
          </button>
        </span>
        {c.board && <><span className="grow" /><a href="#/cot">ALL FUTURES ›</a></>}
      </div>
      {braked && (
        <p className="text-2 small cot-reason">
          {[brake.long.multiplier < 1 && brakeReason("long", brake.long), brake.short.multiplier < 1 && brakeReason("short", brake.short)].filter(Boolean).join(" ")}
        </p>
      )}
      <ul className="cot-rows" id={detailsId}>
        {markets.map((m) => <Row key={m.id} m={m} more={more} />)}
      </ul>
      {more && (
        <p className="muted small cot-foot">
          REPORT TUE {mmdd(report)} · RELEASED FRI {mmdd(releaseDate(report))} · NEXT FRI {mmdd(nextRelease)} 15:30 ET · BARS{" "}
          {markets.map((m) => m.etf).join("/")} · AS OF {stamp(c.asOf)}
        </p>
      )}
      {rules && <CotRules id={rulesId} />}
    </section>
  );
}

/** One line under the swing gauge: the brake per direction, kept apart from the gauge's own call. */
export function CotGaugeNote({ c }: { c: CotFile | null | undefined }) {
  if (!c || !c.snapshot.markets.length) return null;
  const { long, short } = c.snapshot.brake;
  if (long.multiplier >= 1 && short.multiplier >= 1) return <div className="muted">COT · NO BRAKE</div>;
  const reasons = [long.multiplier < 1 && brakeReason("long", long), short.multiplier < 1 && brakeReason("short", short)].filter(Boolean).join(" ");
  return (
    <div className="muted" title={reasons}>
      COT · LONGS <b className={long.multiplier < 1 ? "half" : "muted"}>{brakeLabel(long)}</b> · INVERSE{" "}
      <b className={short.multiplier < 1 ? "half" : "muted"}>{brakeLabel(short)}</b>
    </div>
  );
}
