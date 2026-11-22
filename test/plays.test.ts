// PLAYS (SPEC §6.7e, Q84): the play file format, and commits to a fake Playbook.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PlaysPage } from "../src/app/pages/PlaysPage";
import { GitHubClient } from "../src/core/github/client";
import { commitPlay, playMessage } from "../src/core/plays/commit";
import {
  appendSection, buildPlayMarkdown, checkHeader, creditCounts, filterPlays, LIBRARY, LIBRARY_ROUTINES, ROUTINES, sourceParts, marketCounts, parsePlay, pendingIds, pendingToken, playImagePath, playPath,
  readPlays, replaceHeader, replaceSection, resolvePending, slugify, stripPending, updateTitle, type PlayHeader,
} from "../src/core/plays/plays";
import { generateDemo } from "../src/demo/generate";
import { FakeGitHub, TOKEN } from "./fake-github";

const REPO = { owner: "tester", repo: "history-sandbox" };
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 255]);
const H: PlayHeader = { name: "Gap and Go", markets: ["US small caps", "Premarket gappers"], timeframes: ["1m", "5m"], tactics: ["First 1m new high", "Break of premarket high"] };
const NOW = new Date("2026-11-21T15:00:00Z");

describe("play file format", () => {
  it("builds a file that parses back to the same header and write-up", () => {
    const md = buildPlayMarkdown(H, "2026-11-21", "Long text.\n\nMore.");
    expect(md).toBe(`# Gap and Go

**Created:** 2026-11-21
**Markets:** US small caps, Premarket gappers
**Timeframes:** 1m, 5m
**Entry Tactics:**
- First 1m new high
- Break of premarket high

## Write-up

Long text.

More.
`);
    const p = parsePlay({ path: "Plays/gap-and-go.md", markdown: md });
    expect(p.header).toEqual(H);
    expect(p.slug).toBe("gap-and-go");
    expect(p.created).toBe("2026-11-21");
    expect(p.sections).toEqual([{ title: "Write-up", kind: "writeup", date: null, label: null, body: "Long text.\n\nMore." }]);
  });

  it("appends dated updates, which set LAST UPDATED", () => {
    let md = buildPlayMarkdown(H, "2026-11-01", "w");
    md = appendSection(md, updateTitle("2026-11-10", ""), "first");
    md = appendSection(md, updateTitle("2026-11-20", "Strong tape only"), "second ![x](../Images/plays/gap-and-go/2026-11-20-1.png)");
    const p = parsePlay({ path: "Plays/gap-and-go.md", markdown: md });
    expect(p.sections.map((s) => [s.kind, s.date, s.label])).toEqual([["writeup", null, null], ["update", "2026-11-10", null], ["update", "2026-11-20", "Strong tape only"]]);
    expect(p.updated).toBe("2026-11-20");
    expect(md).toContain("## Update — 2026-11-20 · Strong tape only\n\nsecond");
  });

  it("parses a hand-written file (CRLF, Windows editors, no Created line)", () => {
    const p = parsePlay({ path: "Plays/x.md", markdown: "# VCP\r\n\r\n**Markets:** Stocks\r\n**Entry Tactics:**\r\n* Pivot buy\r\n\r\n## Notes\r\n\r\nhi 2026-01-02\r\n" });
    expect(p.header).toEqual({ name: "VCP", markets: ["Stocks"], timeframes: [], tactics: ["Pivot buy"] });
    expect(p.sections[0]).toMatchObject({ title: "Notes", kind: "other", date: null, body: "hi 2026-01-02" });
  });

  it("replaces the header and keeps every section byte for byte", () => {
    let md = buildPlayMarkdown(H, "2026-11-01", "w");
    md = appendSection(md, updateTitle("2026-11-10", ""), "u");
    const sections = md.slice(md.indexOf("## "));
    const out = replaceHeader(md, { ...H, name: "Gap & Go", tactics: ["Only one"] }, "2026-12-31");
    expect(out.slice(out.indexOf("## "))).toBe(sections);
    expect(parsePlay({ path: "Plays/gap-and-go.md", markdown: out }).header.tactics).toEqual(["Only one"]);
    expect(out).toContain("**Created:** 2026-11-01");
  });

  it("replaces one section by index and title, and refuses when the file moved on", () => {
    let md = buildPlayMarkdown(H, "2026-11-01", "w");
    md = appendSection(md, updateTitle("2026-11-10", ""), "u1");
    md = appendSection(md, updateTitle("2026-11-11", ""), "u2");
    const out = replaceSection(md, 1, "Update — 2026-11-10", "edited");
    const p = parsePlay({ path: "Plays/a.md", markdown: out });
    expect(p.sections.map((s) => s.body)).toEqual(["w", "edited", "u2"]);
    expect(replaceSection(md, 2, "Update — 2026-11-11", "last").endsWith("## Update — 2026-11-11\n\nlast\n")).toBe(true);
    expect(() => replaceSection(md, 1, "Update — 2026-11-11", "x")).toThrow(/changed in Playbook/);
  });

  it("checks the header", () => {
    expect(checkHeader({ ...H, name: " " })).toMatch(/name/);
    expect(checkHeader({ ...H, name: "a\nb" })).toMatch(/one line/);
    expect(checkHeader(H)).toBeNull();
  });
});

describe("play paths", () => {
  it("slugifies names and never reuses a path", () => {
    expect(slugify("Gap & Go!")).toBe("gap-go");
    expect(slugify("Café pullback")).toBe("cafe-pullback");
    expect(slugify("!!!")).toBe("play");
    expect(playPath(["Plays/gap-go.md", "Plays/GAP-GO-2.md"], "Gap & Go")).toBe("Plays/gap-go-3.md");
  });

  it("numbers images per day, in any format", () => {
    const existing = ["Images/plays/gap-go/2026-11-21-1.png", "Images/plays/gap-go/2026-11-21-2.jpg", "Images/plays/other/2026-11-21-3.png"];
    expect(playImagePath(existing, "gap-go", "2026-11-21", "png")).toBe("Images/plays/gap-go/2026-11-21-3.png");
    expect(playImagePath(existing, "gap-go", "2026-11-22", "webp")).toBe("Images/plays/gap-go/2026-11-22-1.webp");
    expect(() => playImagePath([], "../x", "2026-11-21", "png")).toThrow();
  });
});

describe("pending images", () => {
  it("tracks, strips and resolves image tokens", () => {
    const body = `a\n\n${pendingToken(1)}\n\nb\n\n${pendingToken(2)}\n`;
    expect(pendingIds(body)).toEqual([1, 2]);
    expect(stripPending(body, 1)).toBe(`a\n\nb\n\n${pendingToken(2)}\n`);
    const out = resolvePending(stripPending(body, 2), new Map([[1, "Images/plays/x/d-1.png"], [2, "Images/plays/x/d-2.png"]]));
    // 2's token was deleted from the text, but the image is still committed, so it goes on the end.
    expect(out).toBe("a\n\n![image 1](../Images/plays/x/d-1.png)\n\nb\n\n![image 2](../Images/plays/x/d-2.png)");
  });
});

describe("list helpers", () => {
  const plays = readPlays([
    { path: "Plays/a.md", markdown: buildPlayMarkdown({ ...H, name: "Alpha" }, "2026-11-01", "about breakouts") },
    { path: "Plays/b.md", markdown: buildPlayMarkdown({ ...H, name: "Beta", markets: ["us small caps", "Futures"] }, "2026-11-05", "x") },
  ]);
  it("sorts newest first, counts markets case-insensitively (first spelling seen wins), filters", () => {
    expect(plays.map((p) => p.header.name)).toEqual(["Beta", "Alpha"]);
    expect(marketCounts(plays)).toEqual([{ market: "us small caps", n: 2 }, { market: "Futures", n: 1 }, { market: "Premarket gappers", n: 1 }]);
    expect(filterPlays(plays, "breakouts", null).map((p) => p.header.name)).toEqual(["Alpha"]);
    expect(filterPlays(plays, "", "futures").map((p) => p.header.name)).toEqual(["Beta"]);
  });
});

describe("commitPlay (fake Playbook)", () => {
  const gh = (fake: FakeGitHub) => new GitHubClient(TOKEN, fake.fetch);

  it("creates a play with its images in one commit", async () => {
    const fake = new FakeGitHub({ "Template.md": "# T" });
    const before = fake.commitCount();
    const body = `Intro\n\n${pendingToken(7)}\n`;
    const out = await commitPlay(gh(fake), REPO, { kind: "create", header: H, body, images: [{ id: 7, type: "image/png", bytes: PNG }] }, NOW);
    expect(fake.commitCount()).toBe(before + 1);
    expect(out.path).toBe("Plays/gap-and-go.md");
    expect(out.imagePaths).toEqual(["Images/plays/gap-and-go/2026-11-21-1.png"]);
    expect(fake.files()[out.imagePaths[0]!]).toEqual(PNG);
    const md = fake.text(out.path)!;
    expect(md).toBe(out.markdown);
    expect(md).toContain("**Created:** 2026-11-21");
    expect(md).toContain("![image 7](../Images/plays/gap-and-go/2026-11-21-1.png)");
  });

  it("appends to the file as it is on main, not as the page loaded it", async () => {
    const fake = new FakeGitHub({ "Plays/gap-and-go.md": buildPlayMarkdown(H, "2026-11-01", "w") });
    // Someone (a Claude session) edits the write-up after the page loaded.
    fake.push({ "Plays/gap-and-go.md": buildPlayMarkdown(H, "2026-11-01", "w, edited elsewhere") });
    await commitPlay(gh(fake), REPO, { kind: "append", path: "Plays/gap-and-go.md", title: updateTitle("2026-11-21", ""), body: "new", images: [] }, NOW);
    const p = parsePlay({ path: "Plays/gap-and-go.md", markdown: fake.text("Plays/gap-and-go.md")! });
    expect(p.sections.map((s) => s.body)).toEqual(["w, edited elsewhere", "new"]);
  });

  it("retries when main moves during the commit", async () => {
    let pushed = false;
    const fake = new FakeGitHub({ "Plays/a.md": buildPlayMarkdown(H, "2026-11-01", "w") }, {
      beforePatch: (f) => { if (!pushed) { pushed = true; f.push({ "other.txt": "x" }); } },
    });
    await commitPlay(gh(fake), REPO, { kind: "header", path: "Plays/a.md", header: { ...H, name: "Renamed" } }, NOW);
    expect(fake.text("Plays/a.md")).toContain("# Renamed");
    expect(fake.text("other.txt")).toBe("x");
  });

  it("removes a play and its image folder", async () => {
    const fake = new FakeGitHub({
      "Plays/a.md": buildPlayMarkdown(H, "2026-11-01", "w"), "Images/plays/a/2026-11-01-1.png": PNG, "Images/plays/ab/2026-11-01-1.png": PNG,
    });
    const out = await commitPlay(gh(fake), REPO, { kind: "delete", path: "Plays/a.md" }, NOW);
    expect(out.markdown).toBeNull();
    expect(Object.keys(fake.files()).sort()).toEqual(["Images/plays/ab/2026-11-01-1.png"]);
  });

  it("says so when the play is gone", async () => {
    const fake = new FakeGitHub({ "x.md": "x" });
    await expect(commitPlay(gh(fake), REPO, { kind: "append", path: "Plays/a.md", title: "t", body: "b", images: [] }, NOW)).rejects.toThrow(/no longer in Playbook/);
  });
});

describe("demo plays", () => {
  it("ships a few plays whose images are the demo's own charts", () => {
    const { bundle, images } = generateDemo("2026-11-21T15:00:00-05:00");
    const plays = readPlays(bundle.playbook!.plays);
    expect(plays.length).toBeGreaterThan(1);
    for (const p of plays) {
      for (const m of p.markdown.matchAll(/\]\(\.\.\/([^)]+)\)/g)) expect(images[m[1]!]).toBeTruthy();
    }
  });
});

// Someone else's plays (Q87) and routines (Q88).
describe("credited plays", () => {
  const T: PlayHeader = { ...H, name: "Their Gap", credit: "Jane Trader", source: "https://www.youtube.com/watch?v=abc — at 12:30" };

  it("writes Credit and Source under Created, and parses them back", () => {
    const md = buildPlayMarkdown(T, "2026-11-22", "w");
    expect(md).toContain("**Created:** 2026-11-22\n**Credit:** Jane Trader\n**Source:** https://www.youtube.com/watch?v=abc — at 12:30\n**Markets:**");
    expect(parsePlay({ path: "Plays/their-gap.md", markdown: md }).header).toEqual(T);
    // The owner's own plays have neither line.
    expect(buildPlayMarkdown(H, "2026-11-22", "w")).not.toMatch(/Credit|Source/);
    expect(buildPlayMarkdown({ ...H, credit: "Jane", source: "  " }, "2026-11-22", "w")).not.toContain("Source");
  });

  it("asks for a credit once the play is marked someone else's", () => {
    expect(checkHeader({ ...H, credit: " " })).toMatch(/whose play/);
    expect(checkHeader({ ...H, credit: "A", source: "x\ny" })).toMatch(/one line/);
    expect(checkHeader(T)).toBeNull();
  });

  it("filters by whose play it is, and counts people", () => {
    const plays = readPlays([
      { path: "Plays/a.md", markdown: buildPlayMarkdown({ ...H, name: "Mine" }, "2026-11-01", "x") },
      { path: "Plays/b.md", markdown: buildPlayMarkdown({ ...T, name: "Jane 1" }, "2026-11-02", "x") },
      { path: "Plays/c.md", markdown: buildPlayMarkdown({ ...T, name: "Jane 2", credit: "jane trader" }, "2026-11-03", "x") },
      { path: "Plays/d.md", markdown: buildPlayMarkdown({ ...T, name: "Bob's", credit: "Bob" }, "2026-11-04", "x") },
    ]);
    const names = (who: Parameters<typeof filterPlays>[3]) => filterPlays(plays, "", null, who).map((p) => p.header.name);
    expect(names("mine")).toEqual(["Mine"]);
    expect(names("theirs")).toEqual(["Bob's", "Jane 2", "Jane 1"]);
    expect(names("by:JANE TRADER")).toEqual(["Jane 2", "Jane 1"]);
    expect(creditCounts(plays)).toEqual([{ credit: "jane trader", n: 2 }, { credit: "Bob", n: 1 }]);
    expect(filterPlays(plays, "youtube", null).length).toBe(3);
  });

  it("splits a source into text and links", () => {
    expect(sourceParts("Video https://youtu.be/x?t=5 (part 2)")).toEqual([
      { text: "Video ", url: false }, { text: "https://youtu.be/x?t=5", url: true }, { text: " (part 2)", url: false },
    ]);
  });
});

describe("library", () => {
  it("keeps other traders' plays in Library/, credited", async () => {
    const T: PlayHeader = { ...H, name: "ORB", credit: "Jane Trader" };
    expect(playPath([], "ORB", LIBRARY)).toBe("Library/orb.md");
    const fake = new FakeGitHub({ "Template.md": "# T" });
    const out = await commitPlay(new GitHubClient(TOKEN, fake.fetch), REPO, { kind: "create", header: T, body: `x\n\n${pendingToken(1)}`, images: [{ id: 1, type: "image/png", bytes: PNG }] }, NOW, 3, LIBRARY);
    expect(out.path).toBe("Library/orb.md");
    expect(out.imagePaths).toEqual(["Images/library/orb/2026-11-21-1.png"]);
    expect(fake.text(out.path)).toContain("**Credit:** Jane Trader");
  });
});

describe("routines", () => {
  const R: PlayHeader = { name: "Weekend prep", markets: ["Weekend"], timeframes: ["TradingView"], tactics: ["Weekly charts", "Sector ETFs"], credit: "Jane Trader" };

  it("use When / Tools / numbered Steps, in Routines/", () => {
    const md = buildPlayMarkdown(R, "2026-11-22", "w", ROUTINES);
    expect(md).toContain("**When:** Weekend\n**Tools:** TradingView\n**Steps:**\n1. Weekly charts\n2. Sector ETFs\n");
    expect(parsePlay({ path: "Routines/weekend-prep.md", markdown: md }, ROUTINES).header).toEqual(R);
    expect(replaceHeader(md, { ...R, tactics: ["Only"] }, "2026-12-01", ROUTINES)).toContain("**Created:** 2026-11-22\n**Credit:** Jane Trader\n**When:**");
    expect(playPath(["Routines/weekend-prep.md"], "Weekend Prep", ROUTINES)).toBe("Routines/weekend-prep-2.md");
    expect(playImagePath([], "weekend-prep", "2026-11-22", "png", ROUTINES)).toBe("Images/routines/weekend-prep/2026-11-22-1.png");
  });

  it("commit to Routines/ with routine wording", async () => {
    const fake = new FakeGitHub({ "Template.md": "# T" });
    const out = await commitPlay(new GitHubClient(TOKEN, fake.fetch), REPO, { kind: "create", header: R, body: `x\n\n${pendingToken(1)}`, images: [{ id: 1, type: "image/png", bytes: PNG }] }, NOW, 3, ROUTINES);
    expect(out.path).toBe("Routines/weekend-prep.md");
    expect(out.imagePaths).toEqual(["Images/routines/weekend-prep/2026-11-21-1.png"]);
    expect(playMessage({ kind: "create", header: R, body: "", images: [] }, "Weekend prep", 0, "routine")).toBe("Add routine: Weekend prep (written in the journal)");
  });

  it("sit under PLAYS (yours) and LIBRARY (other traders'), each tab switching PLAYS | ROUTINES", () => {
    const { bundle } = generateDemo("2026-11-21T15:00:00-05:00");
    expect(readPlays(bundle.playbook!.routines, ROUTINES).map((r) => r.header.name)).toEqual(["Weekend prep"]);
    expect(readPlays(bundle.playbook!.libraryRoutines, LIBRARY_ROUTINES).map((r) => r.header.credit)).toEqual(["Demo Trader"]);
    const render = (kind: Parameters<typeof PlaysPage>[0]["kind"], by?: string) => renderToStaticMarkup(createElement(PlaysPage, { data: bundle, kind, by }));

    const plays = render("plays");
    expect(plays).toContain("Gap and Go");
    expect(plays).not.toContain("Weekend prep");
    expect(plays).not.toContain("BY ");
    expect(plays).toContain('href="#/plays?show=routines"');

    const routines = render("routines");
    expect(routines).toContain("Weekend prep");
    expect(routines).toContain("+ NEW ROUTINE");
    expect(routines).not.toContain("Premarket checklist");
    expect(routines).not.toContain("Gap and Go");

    const library = render("library");
    expect(library).toContain("Opening range breakout");
    expect(library).toContain("BY Demo Trader");
    expect(library).toContain("+ ADD PLAY");
    expect(library).not.toContain("Gap and Go");

    // The person filter carries to the other half of the tab.
    const theirRoutines = render("library-routines", "Demo Trader");
    expect(theirRoutines).toContain("Premarket checklist");
    expect(theirRoutines).toContain("+ ADD ROUTINE");
    expect(theirRoutines).toContain('href="#/library?by=Demo+Trader"');
    expect(theirRoutines).not.toContain("Weekend prep");
  });
});
