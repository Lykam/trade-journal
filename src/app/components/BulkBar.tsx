// Bulk actions on the selected trades (SPEC §6.3): Add tag / Remove tag / Set
// style / Exclude. Actions are staged against overrides.json and previewed by
// re-deriving trades; committing to trade-history arrives in milestone 5.
import { useMemo, useState } from "react";
import type { Journal } from "../../core/journal/journal";
import { applyBulkAction, changedOverrideIds, previewOverrides, type BulkAction } from "../../core/journal/overrides";
import type { DataBundle, Overrides } from "../../core/types";

export function describeAction(a: BulkAction): string {
  switch (a.kind) {
    case "addTag": return `+tag "${a.tag}"`;
    case "removeTag": return `−tag "${a.tag}"`;
    case "setStyle": return `style → ${a.style}`;
    case "exclude": return a.exclude ? "exclude" : "include";
    case "setNote": return "note";
  }
}

/** Staged override edits: the actions so far and the overrides they produce. */
export function useStagedOverrides(data: DataBundle) {
  const [staged, setStaged] = useState<{ overrides: Overrides; log: string[] } | null>(null);
  const current = staged?.overrides ?? data.overrides;
  const apply = (trades: Parameters<typeof applyBulkAction>[1], action: BulkAction) =>
    setStaged({
      overrides: applyBulkAction(current, trades, action, data.config),
      log: [...(staged?.log ?? []), `${describeAction(action)} on ${trades.length} trade${trades.length === 1 ? "" : "s"}`],
    });
  return { staged, current, apply, discard: () => setStaged(null) };
}

export function StagedPreview({ data, staged, onDiscard }: { data: DataBundle; staged: { overrides: Overrides; log: string[] }; onDiscard: () => void }) {
  const preview = useMemo(
    () => previewOverrides(data.fills, { config: data.config, symbols: data.symbols }, data.overrides, staged.overrides),
    [data, staged.overrides],
  );
  const ids = changedOverrideIds(data.overrides, staged.overrides);
  return (
    <div className="staged">
      <div>
        <span className="label small">STAGED</span> {staged.log.join(" · ")}
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
        <button type="button" className="btn primary" disabled title="Committing to trade-history arrives in milestone 5">COMMIT TO TRADE-HISTORY</button>
        <button type="button" className="btn" onClick={onDiscard}>DISCARD</button>
        <span className="dim small">Commits arrive in milestone 5 (in-browser edits through the GitHub API). Nothing is written yet.</span>
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
