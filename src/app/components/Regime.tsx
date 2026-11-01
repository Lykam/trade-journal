import { useState } from "react";
import type { RegimeFile } from "../../core/types";
import { stamp } from "../format";

const STATE_LABEL = { "risk-on": "RISK-ON", unsure: "UNSURE", "risk-off": "RISK-OFF" } as const;
const STATE_CLASS = { "risk-on": "full", unsure: "half", "risk-off": "quarter" } as const;
const MARK = { "1": "✓", "0": "–", "-1": "✗" } as const;
const markClass = (score: number) => (score > 0 ? "gain" : score < 0 ? "loss" : "muted");

/** Market-environment checklist (SPEC §5.6): RISK-ON / UNSURE / RISK-OFF, with the five scored indicators behind a toggle. */
export function RegimeCard({ r }: { r: RegimeFile | null }) {
  const [more, setMore] = useState(false);
  if (!r) return null;
  const { state, score, indicators } = r.snapshot;
  return (
    <section className="panel regime" aria-label="Market regime">
      <div className="regime-head">
        <span className={`state ${STATE_CLASS[state]}`}>▌{STATE_LABEL[state]}</span>
        <span className="muted">
          SCORE {score >= 0 ? "+" : ""}{score} · AS OF {stamp(r.asOf)}
          {r.stale && <span className="half"> · STALE</span>}
        </span>
        <button type="button" className="btn ghost small" aria-expanded={more} onClick={() => setMore(!more)}>
          {more ? "▾ LESS" : "▸ CHECKLIST"}
        </button>
      </div>
      {more && (
        <ul className="regime-checklist">
          {indicators.map((i) => (
            <li key={i.id}>
              <span className={markClass(i.score)}>{MARK[String(i.score) as keyof typeof MARK]}</span> <b>{i.label}</b> — <span className="text-2">{i.detail}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
