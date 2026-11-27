// Write a Playbook review in the app itself, instead of through the
// playbook-review Claude Code skill (prototype for the in-app journal, Q80).
// Covers the skill's text sections only (SKILL.md Steps 2-5): the header fields
// come from the idea, so they're never asked, and Finviz context is left for a
// later terminal-side sync — see Context's note below. Chart images reuse
// ChartUpload (Q78) rather than a new upload path.
import { useState } from "react";
import { answer, moodOf, QUESTIONS, type Entry } from "../../core/cadence/entries";
import { blankAnswers, commitReview, GRADES, reviewPath, type ReviewAnswers, type ReviewMode } from "../../core/reviews/draft";
import type { ChartUpload as Upload } from "../../core/reviews/upload";
import { GitHubClient } from "../../core/github/client";
import { DEMO_COMMIT_NOTE } from "../demo-text";
import type { Idea } from "../../core/types";
import { ACTIONS_URL, PLAYBOOK_REPO, useToken, watchDeploy } from "../github";
import { ChartUpload } from "./ChartUpload";
import { PickRow } from "./EntryForm";

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

/** The day's morning context (§6.7i), read-only above the form so the review doesn't repeat it. */
function MorningContext({ entry, date }: { entry: Entry | null; date: string }) {
  const parts = QUESTIONS.daily.filter((q) => q.part === "morning").map((q) => [q.heading, answer(entry, q.heading)] as const).filter(([, v]) => v);
  const mood = moodOf(entry);
  if (!parts.length && !mood) {
    return <div className="dim small">No morning context for {date}. <a href={`#/day/${date}`}>Write it on the daily journal →</a></div>;
  }
  return (
    <div className="morning-context small" aria-label="Morning context">
      <span className="label small">MORNING CONTEXT</span> {mood && <span className="chip">{mood}</span>} <a className="dim" href={`#/day/${date}`}>daily journal →</a>
      {parts.map(([h, v]) => <div key={h}><span className="muted">{h}:</span> {v}</div>)}
    </div>
  );
}

export function JournalForm({ idea, existingReviewPaths, existingImages, onDone, plays = [], morning = null }: {
  idea: Idea;
  /** Names from PLAYS, offered for the Play field (Q90). */
  plays?: string[];
  /** The idea's day in the daily journal (§6.7i), shown read-only. */
  morning?: Entry | null;
  /** Review paths already in Playbook, for picking a fresh file name. */
  existingReviewPaths: string[];
  /** Playbook image paths, for the chart upload's name preview. */
  existingImages: string[];
  onDone?: () => void;
}) {
  const [a, setA] = useState<ReviewAnswers>(blankAnswers);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [dailyUpload, setDailyUpload] = useState<Upload | null>(null);
  const [intradayUpload, setIntradayUpload] = useState<Upload | null>(null);
  const day = idea.style === "day";
  const closed = idea.status === "closed";
  // QUICK is the default for day trades; swing reviews stay FULL (Q70, Q90).
  const [mode, setMode] = useState<ReviewMode>(day ? "quick" : "full");
  const set = <K extends keyof ReviewAnswers>(k: K) => (v: string) => setA((s) => ({ ...s, [k]: v }));
  const busy = phase.kind === "committing";
  const charts = (mode === "quick" ? [intradayUpload] : [dailyUpload, intradayUpload]).filter((u): u is Upload => u !== null);

  const path = reviewPath(existingReviewPaths, idea.date, idea.underlying);

  return (
    <fieldset className="plain journal-form" disabled={busy}>
      <div className="row">
        <span className="muted small">
          {idea.underlying} · {idea.date} · {day ? "DAY" : "SWING"} · {closed ? "CLOSED" : "OPEN (entry phase only — exit sections appear once it closes)"}
        </span>
      </div>

      <div className="seg" role="group" aria-label="Review form">
        <button type="button" className="segl" aria-pressed={mode === "quick"} onClick={() => setMode("quick")}>QUICK</button>
        <button type="button" className="segl" aria-pressed={mode === "full"} onClick={() => setMode("full")}>FULL</button>
      </div>
      <MorningContext entry={morning} date={idea.date} />

      <div className="field">
        <label className="label small" htmlFor="jf-play">PLAY</label>
        <span className="dim small">Which play from PLAYS was it? Its page lists every review that names it.</span>
        <input id="jf-play" className="input" list="jf-plays" value={a.play} placeholder="…" onChange={(e) => set("play")(e.target.value)} />
        <datalist id="jf-plays">{plays.map((p) => <option key={p} value={p} />)}</datalist>
      </div>
      <PickRow pick={{ field: "grade", label: "GRADE", options: GRADES, hint: "How good was the setup, whatever the result?" }} value={a.grade} onChange={set("grade")} />
      <PickRow pick={{ field: "size", label: "SIZE MATCHED GRADE", options: ["YES", "NO"], hint: "Sized like an A on a B?" }} value={a.sizeMatched} onChange={set("sizeMatched")} />

      {mode === "quick" ? (
        <>
          <Field label="See-It Moment" hint="When should you have known it wasn't acting right? Or: when did it confirm and you held?" value={a.seeIt} onChange={set("seeIt")} />
          {closed && <Field label="The Error" hint={idea.netPnl >= 0 ? "Any error, even on a win. Blank saves “No error.”" : "One short line, in your own words."} value={a.error} onChange={set("error")} rows={1} />}
          <ChartUpload
            dates={[idea.date]} defaultDate={idea.date} symbols={[idea.underlying]} defaultKind="5m" existing={existingImages}
            deferred onPicked={setIntradayUpload}
          />
        </>
      ) : (
      <>
      <Field label="Category" hint="Intraday, breaking news, IPO, imbalance, swing…" value={a.category} onChange={set("category")} rows={1} />
      <Field label="Context" hint="News, market backdrop, why it was in play, float / short interest. Finviz stats come later from the sync step." value={a.context} onChange={set("context")} />

      {!day && (
        <>
          <Field label="Daily Chart" hint="What was it doing, volume?" value={a.dailyChart} onChange={set("dailyChart")} />
          <ChartUpload
            dates={[idea.date]} defaultDate={idea.date} symbols={[idea.underlying]} defaultKind="daily" existing={existingImages}
            deferred onPicked={setDailyUpload}
          />
        </>
      )}

      <Field label="Intraday Chart" hint="Action, volume, support/resistance, any gap?" value={a.intradayChart} onChange={set("intradayChart")} />
      <ChartUpload
        dates={[idea.date]} defaultDate={idea.date} symbols={[idea.underlying]} defaultKind="5m" existing={existingImages}
        deferred onPicked={setIntradayUpload}
      />

      {day && <Field label="Level 2" hint="Big buyers/sellers, lifting offers vs hitting bids?" value={a.level2} onChange={set("level2")} />}

      <Field label="How I Traded It" hint="Followed your system? Entries/exits, emotions, size and execution?" value={a.howTraded} onChange={set("howTraded")} />
      <Field label="See-It Moment" hint="When should you have known it wasn't acting right?" value={a.seeIt} onChange={set("seeIt")} />

      {closed ? (
        <>
          <Field label="How It Resolved" hint="What it did after the exit. Kept going, reversed, chopped? Was the exit right?" value={a.howResolved} onChange={set("howResolved")} />
          {idea.netPnl >= 0 ? (
            <Field label="The Error" value="N/A. The trade made money." readOnly rows={1} />
          ) : (
            <Field label="The Error" hint="One short line, in your own words." value={a.error} onChange={set("error")} rows={1} />
          )}
          <Field label="How I Should Have Traded It" hint="Ideal size, entry/exit, any reason to call an audible?" value={a.howShouldHaveTraded} onChange={set("howShouldHaveTraded")} />
          <Field label="How to Find More of These Opportunities" hint="Scanners, tech, collaboration?" value={a.howToFindMore} onChange={set("howToFindMore")} />
          <Field label="Solutions & Lessons Learned" hint="What to take away, what went well, what to change?" value={a.lessons} onChange={set("lessons")} />
        </>
      ) : (
        <div className="empty small">Still open. Save the entry now and finish the exit sections after it closes.</div>
      )}
      </>
      )}

      <div className="muted small">
        Saves as <code>{path}</code>{charts.length ? ` + ${charts.length} chart${charts.length === 1 ? "" : "s"}` : ""} in {PLAYBOOK_REPO.repo}, in one commit
      </div>
      <div className="row">
        {__TJ_DEMO__ ? (
          <>
            <button type="button" className="btn primary" disabled>SAVE REVIEW TO PLAYBOOK…</button>
            <span className="note-line">{DEMO_COMMIT_NOTE}</span>
          </>
        ) : (
          <SaveButton
            idea={idea}
            mode={mode}
            answers={a}
            charts={charts}
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
          <span className="dim small">It shows here after the redeploy. Run the sync step once to add Finviz context.</span>
        </div>
      )}
    </fieldset>
  );
}

function SaveButton({ idea, mode, answers, charts, onPhase }: { idea: Idea; mode: ReviewMode; answers: ReviewAnswers; charts: Upload[]; onPhase: (p: Phase) => void }) {
  const token = useToken();
  if (token.status !== "ok") {
    return <span className="dim small">{token.status === "loading" ? "…" : <>To save, add a GitHub token in <a href="#/settings">SETTINGS</a>.</>}</span>;
  }
  const save = async () => {
    onPhase({ kind: "committing" });
    try {
      const out = await commitReview(new GitHubClient(token.record.token), PLAYBOOK_REPO, idea, answers, charts, 3, mode);
      watchDeploy({ label: "Review committed", want: { date: out.date }, link: `${ACTIONS_URL}/workflows/deploy.yml`, commitUrl: out.url });
      onPhase({ kind: "done", path: out.path, url: out.url });
    } catch (e) {
      onPhase({ kind: "error", message: (e as Error).message });
    }
  };
  return <button type="button" className="btn primary" onClick={save}>SAVE REVIEW TO {PLAYBOOK_REPO.repo.toUpperCase()}</button>;
}
