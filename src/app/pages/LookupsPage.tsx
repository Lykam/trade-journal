// Single-stock inverse ETF lookup (SPEC §6.7c, Q80, Q82): type a ticker (either side) to find
// it. The table lives in trade-history's lookups.json and is edited here: tick rows to remove,
// add rows, then one previewed commit (Q40) writes them all, like the other edits.
//
// Everything that talks to GitHub lives in LookupsCommit, which the demo build never renders,
// so the demo bundle carries no token or GitHub code (Q50).
import { useMemo, useState } from "react";
import {
  emptyDraft, inverseEtfFromDraft, isBlankDraft, rowsOf, searchInverseEtfs, tableOf,
  type InverseEtf, type InverseEtfDraft, type InverseEtfTable, type LookupsChange, type LookupsCommitPlan,
} from "../../core/lookups/lookups";
import type { DataBundle } from "../../core/types";
import { DEMO_COMMIT_NOTE } from "../demo-text";
import { ACTIONS_URL, clientFor, feedsSite, useToken, watchDeploy } from "../github";

export function LookupsPage({ data }: { data: DataBundle }) {
  /** Committed here but not in the deployed data yet. */
  const [pending, setPending] = useState<InverseEtfTable | null>(null);
  const table = pending ?? tableOf(data.lookups);
  const all = useMemo(() => rowsOf(table), [table]);
  const [query, setQuery] = useState("");
  const rows = searchInverseEtfs(all, query);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [adds, setAdds] = useState<InverseEtfDraft[]>([]);
  const [busy, setBusy] = useState(false);
  const editing = selected.size > 0 || adds.length > 0;

  const toggle = (symbol: string) => setSelected((s) => {
    const n = new Set(s);
    if (n.has(symbol)) n.delete(symbol);
    else n.add(symbol);
    return n;
  });
  const allShown = rows.length > 0 && rows.every((r) => selected.has(r.symbol));
  const toggleShown = () => setSelected((s) => {
    const n = new Set(s);
    for (const r of rows) {
      if (allShown) n.delete(r.symbol);
      else n.add(r.symbol);
    }
    return n;
  });

  const issuers = useMemo(() => [...new Set(all.map((r) => r.issuer))].sort(), [all]);
  const reset = () => { setSelected(new Set()); setAdds([]); };

  // The change as staged, or the first thing wrong with it.
  let change: LookupsChange | null = null;
  let error: string | null = null;
  {
    const add: InverseEtf[] = [];
    for (const d of adds) {
      if (isBlankDraft(d)) continue;
      const r = inverseEtfFromDraft(d);
      if (typeof r === "string") { error ??= r; continue; }
      if (add.some((x) => x.symbol === r.symbol)) error ??= `${r.symbol} is in the add list twice.`;
      add.push(r);
    }
    if (!error) {
      if (selected.size + add.length === 0) error = "Tick rows to remove or fill in a row to add.";
      else change = { remove: [...selected].sort(), add };
    }
  }

  const starter = !pending && !data.lookups;

  return (
    <main className="page">
      <header className="page-head">
        <h1>LOOKUPS</h1>
        <button type="button" className="btn primary" disabled={busy} onClick={() => setAdds((a) => [...a, emptyDraft()])}>+ ADD ETF</button>
      </header>

      {editing && (
        <section className="panel lookups-edit" aria-label="Changes to commit">
          <div className="panel-head">
            <h2>Changes</h2>
            <span className="dim small">{[selected.size && `${selected.size} to remove`, adds.length && `${adds.length} to add`].filter(Boolean).join(" · ")}</span>
          </div>
          <div className="lk-body">
            {selected.size > 0 && (
              <div className="lk-group">
                <div className="label small">Remove</div>
                <div className="lk-pills">
                  {[...selected].sort().map((s) => (
                    <button key={s} type="button" className="pill loss" disabled={busy} onClick={() => toggle(s)} title="Keep this one" aria-label={`Keep ${s}`}>
                      {s}<span className="lk-x" aria-hidden>×</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            {adds.length > 0 && (
              <div className="lk-group">
                <div className="label small">Add</div>
                <div className="lk-grid" role="table" aria-label="Rows to add">
                  <div className="lk-row lk-head" role="row" aria-hidden>
                    <span>ETF</span><span>UNDERLYING</span><span>LEV</span><span>ISSUER</span><span />
                  </div>
                  {adds.map((d, i) => {
                    const set = (k: keyof InverseEtfDraft) => (e: { target: { value: string } }) =>
                      setAdds((a) => a.map((x, j) => (j === i ? { ...x, [k]: e.target.value } : x)));
                    const sym = d.symbol.trim().toUpperCase();
                    const existing = table[sym];
                    return (
                      <div key={i} className="lk-row" role="row">
                        <input className="input" aria-label="ETF symbol" value={d.symbol} disabled={busy} onChange={set("symbol")} placeholder="TSLQ" spellCheck={false} autoFocus={i === adds.length - 1} />
                        <input className="input" aria-label="Underlying" value={d.underlying} disabled={busy} onChange={set("underlying")} placeholder="TSLA" spellCheck={false} />
                        <input className="input" aria-label="Leverage" inputMode="decimal" value={d.leverage} disabled={busy} onChange={set("leverage")} placeholder="2" />
                        <input className="input" aria-label="Issuer" value={d.issuer} disabled={busy} onChange={set("issuer")} placeholder="Tradr" list="lookup-issuers"
                          onKeyDown={(e) => e.key === "Enter" && i === adds.length - 1 && setAdds((a) => [...a, emptyDraft()])} />
                        <button type="button" className="btn ghost tiny" disabled={busy} onClick={() => setAdds((a) => a.filter((_, j) => j !== i))} aria-label="Drop this row" title="Drop this row">×</button>
                        {existing && !selected.has(sym) && <span className="half small lk-note">Replaces {sym} → {existing.underlying} {existing.leverage}x {existing.issuer}</span>}
                      </div>
                    );
                  })}
                </div>
                <div><button type="button" className="btn ghost tiny" disabled={busy} onClick={() => setAdds((a) => [...a, emptyDraft()])}>+ ROW</button></div>
              </div>
            )}
            <datalist id="lookup-issuers">{issuers.map((s) => <option key={s} value={s} />)}</datalist>
            <div className="lk-actions">
              {__TJ_DEMO__ ? (
                <div className="row">
                  <button type="button" className="btn primary" disabled>COMMIT…</button>
                  <span className="note-line">{DEMO_COMMIT_NOTE}</span>
                  <button type="button" className="btn ghost" onClick={reset}>CANCEL</button>
                </div>
              ) : (
                <LookupsCommit
                  change={change}
                  error={error}
                  onBusy={setBusy}
                  onCommitted={(t) => { setPending(t); reset(); }}
                  onClose={reset}
                />
              )}
            </div>
          </div>
        </section>
      )}

      <section className="panel" aria-label="Single-stock inverse ETFs">
        <div className="panel-head">
          <h2>Inverse ETFs · {rows.length}</h2>
          {pending && <span className="chip accent" title="Committed; it shows here for good once the site redeploys">DEPLOYING</span>}
          <span className="grow" />
          <input
            className="input narrow"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setQuery("")}
            placeholder="Ticker, e.g. NVDA or TSLQ"
            spellCheck={false}
            autoFocus
          />
        </div>
        <div className="scroll-x">
          <table className="grid dense lookups">
            <thead>
              <tr>
                <th className="pick">
                  <input type="checkbox" checked={allShown} disabled={busy || !rows.length} onChange={toggleShown}
                    aria-label={allShown ? "Unselect the rows shown" : "Select the rows shown to remove"} title="Select the rows shown" />
                </th>
                <th>ETF</th><th>UNDERLYING</th><th className="num" title="Leverage">LEV</th><th>ISSUER</th>
              </tr>
            </thead>
            <tbody>
              {(() => {
                let band = 0;
                return rows.map((r, i) => {
                  if (i === 0 || rows[i - 1]!.underlying !== r.underlying) band++;
                  const on = selected.has(r.symbol);
                  return (
                    <tr key={r.symbol} className={`${band % 2 ? "band" : ""}${on ? " removing" : ""}`}>
                      <td className="pick">
                        <input type="checkbox" checked={on} disabled={busy} onChange={() => toggle(r.symbol)} aria-label={`Remove ${r.symbol}`} />
                      </td>
                      <td><b>{r.symbol}</b></td>
                      <td>{r.underlying}</td>
                      <td className="num">{r.leverage}x</td>
                      <td className="muted">{r.issuer}</td>
                    </tr>
                  );
                });
              })()}
            </tbody>
          </table>
          {!rows.length && <div className="empty">No inverse ETF on file for "{query}". Add one with <b>+ ADD ETF</b>.</div>}
        </div>
        <div className="dim small lk-foot">
          Single-stock inverse ETFs only. Tick rows to remove, or <b>+ ADD ETF</b>. One commit saves all changes.
          {starter && " Built-in starting list. Your first commit saves it to trade-history."}
        </div>
      </section>
    </main>
  );
}

type Remote = import("../remote").RemoteHistory;
type Phase =
  | { kind: "edit"; error?: string }
  | { kind: "reading" }
  | { kind: "review"; plan: LookupsCommitPlan; remote: Remote; notice?: string }
  | { kind: "committing" };

const syms = (rows: InverseEtf[]) => rows.map((r) => r.symbol).join(", ");

/** Read trade-history fresh, preview, then commit (never rendered in the demo). */
function LookupsCommit({ change, error, onBusy, onCommitted, onClose }: {
  change: LookupsChange | null;
  error: string | null;
  onBusy: (busy: boolean) => void;
  onCommitted: (table: InverseEtfTable) => void;
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

  const review = async () => {
    if (error || !change) return setPhase({ kind: "edit", error: error ?? "Nothing to commit." });
    setPhase({ kind: "reading" });
    try {
      const { gh, repo } = clientFor(record);
      const remote = await import("../remote");
      const r = await remote.read(gh, repo);
      setPhase({ kind: "review", plan: remote.computeLookups(r, change), remote: r });
    } catch (e) {
      setPhase({ kind: "edit", error: (e as Error).message });
    }
  };

  const commit = async (p: Extract<Phase, { kind: "review" }>) => {
    if (!change) return;
    setPhase({ kind: "committing" });
    try {
      const remote = await import("../remote");
      const out = await remote.commitLookups(clientFor(record).gh, p.remote, p.plan, change);
      if (out.commit) {
        const site = feedsSite(record);
        watchDeploy({
          label: "Lookups committed",
          want: site ? { sha: out.commit.sha, date: out.commit.date } : { date: out.commit.date },
          link: `${ACTIONS_URL}/workflows/deploy.yml`,
          commitUrl: out.commit.url,
          note: site ? undefined : `Committed to ${record.repo}. The site doesn't read it, so the reload looks the same.`,
        });
        onCommitted(out.plan.lookups.inverseEtfs);
      }
      onBusy(false);
      onClose();
    } catch (e) {
      const err = e as Error & { plan?: LookupsCommitPlan; remote?: Remote };
      if (err.name === "PreviewChangedError" && err.plan && err.remote) setPhase({ ...p, plan: err.plan, remote: err.remote, notice: err.message });
      else setPhase({ kind: "edit", error: err.message });
    }
  };

  switch (phase.kind) {
    case "committing":
      return <span className="accent small">COMMITTING…</span>;
    case "review": {
      const { plan, remote, notice } = phase;
      const none = plan.files.length === 0;
      const n = Object.keys(plan.lookups.inverseEtfs).length;
      return (
        <div className="commit-review" role="group" aria-label="Commit preview">
          {notice && <div className="half small">{notice}</div>}
          <div><span className="label small">COMMIT PREVIEW</span> against {record.repo} main @ <code>{remote.state.headSha.slice(0, 7)}</code></div>
          {plan.removed.length > 0 && <div className="loss small">− {syms(plan.removed)}</div>}
          {plan.added.length > 0 && <div className="gain small">+ {syms(plan.added)}</div>}
          {plan.replaced.map(({ before, after }) => (
            <div key={after.symbol} className="half small">~ {after.symbol}: {before.underlying} {before.leverage}x {before.issuer} → {after.underlying} {after.leverage}x {after.issuer}</div>
          ))}
          {plan.gone.length > 0 && <div className="dim small">Already gone from trade-history, skipped: {plan.gone.join(", ")}</div>}
          <div className="muted">lookups.json: {n} inverse ETF{n === 1 ? "" : "s"}{plan.creating ? " (new file, from the built-in list)" : ""}{none ? " (unchanged)" : ""}</div>
          <div className="muted small">Message: <code>{plan.message}</code></div>
          <div className="row">
            <button type="button" className="btn primary" disabled={none} onClick={() => commit(phase)}>CONFIRM COMMIT</button>
            <button type="button" className="btn" onClick={() => setPhase({ kind: "edit" })}>BACK</button>
            {none && <span className="dim small">Nothing to change: trade-history already has this.</span>}
          </div>
        </div>
      );
    }
    default: {
      const reading = phase.kind === "reading";
      return (
        <>
          <div className="row">
            <button type="button" className="btn primary" disabled={reading} onClick={() => void review()}>{reading ? "READING…" : "COMMIT…"}</button>
            <button type="button" className="btn ghost" disabled={reading} onClick={onClose}>CANCEL</button>
          </div>
          {phase.kind === "edit" && (phase.error ?? (error && !error.startsWith("Tick") ? error : null)) && (
            <div className="loss small">{phase.error ?? error}</div>
          )}
        </>
      );
    }
  }
}
