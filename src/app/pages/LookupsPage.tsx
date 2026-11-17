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
          <div className="panel-head"><h2>Changes</h2></div>
          <div className="body symmap">
            {selected.size > 0 && (
              <div className="row">
                <span className="label small">REMOVE {selected.size}</span>
                {[...selected].sort().map((s) => (
                  <button key={s} type="button" className="pill" disabled={busy} onClick={() => toggle(s)} title="Keep this one">{s} ×</button>
                ))}
              </div>
            )}
            {adds.map((d, i) => {
              const set = (k: keyof InverseEtfDraft) => (e: { target: { value: string } }) =>
                setAdds((a) => a.map((x, j) => (j === i ? { ...x, [k]: e.target.value } : x)));
              const existing = table[d.symbol.trim().toUpperCase()];
              return (
                <div key={i} className="row" role="group" aria-label={`New row ${i + 1}`}>
                  <label className="field"><span className="label small">ETF</span>
                    <input className="input narrow" value={d.symbol} disabled={busy} onChange={set("symbol")} placeholder="TSLQ" spellCheck={false} autoFocus={i === adds.length - 1} />
                  </label>
                  <label className="field"><span className="label small">UNDERLYING</span>
                    <input className="input narrow" value={d.underlying} disabled={busy} onChange={set("underlying")} placeholder="TSLA" spellCheck={false} />
                  </label>
                  <label className="field"><span className="label small">LEV</span>
                    <input className="input narrow" inputMode="decimal" value={d.leverage} disabled={busy} onChange={set("leverage")} placeholder="2" />
                  </label>
                  <label className="field grow"><span className="label small">ISSUER</span>
                    <input className="input" value={d.issuer} disabled={busy} onChange={set("issuer")} placeholder="Tradr" list="lookup-issuers"
                      onKeyDown={(e) => e.key === "Enter" && i === adds.length - 1 && setAdds((a) => [...a, emptyDraft()])} />
                  </label>
                  <button type="button" className="btn ghost tiny" disabled={busy} onClick={() => setAdds((a) => a.filter((_, j) => j !== i))} aria-label="Drop this row">×</button>
                  {existing && !selected.has(d.symbol.trim().toUpperCase()) && <span className="half small">replaces {d.symbol.trim().toUpperCase()} → {existing.underlying}</span>}
                </div>
              );
            })}
            <datalist id="lookup-issuers">{issuers.map((s) => <option key={s} value={s} />)}</datalist>
            {adds.length > 0 && (
              <div><button type="button" className="btn ghost tiny" disabled={busy} onClick={() => setAdds((a) => [...a, emptyDraft()])}>+ ROW</button></div>
            )}
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
          {!rows.length && <div className="empty">No inverse ETF on file for "{query}". Either none exists, or it isn't in the list yet: <b>+ ADD ETF</b>.</div>}
        </div>
        <div className="dim small">
          Single-stock inverse ETFs only. Tick rows to remove them (e.g. when a fund is delisted), or <b>+ ADD ETF</b>; one commit saves every change to trade-history.
          {starter && " This is the built-in starting list: your first commit saves it to trade-history, which is used from then on."}
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
          note: site ? undefined : `Committed to ${record.repo}, which the site doesn't read; the reload shows the same data.`,
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
