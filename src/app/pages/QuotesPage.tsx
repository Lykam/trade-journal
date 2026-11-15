// Quotes (SPEC §6.7b, Q81): trading quotes the owner hears or thinks of, to
// scroll back through. Each has an optional source, link and tags. They live in
// trade-history's sayings.json; ADD / EDIT / REMOVE read trade-history fresh,
// preview, then write one commit (Q40), like the other edits.
//
// Everything that talks to GitHub lives in SayingCommit, which the demo build
// never renders, so the demo bundle carries no token or GitHub code (Q50).
import { useMemo, useState } from "react";
import {
  draftOf, filterSayings, linkLabel, newestFirst, newSayingId, parseTags, safeHref, sayingFromDraft, sourceList, tagCounts,
  type SayingChange, type SayingCommitPlan, type SayingDraft,
} from "../../core/sayings/sayings";
import { etDate } from "../../core/normalize/util";
import type { DataBundle, Saying } from "../../core/types";
import { DEMO_COMMIT_NOTE } from "../demo-text";
import { ACTIONS_URL, clientFor, feedsSite, useToken, watchDeploy } from "../github";

type Editing = { kind: "add" } | { kind: "edit"; saying: Saying } | { kind: "remove"; saying: Saying };

/** Committed here but not in the deployed data yet: id → the new saying, or null when removed. */
type Pending = Map<string, Saying | null>;

export function QuotesPage({ data }: { data: DataBundle }) {
  const [pending, setPending] = useState<Pending>(new Map());
  const all = useMemo(() => {
    const deployed = data.sayings?.sayings ?? [];
    const merged = deployed.filter((s) => !pending.has(s.id)).concat([...pending.values()].filter((s): s is Saying => s !== null));
    return newestFirst(merged);
  }, [data, pending]);
  const [q, setQ] = useState("");
  const [tag, setTag] = useState<string | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);

  const tags = useMemo(() => tagCounts(all), [all]);
  const sources = useMemo(() => sourceList(all), [all]);
  const rows = useMemo(() => filterSayings(all, { q, tag, source }), [all, q, tag, source]);
  const filtered = Boolean(q.trim() || tag || source);

  const committed = (change: SayingChange) =>
    setPending((m) => new Map(m).set(change.kind === "put" ? change.saying.id : change.id, change.kind === "put" ? change.saying : null));

  const form = (e: Editing) => (
    <SayingForm
      key={e.kind === "add" ? "add" : `${e.kind}-${e.saying.id}`}
      editing={e}
      tags={tags.map((t) => t.tag)}
      sources={sources}
      onCommitted={committed}
      onClose={() => setEditing(null)}
    />
  );

  return (
    <main className="page">
      <header className="page-head">
        <h1>QUOTES <span className="sub">/ {filtered ? `${rows.length} OF ` : ""}{all.length} QUOTE{all.length === 1 ? "" : "S"}</span></h1>
        {editing?.kind !== "add" && (
          <button type="button" className="btn primary" onClick={() => setEditing({ kind: "add" })}>+ ADD QUOTE</button>
        )}
      </header>
      <div className="dim small">Lines worth remembering from videos, books, other traders or your own head. Read down the list before the open.</div>

      {editing?.kind === "add" && <section className="panel saying-add" aria-label="Add a quote"><div className="body">{form(editing)}</div></section>}

      {all.length > 0 && (
        <section className="panel quotes-filter" aria-label="Filter quotes">
          <div className="row">
            <input type="search" className="input quotes-search" placeholder="Search quotes…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search quotes" />
            {source && (
              <button type="button" className="pill accent" aria-pressed="true" onClick={() => setSource(null)} title="Show every source">
                {source} ×
              </button>
            )}
            {filtered && <button type="button" className="btn ghost tiny" onClick={() => { setQ(""); setTag(null); setSource(null); }}>CLEAR</button>}
          </div>
          {tags.length > 0 && (
            <div className="pillgroup" role="group" aria-label="Tags">
              {tags.map((t) => (
                <button key={t.tag} type="button" className="pill" aria-pressed={tag === t.tag} onClick={() => setTag(tag === t.tag ? null : t.tag)}>
                  #{t.tag} <span className="dim">{t.n}</span>
                </button>
              ))}
            </div>
          )}
        </section>
      )}

      <section className="sayings" aria-label="Quotes">
        {all.length === 0 ? (
          <div className="panel empty">No quotes yet. <b>+ ADD QUOTE</b> to keep the first one.</div>
        ) : rows.length === 0 ? (
          <div className="panel empty">No quote matches.</div>
        ) : (
          rows.map((s) =>
            editing && editing.kind !== "add" && editing.saying.id === s.id ? (
              <div key={s.id} className="panel saying editing"><div className="body">{form(editing)}</div></div>
            ) : (
              <SayingCard
                key={s.id}
                s={s}
                pending={pending.has(s.id)}
                tag={tag}
                onTag={(t) => setTag(tag === t ? null : t)}
                onSource={(x) => setSource(source?.toLowerCase() === x.toLowerCase() ? null : x)}
                onEdit={() => setEditing({ kind: "edit", saying: s })}
                onRemove={() => setEditing({ kind: "remove", saying: s })}
              />
            ),
          )
        )}
      </section>
    </main>
  );
}

function SayingCard({ s, pending, tag, onTag, onSource, onEdit, onRemove }: {
  s: Saying;
  pending: boolean;
  tag: string | null;
  onTag: (t: string) => void;
  onSource: (s: string) => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const href = safeHref(s.link);
  return (
    <article className="panel saying">
      <blockquote>{s.text}</blockquote>
      <div className="saying-meta">
        {s.source && (
          <button type="button" className="linkish b" onClick={() => onSource(s.source!)} title={`Only quotes from ${s.source}`}>— {s.source}</button>
        )}
        {href && (
          <a href={href} target="_blank" rel="noopener noreferrer" className="small" title={href}>{linkLabel(href)} ↗</a>
        )}
        {(s.tags ?? []).map((t) => (
          <button key={t} type="button" className={`linkish small${tag === t ? " accent" : " muted"}`} onClick={() => onTag(t)}>#{t}</button>
        ))}
        <span className="spacer" />
        {pending && <span className="chip accent" title="Committed; it shows here for good once the site redeploys">DEPLOYING</span>}
        <span className="dim small">{etDate(s.addedAt)}</span>
        <button type="button" className="btn ghost tiny" onClick={onEdit}>EDIT</button>
        <button type="button" className="btn ghost tiny" onClick={onRemove} aria-label="Remove this quote">REMOVE</button>
      </div>
    </article>
  );
}

/** Add, edit or remove one quote. */
function SayingForm({ editing, tags, sources, onCommitted, onClose }: {
  editing: Editing;
  tags: string[];
  sources: string[];
  onCommitted: (c: SayingChange) => void;
  onClose: () => void;
}) {
  const existing = editing.kind === "add" ? null : editing.saying;
  const [base] = useState(() => ({ id: existing?.id ?? newSayingId(), addedAt: existing?.addedAt ?? new Date().toISOString() }));
  const [draft, setDraft] = useState<SayingDraft>(() => draftOf(existing ?? undefined));
  const [busy, setBusy] = useState(false);
  const off = busy || undefined;
  const set = (k: keyof SayingDraft) => (e: { target: { value: string } }) => setDraft({ ...draft, [k]: e.target.value });

  const chosen = parseTags(draft.tags);
  const toggleTag = (t: string) => {
    const next = chosen.includes(t) ? chosen.filter((x) => x !== t) : [...chosen, t];
    setDraft({ ...draft, tags: next.join(", ") });
  };

  let change: SayingChange | null = null;
  let error: string | null = null;
  if (editing.kind === "remove") change = { kind: "remove", id: editing.saying.id };
  else {
    const s = sayingFromDraft(draft, base);
    if (typeof s === "string") error = s;
    else change = { kind: "put", saying: s };
  }

  return (
    <div className="symmap saying-form" role="group" aria-label={editing.kind === "add" ? "New quote" : editing.kind === "edit" ? "Edit quote" : "Remove quote"}>
      {editing.kind === "remove" ? (
        <>
          <blockquote>{editing.saying.text}</blockquote>
          <div className="text-2">Remove this quote{editing.saying.source ? ` from ${editing.saying.source}` : ""}?</div>
        </>
      ) : (
        <>
          <label className="field"><span className="label small">QUOTE</span>
            <textarea className="input" rows={4} value={draft.text} disabled={off} onChange={set("text")} placeholder="What was said, as you'd want to read it again" autoFocus />
          </label>
          <div className="row">
            <label className="field grow"><span className="label small">SOURCE <span className="dim">(optional)</span></span>
              <input className="input" value={draft.source} disabled={off} onChange={set("source")} placeholder="Who said it, or where" list="saying-sources" />
              <datalist id="saying-sources">{sources.map((s) => <option key={s} value={s} />)}</datalist>
            </label>
            <label className="field grow"><span className="label small">LINK <span className="dim">(optional)</span></span>
              <input className="input" type="url" inputMode="url" value={draft.link} disabled={off} onChange={set("link")} placeholder="https://youtube.com/…" />
            </label>
          </div>
          <label className="field"><span className="label small">TAGS <span className="dim">(optional, comma-separated)</span></span>
            <input className="input" value={draft.tags} disabled={off} onChange={set("tags")} placeholder="relative strength, volatility" />
          </label>
          {tags.length > 0 && (
            <div className="pillgroup" role="group" aria-label="Tags used before">
              {tags.map((t) => (
                <button key={t} type="button" className="pill" aria-pressed={chosen.includes(t)} disabled={off} onClick={() => toggleTag(t)}>#{t}</button>
              ))}
            </div>
          )}
        </>
      )}
      {__TJ_DEMO__ ? (
        <div className="row">
          <button type="button" className="btn primary" disabled>COMMIT…</button>
          <span className="note-line">{DEMO_COMMIT_NOTE}</span>
          <button type="button" className="btn ghost" onClick={onClose}>CANCEL</button>
        </div>
      ) : (
        <SayingCommit change={change} error={error} onBusy={setBusy} onCommitted={onCommitted} onClose={onClose} />
      )}
    </div>
  );
}

type Remote = import("../remote").RemoteHistory;
type Phase =
  | { kind: "edit"; error?: string }
  | { kind: "reading" }
  | { kind: "review"; plan: SayingCommitPlan; remote: Remote; notice?: string }
  | { kind: "committing" };

/** Read trade-history fresh, preview, then commit (never rendered in the demo). */
function SayingCommit({ change, error, onBusy, onCommitted, onClose }: {
  change: SayingChange | null;
  error: string | null;
  onBusy: (busy: boolean) => void;
  onCommitted: (c: SayingChange) => void;
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
      setPhase({ kind: "review", plan: remote.computeSaying(r, change), remote: r });
    } catch (e) {
      setPhase({ kind: "edit", error: (e as Error).message });
    }
  };

  const commit = async (p: Extract<Phase, { kind: "review" }>) => {
    if (!change) return;
    setPhase({ kind: "committing" });
    try {
      const remote = await import("../remote");
      const out = await remote.commitSaying(clientFor(record).gh, p.remote, p.plan, change);
      if (out.commit) {
        const site = feedsSite(record);
        watchDeploy({
          label: "Quote committed",
          want: site ? { sha: out.commit.sha, date: out.commit.date } : { date: out.commit.date },
          link: `${ACTIONS_URL}/workflows/deploy.yml`,
          commitUrl: out.commit.url,
          note: site ? undefined : `Committed to ${record.repo}, which the site doesn't read; the reload shows the same data.`,
        });
        onCommitted(change);
      }
      onBusy(false);
      onClose();
    } catch (e) {
      const err = e as Error & { plan?: SayingCommitPlan; remote?: Remote };
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
      return (
        <div className="commit-review" role="group" aria-label="Commit preview">
          {notice && <div className="half small">{notice}</div>}
          <div><span className="label small">COMMIT PREVIEW</span> against {record.repo} main @ <code>{remote.state.headSha.slice(0, 7)}</code></div>
          <div className="muted">sayings.json: {plan.sayings.sayings.length} quote{plan.sayings.sayings.length === 1 ? "" : "s"}{none ? " (unchanged)" : ""}</div>
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
            <button type="button" className="btn primary" disabled={reading} onClick={() => void review()}>{reading ? "READING…" : change?.kind === "remove" ? "REMOVE…" : "COMMIT…"}</button>
            <button type="button" className="btn ghost" disabled={reading} onClick={onClose}>CANCEL</button>
          </div>
          {phase.kind === "edit" && phase.error && <div className="loss small">{phase.error}</div>}
        </>
      );
    }
  }
}
