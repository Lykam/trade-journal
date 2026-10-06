// Map a symbol to the ticker it tracks (SPEC §3.4, §6.4, §6.9): a single-stock ETF →
// its underlying, with leverage and direction. COMMIT reads trade-history fresh,
// previews what moves, then writes symbols.json and a regenerated derived/trades.json
// in one commit (Q40), like the other edits.
//
// The fields are shared; everything that talks to GitHub lives in SymbolCommit, which
// the demo build never renders, so the demo bundle carries no token or GitHub code (Q50).
import { useState } from "react";
import { mappingError, type SymbolChange, type SymbolCommitPlan } from "../../core/symbols/mapping";
import type { DataBundle, SymbolInfo } from "../../core/types";
import { DEMO_COMMIT_NOTE } from "../demo-text";
import { ACTIONS_URL, clientFor, feedsSite, useToken, watchDeploy } from "../github";

const upper = (s: string) => s.trim().toUpperCase();

/**
 * The form for one symbol. `symbol` fixes the symbol (Trade detail); without it the
 * symbol is typed in (Settings → ADD MAPPING). An existing mapping is pre-filled and
 * can be changed or removed.
 */
export function SymbolMapForm({ data, symbol: fixed, onClose }: { data: DataBundle; symbol?: string; onClose: () => void }) {
  const existing = fixed ? data.symbols[fixed] : undefined;
  const [symbol, setSymbol] = useState(fixed ?? "");
  const [underlying, setUnderlying] = useState(existing?.underlying ?? "");
  const [leverage, setLeverage] = useState(String(existing?.leverage ?? 2));
  const [direction, setDirection] = useState<SymbolInfo["direction"]>(existing?.direction ?? "long");
  const [issuer, setIssuer] = useState(existing?.issuer ?? "");
  const [busy, setBusy] = useState(false);

  const sym = upper(symbol);
  const info: SymbolInfo = { underlying: upper(underlying), type: "leveraged_etf", leverage: Number(leverage), direction, ...(issuer.trim() ? { issuer: issuer.trim() } : {}) };
  const off = busy || undefined;

  return (
    <div className="symmap" aria-label="Map a symbol to its underlying" role="group">
      <div className="row">
        <label className="field"><span className="label small">SYMBOL</span>
          <input className="input narrow" value={symbol} disabled={!!fixed || off} onChange={(e) => setSymbol(e.target.value.toUpperCase())} placeholder="ETF" spellCheck={false} />
        </label>
        <span className="muted">→</span>
        <label className="field"><span className="label small">UNDERLYING</span>
          <input className="input narrow" value={underlying} disabled={off} onChange={(e) => setUnderlying(e.target.value.toUpperCase())} placeholder="ticker" spellCheck={false} autoFocus />
        </label>
        <label className="field"><span className="label small">LEVERAGE</span>
          <input className="input tiny" inputMode="decimal" value={leverage} disabled={off} onChange={(e) => setLeverage(e.target.value)} />
        </label>
        <label className="field"><span className="label small">DIRECTION</span>
          <select className="input" value={direction} disabled={off} onChange={(e) => setDirection(e.target.value as SymbolInfo["direction"])}>
            <option value="long">long</option>
            <option value="inverse">inverse</option>
          </select>
        </label>
        <label className="field"><span className="label small">ISSUER</span>
          <input className="input narrow" value={issuer} disabled={off} onChange={(e) => setIssuer(e.target.value)} placeholder="optional" />
        </label>
      </div>
      {__TJ_DEMO__ ? (
        <div className="row">
          <button type="button" className="btn primary" disabled>COMMIT…</button>
          <span className="note-line">{DEMO_COMMIT_NOTE}</span>
          <button type="button" className="btn ghost" onClick={onClose}>CANCEL</button>
        </div>
      ) : (
        <SymbolCommit sym={sym} info={info} mapped={!!data.symbols[sym]} onBusy={setBusy} onClose={onClose} />
      )}
      <div className="dim small">
        The trades count toward the underlying for ideas, reviews and ticker stats; P&L stays on {sym || "the symbol"} itself (§3.4).
      </div>
    </div>
  );
}

type Remote = import("../remote").RemoteHistory;
type Phase =
  | { kind: "edit"; error?: string }
  | { kind: "reading" }
  | { kind: "review"; plan: SymbolCommitPlan; remote: Remote; edits: SymbolChange[]; notice?: string }
  | { kind: "committing" }
  | { kind: "done"; url: string | null };

/** Read trade-history fresh, preview, then commit (never rendered in the demo). */
function SymbolCommit({ sym, info, mapped, onBusy, onClose }: {
  sym: string;
  info: SymbolInfo;
  mapped: boolean;
  onBusy: (busy: boolean) => void;
  onClose: () => void;
}) {
  const token = useToken();
  const [phase, setPhaseRaw] = useState<Phase>({ kind: "edit" });
  const setPhase = (p: Phase) => {
    setPhaseRaw(p);
    onBusy(p.kind !== "edit");
  };
  if (token.status !== "ok") {
    return (
      <div className="row">
        <span className="dim small">{token.status === "loading" ? "…" : <>To commit, add a GitHub token in <a href="#/settings">SETTINGS</a>.</>}</span>
        <button type="button" className="btn ghost" onClick={onClose}>CANCEL</button>
      </div>
    );
  }
  const record = token.record;

  const review = async (edits: SymbolChange[]) => {
    setPhase({ kind: "reading" });
    try {
      const { gh, repo } = clientFor(record);
      const remote = await import("../remote");
      const r = await remote.read(gh, repo);
      setPhase({ kind: "review", plan: remote.computeSymbols(r, edits), remote: r, edits });
    } catch (e) {
      setPhase({ kind: "edit", error: (e as Error).message });
    }
  };

  const save = () => {
    const err = mappingError(sym, info);
    if (err) return setPhase({ kind: "edit", error: err });
    void review([{ symbol: sym, info }]);
  };

  const commit = async (p: Extract<Phase, { kind: "review" }>) => {
    setPhase({ kind: "committing" });
    try {
      const remote = await import("../remote");
      const out = await remote.commitSymbols(clientFor(record).gh, p.remote, p.plan, p.edits);
      if (out.commit) {
        const site = feedsSite(record);
        watchDeploy({
          label: "Symbol mapping committed",
          want: site ? { sha: out.commit.sha, date: out.commit.date } : { date: out.commit.date },
          link: `${ACTIONS_URL}/workflows/deploy.yml`,
          commitUrl: out.commit.url,
          note: site ? undefined : `Committed to ${record.repo}, which the site doesn't read; the reload shows the same data.`,
        });
      }
      setPhase({ kind: "done", url: out.commit?.url ?? null });
    } catch (e) {
      const err = e as Error & { plan?: SymbolCommitPlan; remote?: Remote };
      if (err.name === "PreviewChangedError" && err.plan && err.remote) setPhase({ ...p, plan: err.plan, remote: err.remote, notice: err.message });
      else setPhase({ kind: "edit", error: err.message });
    }
  };

  switch (phase.kind) {
    case "done":
      return (
        <div className="row" role="status">
          <span className="gain small">
            COMMITTED{phase.url ? <> · <a href={phase.url} target="_blank" rel="noopener noreferrer">VIEW COMMIT ↗</a></> : " (nothing needed changing)"}
          </span>
          <button type="button" className="btn ghost" onClick={onClose}>CLOSE</button>
        </div>
      );
    case "committing":
      return <span className="accent small">COMMITTING…</span>;
    case "review": {
      const { plan, remote, notice } = phase;
      const pv = plan.preview;
      const n = Object.keys(plan.changes).length;
      return (
        <div className="commit-review" role="group" aria-label="Commit preview">
          {notice && <div className="half small">{notice}</div>}
          <div><span className="label small">COMMIT PREVIEW</span> against {record.repo} main @ <code>{remote.state.headSha.slice(0, 7)}</code></div>
          <div className="muted">
            symbols.json: {n} entr{n === 1 ? "y" : "ies"} · derived/trades.json: {pv.trades} trade{pv.trades === 1 ? "" : "s"} change
            {pv.ideasChanged ? ` · ideas ${pv.ideasBefore} → ${pv.ideasAfter} (${pv.ideasChanged} regrouped)` : " · no ideas regrouped"}
          </div>
          <div className="muted small">Message: <code>{plan.message}</code></div>
          <div className="row">
            <button type="button" className="btn primary" disabled={n === 0} onClick={() => commit(phase)}>CONFIRM COMMIT</button>
            <button type="button" className="btn" onClick={() => setPhase({ kind: "edit" })}>BACK</button>
            {n === 0 && <span className="dim small">Nothing to change: trade-history already has this mapping.</span>}
          </div>
        </div>
      );
    }
    default: {
      const reading = phase.kind === "reading";
      return (
        <>
          <div className="row">
            <button type="button" className="btn primary" disabled={reading} onClick={save}>{reading ? "READING…" : "COMMIT…"}</button>
            {mapped && <button type="button" className="btn" disabled={reading} onClick={() => void review([{ symbol: sym, info: null }])}>REMOVE MAPPING</button>}
            <button type="button" className="btn ghost" disabled={reading} onClick={onClose}>CANCEL</button>
          </div>
          {phase.kind === "edit" && phase.error && <div className="loss small">{phase.error}</div>}
        </>
      );
    }
  }
}

/** Settings: every mapping in symbols.json, with EDIT and ADD MAPPING. */
export function SymbolsPanel({ data }: { data: DataBundle }) {
  const [editing, setEditing] = useState<string | null>(null);
  const rows = Object.entries(data.symbols).sort(([a], [b]) => a.localeCompare(b));
  return (
    <section className="panel" aria-label="Symbol mappings">
      <div className="panel-head">
        <h2>Symbol mappings · {rows.length}</h2>
        <span className="grow" />
        <button type="button" className="btn ghost" onClick={() => setEditing("")}>ADD MAPPING +</button>
      </div>
      {editing !== null && (
        <div className="body"><SymbolMapForm key={editing} data={data} symbol={editing || undefined} onClose={() => setEditing(null)} /></div>
      )}
      <div className="scroll-x">
        <table className="grid dense">
          <thead><tr><th>SYMBOL</th><th>UNDERLYING</th><th className="num">LEV</th><th>DIRECTION</th><th>ISSUER</th><th /></tr></thead>
          <tbody>
            {rows.map(([s, i]) => (
              <tr key={s}>
                <td><b>{s}</b></td><td>{i.underlying}</td><td className="num">{i.leverage}x</td><td>{i.direction}</td><td className="muted">{i.issuer ?? "—"}</td>
                <td><button type="button" className="btn ghost tiny" onClick={() => setEditing(s)} aria-label={`Edit ${s}`}>EDIT</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && <div className="empty">No mappings yet.</div>}
      </div>
    </section>
  );
}
