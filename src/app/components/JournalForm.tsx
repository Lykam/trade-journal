// Write a Playbook review in the app itself, instead of through the
// playbook-review Claude Code skill (prototype for the in-app journal, Q80).
// Covers the skill's text sections only (SKILL.md Steps 2-5): the header fields
// come from the idea, so they're never asked, and Finviz context is left for a
// later terminal-side sync — see Context's note below. Chart images reuse
// ChartUpload (Q78) rather than a new upload path.
import { useState } from "react";
import { blankAnswers, commitReview, reviewPath, type ReviewAnswers } from "../../core/reviews/draft";
import { GitHubClient } from "../../core/github/client";
import { DEMO_COMMIT_NOTE } from "../demo-text";
import type { Idea } from "../../core/types";
import { ACTIONS_URL, PLAYBOOK_REPO, useToken, watchDeploy } from "../github";
import { ChartUpload } from "./ChartUpload";

type Phase = { kind: "idle" } | { kind: "committing" } | { kind: "error"; message: string } | { kind: "done"; path: string; url: string };

function Field({ label, hint, value, onChange, rows = 3, readOnly }: {
  label: string;
  hint?: string;
  value: string;
  onChange?: (v: string) => void;
  rows?: number;
  readOnly?: boolean;
}) {
  return (
    <div className="field">
      <label className="label small" htmlFor={`jf-${label}`}>{label.toUpperCase()}</label>
      {hint && <span className="dim small">{hint}</span>}
      <textarea
        id={`jf-${label}`}
        className="input"
        rows={rows}
        value={value}
        readOnly={readOnly}
        placeholder={readOnly ? undefined : "…"}
        onChange={(e) => onChange?.(e.target.value)}
      />
    </div>
  );
}

export function JournalForm({ idea, existingReviewPaths, existingImages, onDone }: {
  idea: Idea;
  /** Review paths already in Playbook, for picking a fresh file name. */
  existingReviewPaths: string[];
  /** Playbook image paths, for the chart upload's name preview. */
  existingImages: string[];
  onDone?: () => void;
}) {
  const [a, setA] = useState<ReviewAnswers>(blankAnswers);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const day = idea.style === "day";
  const closed = idea.status === "closed";
  const set = <K extends keyof ReviewAnswers>(k: K) => (v: string) => setA((s) => ({ ...s, [k]: v }));
  const busy = phase.kind === "committing";

  const path = reviewPath(existingReviewPaths, idea.date, idea.underlying);

  return (
    <fieldset className="plain journal-form" disabled={busy}>
      <div className="row">
        <span className="muted small">
          {idea.underlying} · {idea.date} · {day ? "DAY" : "SWING"} · {closed ? "CLOSED" : "OPEN (entry phase only — exit sections appear once it closes)"}
        </span>
      </div>

      <Field label="Category" hint="Intraday, breaking news, IPO, imbalance, swing…" value={a.category} onChange={set("category")} rows={1} />
      <Field label="Context" hint="News, market backdrop, why it was in play, float/short interest. Finviz stats are added later by a sync step, not here." value={a.context} onChange={set("context")} />

      {!day && (
        <>
          <Field label="Daily Chart" hint="What was it doing, volume?" value={a.dailyChart} onChange={set("dailyChart")} />
          <ChartUpload dates={[idea.date]} defaultDate={idea.date} symbols={[idea.underlying]} defaultKind="daily" existing={existingImages} />
        </>
      )}

      <Field label="Intraday Chart" hint="Action, volume, support/resistance, any gap?" value={a.intradayChart} onChange={set("intradayChart")} />
      <ChartUpload dates={[idea.date]} defaultDate={idea.date} symbols={[idea.underlying]} defaultKind={day ? "5m" : "daily"} existing={existingImages} />

      {day && <Field label="Level 2" hint="Big buyers/sellers, lifting offers vs hitting bids?" value={a.level2} onChange={set("level2")} />}

      <Field label="How I Traded It" hint="Followed your system? Entries/exits, emotions, size and execution?" value={a.howTraded} onChange={set("howTraded")} />

      {closed ? (
        <>
          <Field label="How It Resolved" hint="What the stock did after the exit — kept going, reversed, chopped? Was the exit right?" value={a.howResolved} onChange={set("howResolved")} />
          {idea.netPnl >= 0 ? (
            <Field label="The Error" value="Not applicable — the trade made money." readOnly rows={1} />
          ) : (
            <Field label="The Error" hint="One short line, in your own words." value={a.error} onChange={set("error")} rows={1} />
          )}
          <Field label="How I Should Have Traded It" hint="Ideal size, entry/exit, any reason to call an audible?" value={a.howShouldHaveTraded} onChange={set("howShouldHaveTraded")} />
          <Field label="How to Find More of These Opportunities" hint="Scanners, tech, collaboration?" value={a.howToFindMore} onChange={set("howToFindMore")} />
          <Field label="Solutions & Lessons Learned" hint="What to take away, what went well, what to change?" value={a.lessons} onChange={set("lessons")} />
        </>
      ) : (
        <div className="empty small">This swing position is still open. Save the entry now; come back once it closes to finish the exit sections.</div>
      )}

      <div className="muted small">Saves as <code>{path}</code> in {PLAYBOOK_REPO.repo}</div>
      <div className="row">
        {__TJ_DEMO__ ? (
          <>
            <button type="button" className="btn primary" disabled>SAVE REVIEW TO PLAYBOOK…</button>
            <span className="note-line">{DEMO_COMMIT_NOTE}</span>
          </>
        ) : (
          <SaveButton
            idea={idea}
            answers={a}
            onPhase={(next) => {
              setPhase(next);
              if (next.kind === "done") onDone?.();
            }}
          />
        )}
        <button type="button" className="btn ghost" disabled={busy} onClick={() => setA(blankAnswers)}>CLEAR</button>
      </div>
      {phase.kind === "error" && <div className="loss small" role="alert">{phase.message}</div>}
      {phase.kind === "done" && (
        <div className="row" role="status">
          <span className="gain small">COMMITTED <code>{phase.path}</code> · <a href={phase.url} target="_blank" rel="noopener noreferrer">VIEW COMMIT ↗</a></span>
          <span className="dim small">It shows here after the redeploy. Still missing Finviz context — run the sync step once for it.</span>
        </div>
      )}
    </fieldset>
  );
}

function SaveButton({ idea, answers, onPhase }: { idea: Idea; answers: ReviewAnswers; onPhase: (p: Phase) => void }) {
  const token = useToken();
  if (token.status !== "ok") {
    return <span className="dim small">{token.status === "loading" ? "…" : <>To save, add a GitHub token in <a href="#/settings">SETTINGS</a>.</>}</span>;
  }
  const save = async () => {
    onPhase({ kind: "committing" });
    try {
      const out = await commitReview(new GitHubClient(token.record.token), PLAYBOOK_REPO, idea, answers);
      watchDeploy({ label: "Review committed", want: { date: out.date }, link: `${ACTIONS_URL}/workflows/deploy.yml`, commitUrl: out.url });
      onPhase({ kind: "done", path: out.path, url: out.url });
    } catch (e) {
      onPhase({ kind: "error", message: (e as Error).message });
    }
  };
  return <button type="button" className="btn primary" onClick={save}>SAVE REVIEW TO {PLAYBOOK_REPO.repo.toUpperCase()}</button>;
}
