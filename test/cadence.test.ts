// Review cadence (SPEC §6.7i, Q89–Q92): entry files, calendar marks, the
// streak, the day's facts, and saves to a fake Playbook. Synthetic data only.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// The save button's token hook reads browser storage; rendering on the server only needs it absent.
vi.mock("../src/app/github", async (orig) => ({ ...(await orig<typeof import("../src/app/github")>()), useToken: () => ({ status: "loading" }) }));
import { CalendarPage } from "../src/app/pages/CalendarPage";
import { DayPage } from "../src/app/pages/DayPage";
import { MonthPage, WeekPage } from "../src/app/pages/PeriodPages";
import { defaultView } from "../src/core/journal/filter";
import { generateDemo } from "../src/demo/generate";
import { EntryError, commitEntry, entryMessage } from "../src/core/cadence/commit";
import { dayFacts } from "../src/core/cadence/day";
import {
  buildEntry, dayStatus, draftOf, entryKeyOf, entryPath, mondayOf, moodOf, parseEntry, readEntries, validKey, type Entries,
} from "../src/core/cadence/entries";
import { dayMark, monthMark, streak, tradingDays, weekMark, weekOfRow } from "../src/core/cadence/status";
import { GitHubClient } from "../src/core/github/client";
import { bestWorst, monthFacts, periodIdeas, weekErrors } from "../src/core/cadence/period";
import { buildJournal, errorTable, playExamples } from "../src/core/journal/journal";
import { blankAnswers, buildQuickReviewMarkdown } from "../src/core/reviews/draft";
import type { Idea, ReviewFile } from "../src/core/types";
import { config } from "./helpers";
import { closed, ideasOf } from "./factory";
import { FakeGitHub, TOKEN } from "./fake-github";

const at = (date: string, time = "10:00") => `${date}T${time}:00-05:00`;
const daily = (date: string, fields: Record<string, string>, answers: Record<string, string>): ReviewFile => ({
  path: entryPath("daily", date),
  markdown: buildEntry("daily", date, { fields, answers }),
});

describe("entry files", () => {
  it("keys and paths", () => {
    expect(entryPath("daily", "2026-11-27")).toBe("Journal/Daily/2026-11-27.md");
    expect(entryPath("weekly", "2026-11-23")).toBe("Journal/Weekly/2026-11-23.md");
    expect(entryPath("monthly", "2026-11")).toBe("Journal/Monthly/2026-11.md");
    expect(mondayOf("2026-11-29")).toBe("2026-11-23"); // Sunday belongs to the week before
    expect(validKey("weekly", "2026-11-24")).toBe(false);
    expect(validKey("monthly", "2026-13")).toBe(false);
    expect(entryKeyOf("Journal/Weekly/2026-11-23.md")).toEqual({ period: "weekly", key: "2026-11-23" });
    expect(entryKeyOf("Journal/Daily/notes.md")).toBeNull();
    expect(entryKeyOf("Reviews/2026-11-27-ZZTA.md")).toBeNull();
    // Sunday-start calendar rows and Monday-start rows map to the same week.
    expect(weekOfRow("2026-11-22")).toBe("2026-11-23");
    expect(weekOfRow("2026-11-23")).toBe("2026-11-23");
  });

  it("builds a daily file that parses back, leaving empty parts out", () => {
    const md = buildEntry("daily", "2026-11-27", {
      fields: { "Market Mood": "CHOPPY", Snapshot: "", "Risk Plan Followed": "" },
      answers: { "Market Going In": "Futures flat.\nQuiet tape.", "Fix for Tomorrow": "" },
    });
    expect(md).toBe(`# Daily Journal — 2026-11-27

**Date:** 2026-11-27
**Market Mood:** CHOPPY

## Market Going In

Futures flat.
Quiet tape.
`);
    const e = parseEntry({ path: entryPath("daily", "2026-11-27"), markdown: md })!;
    expect(moodOf(e)).toBe("CHOPPY");
    expect(draftOf("daily", e).answers["Market Going In"]).toBe("Futures flat.\nQuiet tape.");
    expect(dayStatus(e)).toBe("morning");
  });

  it("parses hand edits and keeps sections it doesn't ask about", () => {
    const md = "# Daily Journal — 2026-11-27\r\n\r\n**Date:** 2026-11-27\r\n**market mood:** weak\r\n\r\n## best trade & why\r\n\r\nZZTA. <!-- note -->\r\n\r\n## Extra Notes\r\n\r\nKeep me.\r\n";
    const e = parseEntry({ path: "Journal/Daily/2026-11-27.md", markdown: md })!;
    expect(moodOf(e)).toBe("WEAK");
    expect(dayStatus(e)).toBe("done");
    const d = draftOf("daily", e);
    expect(d.answers["Best Trade & Why"]).toBe("ZZTA.");
    const out = buildEntry("daily", "2026-11-27", d, e);
    expect(out).toContain("## Best Trade & Why\n\nZZTA.");
    expect(out).toContain("## Extra Notes\n\nKeep me.");
  });

  it("titles weekly and monthly files", () => {
    expect(buildEntry("weekly", "2026-11-23", { fields: {}, answers: { "What I Did Well": "Waited." } })).toMatch(/^# Weekly Review — week of 2026-11-23\n\n\*\*Week:\*\* 2026-11-23\n/);
    expect(buildEntry("monthly", "2026-11", { fields: {}, answers: { Keep: "ORB." } })).toMatch(/^# Monthly Review — November 2026\n\n\*\*Month:\*\* 2026-11\n/);
  });
});

describe("calendar marks and streak", () => {
  // Traded Mon 11-16 … Fri 11-20 and Mon 11-23 … Wed 11-25; today Thu 11-26.
  const days = ["2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20", "2026-11-23", "2026-11-24", "2026-11-25"];
  const traded = tradingDays(days.map((d) => closed({ closedAt: at(d), net: 1 })));
  const done = { "Risk Plan Followed": "YES" };
  const entries: Entries = readEntries([
    daily("2026-11-16", done, {}),
    daily("2026-11-17", done, {}),
    daily("2026-11-19", {}, { "Market Going In": "x" }), // morning only
    daily("2026-11-20", done, {}),
    daily("2026-11-23", done, {}),
    daily("2026-11-24", {}, { Forced: "One." }),
    daily("2026-11-25", done, {}),
    { path: entryPath("weekly", "2026-11-16"), markdown: buildEntry("weekly", "2026-11-16", { fields: {}, answers: { Keep: "", "What I Did Well": "x" } }) },
  ]);
  const today = "2026-11-26";

  it("marks days", () => {
    expect(tradingDays([closed({ closedAt: at("2026-11-16"), net: 0 })]).has("2026-11-16")).toBe(true);
    expect(dayMark("2026-11-16", today, entries, traded)).toBe("done");
    expect(dayMark("2026-11-18", today, entries, traded)).toBe("missed");
    expect(dayMark("2026-11-19", today, entries, traded)).toBe("missed"); // past and only the morning
    expect(dayMark("2026-11-26", today, entries, traded)).toBe("today");
    expect(dayMark("2026-11-21", today, entries, traded)).toBe("none"); // no trades
    expect(dayMark("2026-11-27", "2026-11-27", readEntries([daily("2026-11-27", { "Market Mood": "STRONG" }, {})]), traded)).toBe("morning");
  });

  it("marks weeks and months", () => {
    expect(weekMark("2026-11-16", today, entries, traded)).toBe("done");
    expect(weekMark("2026-11-23", today, entries, traded)).toBe("open");
    expect(weekMark("2026-11-09", today, entries, traded)).toBe("none");
    expect(weekMark("2026-11-23", "2026-12-01", entries, traded)).toBe("missed");
    expect(monthMark("2026-11", today, entries, traded)).toBe("open");
    expect(monthMark("2026-11", "2026-12-02", entries, traded)).toBe("missed");
    expect(monthMark("2026-12", "2026-12-02", entries, traded)).toBe("none");
  });

  it("counts the streak back from the last trading day, and today never breaks it", () => {
    // 11-25, 11-24 (report field), 11-23, 11-20 done; 11-19 only the morning.
    expect(streak(today, entries, traded)).toBe(4);
    const withToday = tradingDays([...days, today].map((d) => closed({ closedAt: at(d), net: 1 })));
    expect(streak(today, entries, withToday)).toBe(4);
    expect(streak("2026-11-18", entries, traded)).toBe(2);
  });
});

describe("the day's facts", () => {
  it("books each idea's P&L on the day and totals P&L after the first loss", () => {
    const d = "2026-11-24";
    const trades = [
      closed({ symbol: "ZZTA", openedAt: at(d, "09:31"), closedAt: at(d, "09:40"), net: 40 }),
      closed({ symbol: "ZZTB", openedAt: at(d, "09:45"), closedAt: at(d, "09:50"), net: -25 }),
      closed({ symbol: "ZZTC", openedAt: at(d, "10:05"), closedAt: at(d, "10:20"), net: -10 }),
      closed({ symbol: "ZZTD", openedAt: at(d, "10:30"), closedAt: at(d, "10:40"), net: 5 }),
      closed({ symbol: "ZZTE", openedAt: at("2026-11-23"), closedAt: at("2026-11-23"), net: 99 }),
    ];
    const ideaById = new Map(ideasOf(trades).map((i) => [i.id, i]));
    const f = dayFacts(d, trades, ideaById);
    expect(f.pnl).toBe(10);
    expect(f.trades).toBe(4);
    expect(f.ideas.map((i) => i.idea.underlying)).toEqual(["ZZTA", "ZZTB", "ZZTC", "ZZTD"]);
    expect(f.best?.idea.underlying).toBe("ZZTA");
    expect(f.worst?.idea.underlying).toBe("ZZTB");
    expect(f.afterFirstLoss).toEqual({ pnl: -5, ideas: 2 });
    expect(dayFacts("2026-11-25", trades, ideaById)).toMatchObject({ pnl: 0, trades: 0, best: null, worst: null, afterFirstLoss: null });
  });
});

const lastMessage = (fake: FakeGitHub) => fake.commits.get(fake.head)!.message;

describe("saving an entry", () => {
  const REPO = { owner: "tester", repo: "history-sandbox" };
  const path = entryPath("daily", "2026-11-27");
  const v1 = buildEntry("daily", "2026-11-27", { fields: { "Market Mood": "STRONG" }, answers: {} });
  const v2 = buildEntry("daily", "2026-11-27", { fields: { "Market Mood": "STRONG", "Risk Plan Followed": "YES" }, answers: {} });

  it("adds a new file, then edits it from the loaded copy", async () => {
    const fake = new FakeGitHub({ "Template.md": "# T" });
    const gh = new GitHubClient(TOKEN, fake.fetch);
    await commitEntry(gh, REPO, path, v1, null);
    expect(fake.text(path)).toBe(v1);
    expect(lastMessage(fake)).toBe("Add daily journal 2026-11-27 (written in the journal)");
    await commitEntry(gh, REPO, path, v2, v1);
    expect(fake.text(path)).toBe(v2);
    expect(lastMessage(fake)).toBe("Edit daily journal 2026-11-27 (edited in the journal)");
  });

  it("refuses to overwrite a copy changed elsewhere, or a new file someone else made", async () => {
    const fake = new FakeGitHub({ "Template.md": "# T" });
    const gh = new GitHubClient(TOKEN, fake.fetch);
    await commitEntry(gh, REPO, path, v2, null);
    await expect(commitEntry(gh, REPO, path, v1, null)).rejects.toThrow(EntryError);
    await expect(commitEntry(gh, REPO, path, "# changed\n", v1)).rejects.toThrow(/changed in tester\/history-sandbox/);
    expect(fake.text(path)).toBe(v2);
  });

  it("names weekly and monthly commits", () => {
    expect(entryMessage(entryPath("weekly", "2026-11-23"), true)).toBe("Add weekly review, week of 2026-11-23 (written in the journal)");
    expect(entryMessage(entryPath("monthly", "2026-11"), false)).toBe("Edit monthly review 2026-11 (edited in the journal)");
  });
});

describe("quick reviews, play examples, week and month facts", () => {
  const d1 = "2026-11-16";
  const d2 = "2026-11-17";
  const trades = [
    closed({ symbol: "ZZTA", openedAt: at(d1, "09:31"), closedAt: at(d1, "09:40"), net: 40 }),
    closed({ symbol: "ZZTB", openedAt: at(d1, "09:45"), closedAt: at(d1, "09:50"), net: -25 }),
    closed({ symbol: "ZZTC", openedAt: at(d2, "09:35"), closedAt: at(d2, "09:50"), net: -10 }),
  ];
  const ideas = ideasOf(trades);
  const [a, b, c] = ideas as [Idea, Idea, Idea];
  const quick = (idea: Idea, o: Partial<typeof blankAnswers>) => ({
    path: `Reviews/${idea.date}-${idea.underlying}.md`,
    markdown: buildQuickReviewMarkdown(idea, { ...blankAnswers, ...o }),
  });
  const reviews = [
    quick(a, { play: "Opening Range Break", grade: "a", sizeMatched: "yes", seeIt: "Held VWAP." }),
    quick(b, { play: "opening  range break", grade: "B", error: "Chased the open" }),
    quick(c, { play: "VWAP Reclaim", grade: "C", error: "Chased the open." }),
  ];
  const j = buildJournal({ derived: { generated: true, generator: "test", trades, ideas }, symbols: {}, config, playbook: { reviews, images: [] } }, "2026-11-26");

  it("writes a quick review the journal reads", () => {
    const md = reviews[0]!.markdown;
    expect(md).toContain("**Review:** Quick\n**Play:** Opening Range Break\n**Grade:** A\n**Size Matched Grade:** YES\n");
    expect(md).toContain("## Category\n\nOpening Range Break\n");
    expect(md).toContain("## See-It Moment\n\nHeld VWAP.\n");
    expect(md).toContain("## The Error\n\nNo error.\n"); // a win with no error written
    expect(buildQuickReviewMarkdown(b, blankAnswers)).toContain("## The Error\n\n(not answered)\n"); // a loss stays open for ERRORS
    const r = j.reviews.reviews.find((x) => x.ticker === "ZZTA")!;
    expect(r.header).toMatchObject({ play: "Opening Range Break", grade: "A", quick: true, category: "Opening Range Break", noError: true });
    expect(errorTable(j).map((e) => e.error)).toEqual(["Chased the open.", "Chased the open"]);
  });

  it("lists a play's examples, case- and space-insensitive", () => {
    expect(playExamples(j, "Opening Range Break").map((e) => [e.idea?.underlying, e.grade])).toEqual([["ZZTB", "B"], ["ZZTA", "A"]]);
    expect(playExamples(j, "")).toEqual([]);
  });

  it("lays out the week: best / worst and repeated errors", () => {
    const ideasInWeek = periodIdeas(j, "2026-11-16", "2026-11-22");
    const { best, worst } = bestWorst(ideasInWeek);
    expect(best.map((p) => p.idea.underlying)).toEqual(["ZZTA"]);
    expect(worst.map((p) => p.idea.underlying)).toEqual(["ZZTB", "ZZTC"]);
    const errs = weekErrors(j, "2026-11-16");
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatchObject({ repeat: true });
    expect(errs[0]!.reviews).toHaveLength(2);
    expect(weekErrors(j, "2026-11-23")).toEqual([]);
  });

  it("groups the month by play, grade, mood and error, with coverage", () => {
    const entries = readEntries([daily(d1, { "Market Mood": "CHOPPY", "Risk Plan Followed": "YES" }, {})]);
    const f = monthFacts(j, "2026-11", entries, tradingDays(trades));
    expect(f).toMatchObject({ pnl: 5, ideas: 3, wins: 1 });
    expect(f.byPlay).toEqual([
      { label: "Opening Range Break", ideas: 2, wins: 1, pnl: 15 },
      { label: "VWAP Reclaim", ideas: 1, wins: 0, pnl: -10 },
    ]);
    expect(f.byMood.map((g) => g.label)).toEqual(["CHOPPY", "(no mood)"]);
    expect(f.byGrade.map((g) => g.label)).toEqual(["A", "C", "B"]);
    expect(f.byError).toEqual([{ label: "Chased the open", ideas: 2, wins: 0, pnl: -35 }]);
    expect(f.coverage).toEqual({ days: 2, daysDone: 1, weeks: 1, weeksDone: 0 });
  });
});

describe("pages render on the demo data", () => {
  const NOW = "2026-11-25T15:00:00-05:00";
  const { bundle } = generateDemo(NOW);
  const j = buildJournal(bundle, "2026-11-25");
  const view = defaultView();

  it("demo has entries for each period", () => {
    const e = readEntries(bundle.playbook!.journal);
    expect(e.daily.size).toBeGreaterThan(5);
    expect(e.weekly.size).toBeGreaterThan(0);
  });

  it("calendar REVIEW view marks days and links to them", () => {
    const html = renderToStaticMarkup(createElement(CalendarPage, { data: bundle, journal: j, view, params: new URLSearchParams("mode=review&month=2026-11") }));
    expect(html).toContain("STREAK");
    expect(html).toContain("#/day/2026-11-");
    expect(html).toContain("#/week/");
    expect(html).toContain("#/month/2026-11");
    expect(html).toMatch(/rv-(done|missed)/);
    const pnl = renderToStaticMarkup(createElement(CalendarPage, { data: bundle, journal: j, view, params: new URLSearchParams("month=2026-11") }));
    expect(pnl).toContain("REVIEW</a>");
  });

  it("day, week and month pages render", () => {
    const traded = [...tradingDays(bundle.derived.trades)].filter((d) => d <= "2026-11-25").sort();
    const day = traded.at(-2)!;
    expect(renderToStaticMarkup(createElement(DayPage, { data: bundle, journal: j, date: day, view, now: NOW }))).toContain("REPORT CARD");
    expect(renderToStaticMarkup(createElement(WeekPage, { data: bundle, journal: j, monday: mondayOf(day), view }))).toContain("FILM STUDY");
    expect(renderToStaticMarkup(createElement(MonthPage, { data: bundle, journal: j, month: "2026-11" }))).toContain("BY MARKET MOOD");
    expect(renderToStaticMarkup(createElement(DayPage, { data: bundle, journal: j, date: "nope", view, now: NOW }))).toContain("Not a date");
  });
});
