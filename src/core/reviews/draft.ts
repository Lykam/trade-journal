// Writing a Playbook review from the journal app itself, instead of through the
// playbook-review Claude Code skill (SKILL.md in Playbook/.claude/skills). This
// covers only the skill's text sections (Step 2-5 of SKILL.md minus Finviz, which
// stays a terminal-side backfill): the header fields are known from the idea, so
// they're never asked. Chart images are attached with the same ChartUpload
// component Trade detail already uses for Q78, not generated here.
import { commitFiles, GitHubError, readState, RefMovedError, repoName, type CommitResult, type GitHubClient, type RepoId } from "../github/client";
import type { Idea } from "../types";

export interface ReviewAnswers {
  category: string;
  context: string;
  dailyChart: string;
  intradayChart: string;
  level2: string;
  howTraded: string;
  howResolved: string;
  error: string;
  howShouldHaveTraded: string;
  howToFindMore: string;
  lessons: string;
}

export const blankAnswers: ReviewAnswers = {
  category: "", context: "", dailyChart: "", intradayChart: "", level2: "",
  howTraded: "", howResolved: "", error: "", howShouldHaveTraded: "", howToFindMore: "", lessons: "",
};

const money = (n: number) => `${n < 0 ? "-" : "+"}$${Math.abs(n).toFixed(2)}`;

/** "Reviews/<date>-<TICKER>.md", adding -2, -3, … when that name is already in `existing` (chart-image skill convention). */
export function reviewPath(existing: Iterable<string>, date: string, ticker: string): string {
  const taken = new Set([...existing].map((p) => p.toLowerCase()));
  const stem = `Reviews/${date}-${ticker.toUpperCase()}`;
  let path = `${stem}.md`;
  for (let n = 2; taken.has(path.toLowerCase()); n++) path = `${stem}-${n}.md`;
  return path;
}

/**
 * The review markdown, in Template.md's section order. Entry-phase only (Status
 * stays OPEN) for a swing idea still open; otherwise every section, with The
 * Error auto-answered "not applicable" for a non-losing trade (Q77).
 */
export function buildReviewMarkdown(idea: Idea, a: ReviewAnswers): string {
  const closed = idea.status === "closed";
  const day = idea.style === "day";
  const pnl = closed ? money(idea.netPnl) : "open";
  const lines = [
    `# Playbook Review — ${idea.underlying} ${idea.date}`,
    "",
    `**Date:** ${idea.date}`,
    `**Ticker:** ${idea.underlying}`,
    `**P&L:** ${pnl}`,
    `**Trade Type:** ${day ? "DAY TRADE" : "SWING TRADE"}`,
    `**Status:** ${closed ? "CLOSED" : "OPEN"}`,
    `**Idea ID:** ${idea.id}`,
    "",
    "## Category",
    "",
    a.category.trim() || "(not answered)",
    "",
    "## Context",
    "",
    a.context.trim() || "(not answered)",
    "",
    "## Daily Chart",
    "",
    day ? "Not applicable to this trade — day trades don't use the daily chart." : a.dailyChart.trim() || "(not answered)",
    "",
    "## Intraday Chart",
    "",
    a.intradayChart.trim() || "(not answered)",
    "",
    "## Level 2 (if relevant)",
    "",
    day ? a.level2.trim() || "(not answered)" : "Not applicable to this trade — not a consideration for swing trades.",
    "",
    "## How I Traded It",
    "",
    a.howTraded.trim() || "(not answered)",
  ];
  if (closed) {
    lines.push(
      "",
      "## How It Resolved",
      "",
      a.howResolved.trim() || "(not answered)",
      "",
      "## The Error",
      "",
      idea.netPnl >= 0 ? "Not applicable — the trade made money." : a.error.trim() || "(not answered)",
      "",
      "## How I Should Have Traded It",
      "",
      a.howShouldHaveTraded.trim() || "(not answered)",
      "",
      "## How to Find More of These Opportunities",
      "",
      a.howToFindMore.trim() || "(not answered)",
      "",
      "## Solutions & Lessons Learned",
      "",
      a.lessons.trim() || "(not answered)",
    );
  }
  return `${lines.join("\n")}\n`;
}

export const reviewMessage = (idea: Idea, phase: "entry phase, open" | "closed") =>
  `Add ${idea.underlying} ${idea.date} ${idea.style} review (${phase})`;

/** Commit the review to `repo`'s main, picking the file name fresh at commit time so a concurrent write doesn't collide. */
export async function commitReview(gh: GitHubClient, repo: RepoId, idea: Idea, answers: ReviewAnswers, attempts = 3): Promise<CommitResult & { path: string }> {
  const markdown = buildReviewMarkdown(idea, answers);
  const message = reviewMessage(idea, idea.status === "closed" ? "closed" : "entry phase, open");
  for (let i = 1; ; i++) {
    try {
      const state = await readState(gh, repo);
      const path = reviewPath(state.files.keys(), idea.date, idea.underlying);
      const commit = await commitFiles(gh, state, [{ path, content: markdown }], message);
      // A new path always changes the tree, so a commit is always made.
      return { ...commit!, path };
    } catch (e) {
      if (e instanceof RefMovedError && i < attempts) continue;
      throw explain(e, repo);
    }
  }
}

function explain(e: unknown, repo: RepoId): unknown {
  if (!(e instanceof GitHubError)) return e;
  if (e.kind === "not-found") {
    return new Error(`The token can't see ${repoName(repo)}. On GitHub, edit the token: under Repository access add ${repo.repo}, with Contents: read and write.`);
  }
  if (e.kind === "permission") return new Error(`The token can read ${repoName(repo)} but not write to it. Set Contents to read and write for ${repo.repo}.`);
  return e;
}
