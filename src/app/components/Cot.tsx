import { useState } from "react";
import { BUY_ZONE, EDGE, NEUTRAL, SELL_ZONE, type CotBrake, type CotMarketSnapshot, type CotSide, type CotSignal } from "../../core/cot/cot";
import type { CotFile } from "../../core/types";
import { mmdd, price, stamp } from "../format";

const ZONE_LABEL = { buy: "BUY ZONE", neutral: "NEUTRAL", sell: "SELL ZONE" } as const;
const ZONE_CLASS = { buy: "gain", neutral: "muted", sell: "loss" } as const;
const SIDE = { long: "LONG", short: "SHORT" } as const;
const MINUS = "−";

const signed = (n: number) => `${n > 0 ? "+" : n < 0 ? MINUS : ""}${Math.abs(n).toFixed(0)}`;
/** A group's 3-year rank, flagged when it sits in the top or bottom slice. */
const crowd = (r: number | null) => (r === null ? "—" : `${r.toFixed(0)} of 100${r >= 100 - EDGE ? " · crowded long" : r <= EDGE ? " · crowded short" : ""}`);
const signedPct = (n: number) => `${n > 0 ? "+" : n < 0 ? MINUS : ""}${Math.abs(n).toFixed(1)}%`;

/** "½ SIZE (NQ, YM)" or "FULL SIZE": the brake for one direction. */
export function brakeLabel(b: CotBrake): string {
  return b.multiplier < 1 ? `${b.multiplier === 0.5 ? "½" : `×${b.multiplier}`} SIZE (${b.against.join(", ")})` : "FULL SIZE";
}

/** Why the brake is on, in words. */
export function brakeReason(side: CotSide, b: CotBrake): string {
  if (b.multiplier >= 1) return side === "long" ? "No index in the sell zone." : "No index in the buy zone.";
  return side === "long"
    ? `${b.against.join(", ")} in the sell zone: commercials near their most short.`
    : `${b.against.join(", ")} in the buy zone: commercials near their most long.`;
}

function signalText(s: CotSignal, etf: string): string {
  if (s.state === "confirmed") return `${SIDE[s.side!]} SINCE ${mmdd(s.since!)} · ${etf} STOP ${price(s.stop)}`;
  if (s.state === "armed") return `ARMED ${SIDE[s.side!]} · WAITING FOR A REVERSAL DAY`;
  return "NO SIGNAL";
}

function lastText(l: CotSignal["last"]): string | null {
  if (!l) return null;
  const what = l.kind === "expired" ? "EXPIRED UNCONFIRMED" : l.kind === "stopped" ? "STOPPED" : "EXITED AT NEUTRAL";
  return `LAST: ${SIDE[l.side]} ${what} ${mmdd(l.date)}${l.ret === null ? "" : ` ${signedPct(l.ret)}`}`;
}

/** 0–100 bar: sell zone (left) tinted red, buy zone (right) green, a tick at 50, the reading as a needle. */
function Meter({ m }: { m: CotMarketSnapshot }) {
  const W = 120, H = 14, x = (v: number) => (v / 100) * W;
  return (
    <svg className="cot-meter" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${m.name} commercials ${m.osc.toFixed(0)} of 100`}>
      <rect x="0" y="4" width={W} height="6" className="f-dim" opacity="0.35" />
      <rect x="0" y="4" width={x(SELL_ZONE)} height="6" className="f-loss" opacity="0.6" />
      <rect x={x(BUY_ZONE)} y="4" width={W - x(BUY_ZONE)} height="6" className="f-gain" opacity="0.6" />
      <line x1={x(NEUTRAL)} x2={x(NEUTRAL)} y1="2" y2="12" className="chart-ref" />
      <rect x={Math.min(W - 3, Math.max(0, x(m.osc) - 1.5))} y="0" width="3" height={H} className="cot-needle" />
    </svg>
  );
}

/** The last 52 weekly readings against the 20/80 lines. */
function Spark({ m }: { m: CotMarketSnapshot }) {
  const W = 156, H = 30;
  const pts = m.spark.map((v, i) => `${((i / Math.max(1, m.spark.length - 1)) * W).toFixed(1)},${(H - (v / 100) * H).toFixed(1)}`).join(" ");
  return (
    <svg className="cot-spark" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${m.name}: last ${m.spark.length} weekly readings`}>
      <line x1="0" x2={W} y1={H - (BUY_ZONE / 100) * H} y2={H - (BUY_ZONE / 100) * H} className="s-gain" opacity="0.5" />
      <line x1="0" x2={W} y1={H - (SELL_ZONE / 100) * H} y2={H - (SELL_ZONE / 100) * H} className="s-loss" opacity="0.5" />
      <polyline points={pts} className="cot-line" />
    </svg>
  );
}

function Row({ m, more }: { m: CotMarketSnapshot; more: boolean }) {
  const last = lastText(m.signal.last);
  return (
    <li className="cot-row">
      <div className="cot-main">
        <b className="cot-name">{m.id}</b>
        <Meter m={m} />
        <b className="cot-osc">{m.osc.toFixed(0)}</b>
        <span className={ZONE_CLASS[m.zone]}>{ZONE_LABEL[m.zone]}</span>
        <span className="dim">
          4W {m.osc4w === null ? "—" : signed(m.osc - m.osc4w)} · 1Y {m.osc1y === null ? "—" : signed(m.osc - m.osc1y)}
        </span>
        <span className={m.signal.state === "confirmed" ? "accent" : m.signal.state === "armed" ? "half" : "dim"}>{signalText(m.signal, m.etf)}</span>
        {m.stale && <span className="half">STALE</span>}
      </div>
      {more && (
        <div className="cot-detail">
          <Spark m={m} />
          <dl className="kv small">
            <dt>Net, % of OI</dt>
            <dd>
              LARGE SPECS {signedPct(m.net.largeSpec)} · COMMERCIALS {signedPct(m.net.commercial)} · SMALL {signedPct(m.net.small)}
            </dd>
            {m.net1y && (
              <>
                <dt>A year ago</dt>
                <dd className="dim">
                  LARGE SPECS {signedPct(m.net1y.largeSpec)} · COMMERCIALS {signedPct(m.net1y.commercial)} · SMALL {signedPct(m.net1y.small)}
                </dd>
              </>
            )}
            <dt>Large specs</dt>
            <dd>{crowd(m.specRank ?? null)}</dd>
            <dt>Small traders</dt>
            <dd>{crowd(m.smallRank)}</dd>
            <dt>Report</dt>
            <dd>{m.report} (released {m.released}) · bars from {m.etf}</dd>
          </dl>
          {m.divergence && (
            <div className="accent small">
              {m.divergence === "small-long-large-short"
                ? "Small traders crowded long, large specs crowded short: the late-1999 setup. The top came once the large specs were squeezed out."
                : "Small traders crowded short, large specs crowded long: the mirror of the late-1999 setup."}
            </div>
          )}
          {last && <div className="dim small">{last}</div>}
        </div>
      )}
    </li>
  );
}

/** The rules in plain terms, written to work on any COT market (SPEC §5.7). */
function CotRules() {
  return (
    <div className="cot-rules small">
      <b className="label">THE RULES (ANY COT MARKET)</b>
      <ul>
        <li><b>Read:</b> legacy report, futures only. Follow the commercials (the better-informed side): net = long − short, as % of open interest.</li>
        <li><b>Rank:</b> where that net sits within its last 3 years (156 weekly reports; the &ldquo;3yr range&rdquo; on a COT chart). 0 = their most short, 100 = their most long.</li>
        <li><b>Relative, not absolute:</b> in markets where commercials are always short (gold, crude), a buy is their short being small for them.</li>
        <li><b>Buy zone (≥ {BUY_ZONE}):</b> commercials near their most long → look for a long. <b>Sell zone (≤ {SELL_ZONE}):</b> near their most short → look for a short.</li>
        <li><b>A zone only arms it.</b> No price confirmation, no trade.</li>
        <li><b>Confirm with a reversal day:</b> undercut the prior 10-day low, then close up on the day in the upper half of its range (mirror it for shorts at a 10-day high).</li>
        <li><b>Stop:</b> the reversal day&apos;s low (high for shorts). Stopped out while the zone holds? Re-arm and wait for the next reversal.</li>
        <li><b>Exit:</b> take profits when the rank gets back to {NEUTRAL}.</li>
        <li><b>Expire:</b> the zone ends before a reversal shows up → no trade.</li>
        <li><b>Timing:</b> data is as of Tuesday, released Friday 3:30 PM ET; act from the next session. Over 2 weeks old = stale, ignore it.</li>
        <li><b>Levels, not weekly changes.</b> Where they sit matters, not how much they moved this week.</li>
        <li><b>Extra tell:</b> small traders crowded long while large specs are crowded short (late 1999) — the top comes once the specs are squeezed out.</li>
        <li><b>Sizing:</b> any index in the sell zone → swing longs ½ size; any in the buy zone → inverse ETFs ½ size. Never sizes up. Day trades untouched.</li>
        <li><b>Track record here:</b> longs worked on the S&amp;P and Dow, not the Nasdaq (large specs did better there). Shorts failed everywhere, which is why the short side only brakes. Failed on the Russell.</li>
      </ul>
    </div>
  );
}

/** COT positioning (SPEC §5.7): commercials' positioning per index, the reversal-confirmed signal, and the swing sizing brake. */
export function CotCard({ c }: { c: CotFile | null | undefined }) {
  const [more, setMore] = useState(false);
  if (!c || !c.snapshot.markets.length) return null;
  const { markets, brake } = c.snapshot;
  const report = markets.map((m) => m.report).sort().at(-1)!;
  return (
    <section className="panel regime cot" aria-label="COT positioning">
      <div className="regime-head">
        <span className="label">POSITIONING · COT</span>
        <span className={brake.long.multiplier < 1 ? "half b" : "gain b"} title={brakeReason("long", brake.long)}>
          SWING LONGS {brakeLabel(brake.long)}
        </span>
        <span className={brake.short.multiplier < 1 ? "half b" : "gain b"} title={brakeReason("short", brake.short)}>
          INVERSE ETFS {brakeLabel(brake.short)}
        </span>
        <span className="muted">
          REPORT {mmdd(report)} · AS OF {stamp(c.asOf)}
          {c.stale && <span className="half"> · STALE</span>}
        </span>
        <button type="button" className="btn ghost small" aria-expanded={more} onClick={() => setMore(!more)}>
          {more ? "▾ LESS" : "▸ DETAILS"}
        </button>
      </div>
      <ul className="cot-rows">
        {markets.map((m) => <Row key={m.id} m={m} more={more} />)}
      </ul>
      {more && <CotRules />}
    </section>
  );
}

/** One line under the swing gauge: the brake per direction, kept apart from the gauge's own call. */
export function CotGaugeNote({ c }: { c: CotFile | null | undefined }) {
  if (!c || !c.snapshot.markets.length) return null;
  const { long, short } = c.snapshot.brake;
  if (long.multiplier >= 1 && short.multiplier >= 1) return <div className="muted">COT · NO BRAKE</div>;
  return (
    <div className="muted" title={`${brakeReason("long", long)} ${brakeReason("short", short)}`}>
      COT · LONGS <b className={long.multiplier < 1 ? "half" : "gain"}>{brakeLabel(long)}</b> · INVERSE{" "}
      <b className={short.multiplier < 1 ? "half" : "gain"}>{brakeLabel(short)}</b>
    </div>
  );
}
