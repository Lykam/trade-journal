// Bulk actions on the selected trades (SPEC §6.3): Add tag / Remove tag / Set
// style / Exclude. Actions are staged against overrides.json and previewed by
// re-deriving trades; COMMIT replays them on the current trade-history (read
// fresh through the GitHub API), shows that preview, then writes one commit.
import { useMemo, useState } from "react";
import type { Journal } from "../../core/journal/journal";
import {
  applyBulkAction, changedOverrideIds, describeStaged, previewOverrides, type BulkAction, type OverrideCommitPlan, type StagedAction,
} from "../../core/journal/overrides";
import type { DataBundle, Overrides, Trade } from "../../core/types";
import { ACTIONS_URL, clientFor, feedsSite, useToken, watchDeploy } from "../github";

export interface Staged {
  overrides: Overrides;
  actions: StagedAction[];
}

/** Staged override edits: the actions so far and the overrides they produce. */
export function useStagedOverrides(data: DataBundle) {
  const [staged, setStaged] = useState<Staged | null>(null);
  const current = staged?.overrides ?? data.overrides;
  const apply = (trades: Trade[], action: BulkAction) =>
    setStaged({
      overrides: applyBulkAction(current, trades, action, data.config),
      actions: [...(staged?.actions ?? []), { tradeIds: trades.map((t) => t.id), action }],
    });
  return { staged, current, apply, discard: () => setStaged(null) };
}

type Phase =
  | { kind: "idle" }
  | { kind: "reading" }
  | { kind: "review"; plan: OverrideCommitPlan; remote: import("../remote").RemoteHistory; notice?: string }
  | { kind: "committing"; plan: OverrideCommitPlan }
  | { kind: "done"; url: string | null }
  | { kind: "error"; message: string };

const short = (sha: string) => sha.slice(0, 7);

/** Review against the current trade-history, then commit. */
function CommitFlow({ staged, onCommitted }: { staged: Staged; onCommitted: () => void }) {
  const token = useToken();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  if (token.status !== "ok") {
    return (
      <span className="dim small">
        {token.status === "loading" ? "…" : <>To commit, add a GitHub token in <a href="#/settings">SETTINGS</a>.</>}
      </span>
    );
  }
  const record = token.record;

  const review = async () => {
    setPhase({ kind: "reading" });
    try {
      const { gh, repo } = clientFor(record);
      const remote = await import("../remote");
      const r = await remote.read(gh, repo);
      setPhase({ kind: "review", plan: remote.computeOverrides(r, staged.actions), remote: r });
    } catch (e) {
      setPhase({ kind: "error", message: (e as Error).message });
    }
  };

  const commit = async (p: Extract<Phase, { kind: "review" }>) => {
    setPhase({ kind: "committing", plan: p.plan });
    const remote = await import("../remote");
    const { gh } = clientFor(record);
    try {
      const out = await remote.commitOverrides(gh, p.remote, p.plan, staged.actions);
      setPhase({ kind: "done", url: out.commit?.url ?? null });
      if (out.commit) {
        const site = feedsSite(record);
        watchDeploy({
          label: "Override edit committed",
          want: site ? { sha: out.commit.sha, date: out.commit.date } : { date: out.commit.date },
          link: `${ACTIONS_URL}/workflows/deploy.yml`,
          commitUrl: out.commit.url,
          note: site ? undefined : `Committed to ${record.repo}, which the site doesn't read; the reload shows the same data.`,
        });
      }
      onCommitted();
    } catch (e) {
      const err = e as Error & { plan?: OverrideCommitPlan; remote?: import("../remote").RemoteHistory };
      if (err.name === "PreviewChangedError" && err.plan && err.remote) {
        setPhase({ kind: "review", plan: err.plan, remote: err.remote, notice: err.message });
      } else {
        setPhase({ kind: "error", message: err.message });
      }
    }
  };

  switch (phase.kind) {
    case "idle":
      return <button type="button" className="btn primary" onClick={review}>COMMIT TO {record.repo.toUpperCase()}…</button>;
    case "reading":
      return <span className="muted small">READING {record.repo.toUpperCase()}…</span>;
    case "committing":
      return <span className="accent small">COMMITTING…</span>;
    case "done":
      return <span className="gain small">COMMITTED{phase.url ? <> · <a href={phase.url} target="_blank" rel="noopener noreferrer">VIEW COMMIT ↗</a></> : " (nothing changed)"}</span>;
    case "error":
      return (
        <span className="row">
          <span className="loss small">{phase.message}</span>
          <button type="button" className="btn" onClick={review}>TRY AGAIN</button>
        </span>
      );
    case "review": {
      const { plan, remote, notice } = phase;
      const pv = plan.preview;
      const n = Object.keys(plan.changes).length;
      return (
        <div className="commit-review" role="group" aria-label="Commit preview">
          {notice && <div className="half small">{notice}</div>}
          <div>
            <span className="label small">COMMIT PREVIEW</span> against {record.repo} main @ <code>{short(remote.state.headSha)}</code>
          </div>
          <div className="muted">
            overrides.json: {n} entr{n === 1 ? "y" : "ies"} · derived/trades.json: {pv.trades} trade{pv.trades === 1 ? "" : "s"} change
            {pv.ideasChanged ? ` · ideas ${pv.ideasBefore} → ${pv.ideasAfter} (${pv.ideasChanged} regrouped)` : " · no ideas regrouped"}
          </div>
          <div className="muted small">Message: <code>{plan.message}</code></div>
          <details>
            <summary className="muted">overrides.json changes</summary>
            <pre className="json">{JSON.stringify(plan.changes, null, 2)}</pre>
          </details>
          <div className="row">
            <button type="button" className="btn primary" disabled={n === 0} onClick={() => commit(phase)}>CONFIRM COMMIT</button>
            <button type="button" className="btn" onClick={() => setPhase({ kind: "idle" })}>BACK</button>
            {n === 0 && <span className="dim small">Nothing to change: trade-history already has these edits.</span>}
          </div>
        </div>
      );
    }
  }
}

export function StagedPreview({ data, staged, onDiscard, onCommitted = onDiscard }: { data: DataBundle; staged: Staged; onDiscard: () => void; onCommitted?: () => void }) {
  const preview = useMemo(
    () => previewOverrides(data.fills, { config: data.config, symbols: data.symbols }, data.overrides, staged.overrides),
    [data, staged.overrides],
  );
  const ids = changedOverrideIds(data.overrides, staged.overrides);
  return (
    <div className="staged">
      <div>
        <span className="label small">STAGED</span> {staged.actions.map(describeStaged).join(" · ")}
      </div>
      <div className="muted">
        PREVIEW: {preview.entries} override entr{preview.entries === 1 ? "y" : "ies"} · {preview.trades} trade{preview.trades === 1 ? "" : "s"} change
        {preview.ideasChanged ? ` · ideas ${preview.ideasBefore} → ${preview.ideasAfter} (${preview.ideasChanged} regrouped)` : " · no ideas regrouped"}
      </div>
      <details>
        <summary className="muted">overrides.json entries</summary>
        <pre className="json">{JSON.stringify(Object.fromEntries(ids.map((id) => [id, staged.overrides.trades[id] ?? null])), null, 2)}</pre>
      </details>
      <div className="row">
        <CommitFlow staged={staged} onCommitted={onCommitted} />
        <button type="button" className="btn" onClick={onDiscard}>DISCARD</button>
      </div>
    </div>
  );
}

export function BulkBar({ data, journal: j, selected, onClear }: { data: DataBundle; journal: Journal; selected: Set<string>; onClear: () => void }) {
  const trades = [...selected].map((id) => j.tradeById.get(id)).filter((t) => t !== undefined);
  const { staged, current, apply, discard } = useStagedOverrides(data);
  const [tag, setTag] = useState("");
  const manual = [...new Set(trades.flatMap((t) => current.trades[t.id]?.tags ?? t.tags))].sort();
  return (
    <section className="panel bulk" aria-label="Bulk actions">
      <div className="row">
        <b className="accent">{trades.length} SELECTED</b>
        <form className="row" onSubmit={(e) => { e.preventDefault(); if (tag.trim()) { apply(trades, { kind: "addTag", tag: tag.trim() }); setTag(""); } }}>
          <input className="input" value={tag} onChange={(e) => setTag(e.target.value)} placeholder="new tag" aria-label="Tag to add" list="tag-list" />
          <datalist id="tag-list">{j.allTags.map((t) => <option key={t} value={t} />)}</datalist>
          <button type="submit" className="btn" disabled={!tag.trim()}>ADD TAG</button>
        </form>
        <select className="input" aria-label="Remove tag" value="" disabled={!manual.length} onChange={(e) => e.target.value && apply(trades, { kind: "removeTag", tag: e.target.value })}>
          <option value="">REMOVE TAG…</option>
          {manual.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <div className="seg" role="group" aria-label="Set style">
          <button type="button" onClick={() => apply(trades, { kind: "setStyle", style: "day" })}>SET DAY</button>
          <button type="button" onClick={() => apply(trades, { kind: "setStyle", style: "swing" })}>SET SWING</button>
        </div>
        <div className="seg" role="group" aria-label="Exclude">
          <button type="button" onClick={() => apply(trades, { kind: "exclude", exclude: true })}>EXCLUDE</button>
          <button type="button" onClick={() => apply(trades, { kind: "exclude", exclude: false })}>INCLUDE</button>
        </div>
        <span className="grow" />
        <button type="button" className="btn ghost" onClick={() => { discard(); onClear(); }}>CLEAR SELECTION</button>
      </div>
      {staged && <StagedPreview data={data} staged={staged} onDiscard={discard} />}
    </section>
  );
}
