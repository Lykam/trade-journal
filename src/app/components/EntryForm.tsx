// The form for a daily / weekly / monthly entry (SPEC §6.7i): header picks and
// one text box per question, saved as the whole file in one Playbook commit.
import { useState } from "react";
import { buildEntry, draftOf, entryPath, QUESTIONS, type Entry, type EntryDraft, type Period, type Question } from "../../core/cadence/entries";
import { setSavedEntry } from "../cadence";
import { DEMO_COMMIT_NOTE } from "../demo-text";
import { ACTIONS_URL, PLAYBOOK_REPO, useToken, watchDeploy } from "../github";

type Phase = { kind: "idle" } | { kind: "saving" } | { kind: "error"; message: string } | { kind: "saved"; url: string };

export interface Pick {
  field: string;
  label: string;
  options: readonly string[];
  hint?: string;
}

/** A row of one-pick buttons; picking the chosen one again clears it. */
export function PickRow({ pick, value, onChange }: { pick: Pick; value: string; onChange: (v: string) => void }) {
  return (
    <div className="field">
      <span className="label small">{pick.label}</span>
      {pick.hint && <span className="dim small">{pick.hint}</span>}
      <div className="seg" role="group" aria-label={pick.label}>
        {pick.options.map((o) => (
          <button key={o} type="button" className="segl" aria-pressed={value.toUpperCase() === o} onClick={() => onChange(value.toUpperCase() === o ? "" : o)}>{o}</button>
        ))}
      </div>
    </div>
  );
}

function QuestionBox({ q, value, onChange }: { q: Question; value: string; onChange: (v: string) => void }) {
  const id = `ef-${q.heading.replace(/\W+/g, "-")}`;
  return (
    <div className="field">
      <label className="label small" htmlFor={id}>{q.heading.toUpperCase()}</label>
      <span className="dim small">{q.hint}</span>
      <textarea id={id} className="input" rows={3} value={value} placeholder="…" onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

/**
 * `parts` splits the questions into titled groups (the daily entry's morning
 * and report card); `picks` sit at the top of the group they're listed under.
 */
export function EntryForm({ period, entryKey, entry, groups, extraFields, aside }: {
  period: Period;
  entryKey: string;
  entry: Entry | null;
  groups: Array<{ title: string; questions: Question[]; picks?: Pick[]; note?: React.ReactNode }>;
  /** Header fields set by the page rather than typed (e.g. the day's Snapshot), merged in on save. */
  extraFields?: Record<string, string>;
  aside?: React.ReactNode;
}) {
  const [draft, setDraft] = useState<EntryDraft>(() => draftOf(period, entry));
  // The file as this page loaded it: a save is refused if Playbook's copy has changed since.
  const [base, setBase] = useState<string | null>(entry?.markdown ?? null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const setAnswer = (h: string) => (v: string) => setDraft((d) => ({ ...d, answers: { ...d.answers, [h]: v } }));
  const setField = (f: string) => (v: string) => setDraft((d) => ({ ...d, fields: { ...d.fields, [f]: v } }));
  const markdown = buildEntry(period, entryKey, { ...draft, fields: { ...draft.fields, ...Object.fromEntries(Object.entries(extraFields ?? {}).filter(([k]) => !draft.fields[k])) } }, entry);
  const path = entryPath(period, entryKey);
  const unchanged = base !== null && markdown.trimEnd() === base.replace(/\r\n/g, "\n").trimEnd();

  return (
    <fieldset className="plain journal-form" disabled={phase.kind === "saving"}>
      {aside}
      {groups.map((g) => (
        <section key={g.title} className="panel entry-group" aria-label={g.title}>
          <div className="panel-head"><h2>{g.title}</h2>{g.note && <span className="muted small">{g.note}</span>}</div>
          {g.picks?.map((p) => <PickRow key={p.field} pick={p} value={draft.fields[p.field] ?? ""} onChange={setField(p.field)} />)}
          {g.questions.map((q) => <QuestionBox key={q.heading} q={q} value={draft.answers[q.heading] ?? ""} onChange={setAnswer(q.heading)} />)}
        </section>
      ))}
      <div className="muted small">Saves as <code>{path}</code> in {PLAYBOOK_REPO.repo}, in one commit. Empty boxes are left out.</div>
      <div className="row">
        {__TJ_DEMO__ ? (
          <>
            <button type="button" className="btn primary" disabled>SAVE</button>
            <span className="note-line">{DEMO_COMMIT_NOTE}</span>
          </>
        ) : (
          <SaveButton path={path} markdown={markdown} base={base} disabled={unchanged || !QUESTIONS[period].some((q) => draft.answers[q.heading]?.trim()) && !Object.values(draft.fields).some((v) => v.trim())}
            onPhase={(p, saved) => {
              setPhase(p);
              if (saved !== undefined) setBase(saved);
            }} />
        )}
        {phase.kind === "saving" && <span className="accent small">SAVING…</span>}
        {unchanged && phase.kind !== "saved" && <span className="dim small">No changes.</span>}
      </div>
      {phase.kind === "error" && <div className="loss small" role="alert">{phase.message}</div>}
      {phase.kind === "saved" && (
        <div className="gain small" role="status">SAVED · <a href={phase.url} target="_blank" rel="noopener noreferrer">VIEW COMMIT ↗</a> <span className="dim">It shows on the calendar now and stays after the redeploy.</span></div>
      )}
    </fieldset>
  );
}

function SaveButton({ path, markdown, base, disabled, onPhase }: {
  path: string; markdown: string; base: string | null; disabled: boolean;
  onPhase: (p: Phase, saved?: string) => void;
}) {
  const token = useToken();
  if (token.status !== "ok") {
    return <span className="dim small">{token.status === "loading" ? "…" : <>To save, add a GitHub token in <a href="#/settings">SETTINGS</a>.</>}</span>;
  }
  if (token.record.playbook === false) {
    return <span className="half small">The saved token can't write to {PLAYBOOK_REPO.repo}. Give it Contents: read and write there, then save it again in <a href="#/settings">SETTINGS</a>.</span>;
  }
  const record = token.record;
  const save = async () => {
    onPhase({ kind: "saving" });
    try {
      const [{ commitEntry }, { GitHubClient }] = await Promise.all([import("../../core/cadence/commit"), import("../../core/github/client")]);
      const out = await commitEntry(new GitHubClient(record.token), PLAYBOOK_REPO, path, markdown, base);
      setSavedEntry(path, markdown);
      watchDeploy({ label: "Journal saved", want: { date: out.date }, link: `${ACTIONS_URL}/workflows/deploy.yml`, commitUrl: out.url });
      onPhase({ kind: "saved", url: out.url }, markdown);
    } catch (e) {
      onPhase({ kind: "error", message: (e as Error).message });
    }
  };
  return <button type="button" className="btn primary" disabled={disabled} onClick={() => void save()}>SAVE</button>;
}
