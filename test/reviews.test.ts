// Playbook review parsing and the review ↔ idea join (SPEC §6.11). Fake reviews only.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { chartsFor, parseChartPath, resolvePlaybookPath } from "../src/core/reviews/images";
import { joinReviews, readReviews } from "../src/core/reviews/join";
import { categoryLabel, parseReviewHeader, parseReviewName } from "../src/core/reviews/parse-header";
import type { DerivedTrades, Idea, ReviewFile, Trade } from "../src/core/types";
import { closed, open } from "./factory";
import { FIXTURES, symbols } from "./helpers";

const PLAYBOOK = join(FIXTURES, "playbook");
const fixtureReviews = (): ReviewFile[] =>
  readdirSync(join(PLAYBOOK, "Reviews")).map((n) => ({ path: `Reviews/${n}`, markdown: readFileSync(join(PLAYBOOK, "Reviews", n), "utf8") }));
const expected = JSON.parse(readFileSync(join(FIXTURES, "expected", "trades.json"), "utf8")) as DerivedTrades;

const header = (lines: string[]) => `# Playbook Review — ZZAB 2025-04-01\n\n${lines.join("\n")}\n\n## Category\n\nBreaking news. More detail.\n`;

describe("parseReviewHeader", () => {
  it("reads the Template.md header fields", () => {
    const h = parseReviewHeader(
      header(["**Date:** 2025-04-01", "**Ticker:** zzab", "**P&L:** +$85", "**Trade Type:** DAY TRADE", "**Status:** CLOSED"]),
    );
    expect(h).toEqual({
      date: "2025-04-01", ticker: "ZZAB", pnl: "+$85", tradeType: "day", status: "closed", ideaId: null, category: "Breaking news",
    });
  });

  it("reads an optional Idea ID line", () => {
    const h = parseReviewHeader(
      header(["**Date:** 2025-04-01", "**Ticker:** ZZAB", "**Trade Type:** SWING TRADE", "**Status:** OPEN", "**Idea ID:** sc-0123456789ab"]),
    );
    expect(h.ideaId).toBe("sc-0123456789ab");
    expect(h.tradeType).toBe("swing");
    expect(h.status).toBe("open");
  });

  it("treats template placeholders, blanks and comments as missing", () => {
    const h = parseReviewHeader(
      header(["**Date:** {{DATE}}", "**Ticker:**", "**P&L:** {{PNL}}", "**Trade Type:** {{DAY TRADE | SWING TRADE}}", "**Status:** <!-- x -->"]),
    );
    expect(h).toMatchObject({ date: null, ticker: null, pnl: null, tradeType: null, status: null, ideaId: null });
  });

  it("ignores bold label lines inside sections", () => {
    const h = parseReviewHeader("**Date:** 2025-04-01\n\n## Daily Chart\n\n**Status:** OPEN\n**Idea ID:** nope\n");
    expect(h.status).toBeNull();
    expect(h.ideaId).toBeNull();
  });

  it("parses the real fixture files", () => {
    const byName = Object.fromEntries(fixtureReviews().map((r) => [r.path, parseReviewHeader(r.markdown)]));
    expect(byName["Reviews/2025-03-13-FAKU.md"]).toMatchObject({ ticker: "FAKU", tradeType: "swing", status: "closed", category: "Swing trade" });
    expect(byName["Reviews/2025-03-12-HOLD.md"]!.ideaId).toBe("wb-f1716d322462");
    expect(byName["Reviews/2025-03-14-SDAY.md"]).toMatchObject({ status: "open", pnl: null });
  });
});

describe("review names and categories", () => {
  it("parses <DATE>-<TICKER>[-suffix].md", () => {
    expect(parseReviewName("Reviews/2025-04-01-ZZAB.md")).toEqual({ date: "2025-04-01", ticker: "ZZAB", suffix: null });
    expect(parseReviewName("2025-04-01-zzab-2.md")).toEqual({ date: "2025-04-01", ticker: "ZZAB", suffix: "2" });
    expect(parseReviewName("Template.md")).toBeNull();
  });

  it("takes the first clause of the Category section as the tag", () => {
    expect(categoryLabel("<!-- How do you classify this trade? -->\n\nBreaking news. Gapped up.")).toBe("Breaking news");
    expect(categoryLabel("imbalance — closing cross")).toBe("Imbalance");
    expect(categoryLabel("<!-- only the template comment -->\n")).toBeNull();
    expect(categoryLabel("A very long free-form sentence that is clearly not a category label at all")).toBeNull();
  });
});

// ---------------------------------------------------------------- join

const idea = (o: Partial<Idea> & Pick<Idea, "id" | "underlying" | "date" | "style" | "tradeIds">): Idea => ({
  accounts: ["webull"], symbolsTraded: [o.underlying], usedEtf: false, netPnl: 0, status: "closed", ...o,
});
const review = (path: string, lines: string[]): ReviewFile => ({ path, markdown: lines.join("\n") });

describe("joinReviews", () => {
  const etfSymbols = { ZZBU: { underlying: "ZZB", type: "leveraged_etf" as const, leverage: 2, direction: "long" as const } };

  it("resolves an ETF-named review to the underlying's idea through symbols.json", () => {
    const t = closed({ symbol: "ZZBU", underlying: "ZZB", closedAt: "2025-04-01T10:00:00-04:00", net: 1 });
    const ideas = [idea({ id: t.id, underlying: "ZZB", date: "2025-04-01", style: "day", tradeIds: [t.id], symbolsTraded: ["ZZBU"], usedEtf: true })];
    const j = joinReviews(readReviews([review("Reviews/2025-04-01-ZZBU.md", ["**Date:** 2025-04-01", "**Ticker:** ZZBU"])], etfSymbols), { ideas, trades: [t] });
    expect(j.ideaOf.get("2025-04-01-ZZBU")).toBe(t.id);
    expect(j.method.get("2025-04-01-ZZBU")).toBe("date-ticker");
    expect(j.unmatched).toEqual([]);
  });

  it("links a day idea 1:1 by date and ticker, falling back to the file name", () => {
    const a = closed({ symbol: "ZZC", closedAt: "2025-04-01T10:00:00-04:00", net: 1 });
    const b = closed({ symbol: "ZZC", closedAt: "2025-04-02T10:00:00-04:00", net: 1 });
    const ideas = [
      idea({ id: a.id, underlying: "ZZC", date: "2025-04-01", style: "day", tradeIds: [a.id] }),
      idea({ id: b.id, underlying: "ZZC", date: "2025-04-02", style: "day", tradeIds: [b.id] }),
    ];
    const j = joinReviews(readReviews([review("Reviews/2025-04-02-ZZC.md", ["# no header fields"])], {}), { ideas, trades: [a, b] });
    expect(j.ideaOf.get("2025-04-02-ZZC")).toBe(b.id);
    expect(j.byIdea.get(b.id)?.map((r) => r.id)).toEqual(["2025-04-02-ZZC"]);
    expect(j.byIdea.has(a.id)).toBe(false);
  });

  it("links a swing re-entry review (dated the re-entry) to the idea it joined", () => {
    const first = closed({ style: "swing", symbol: "ZZD", openedAt: "2025-04-01T00:00:00-04:00", closedAt: "2025-04-03T00:00:00-04:00", net: -1 });
    const reentry = closed({ style: "swing", symbol: "ZZD", openedAt: "2025-04-03T00:00:00-04:00", closedAt: "2025-04-08T00:00:00-04:00", net: 3 });
    const ideas = [idea({ id: first.id, underlying: "ZZD", date: "2025-04-01", style: "swing", tradeIds: [first.id, reentry.id] })];
    const j = joinReviews(
      readReviews([
        review("Reviews/2025-04-01-ZZD.md", ["**Date:** 2025-04-01", "**Ticker:** ZZD"]),
        review("Reviews/2025-04-03-ZZD.md", ["**Date:** 2025-04-03", "**Ticker:** ZZD", "**Trade Type:** SWING TRADE"]),
      ], {}),
      { ideas, trades: [first, reentry] },
    );
    expect(j.method.get("2025-04-01-ZZD")).toBe("date-ticker");
    expect(j.method.get("2025-04-03-ZZD")).toBe("re-entry");
    expect(j.ideaOf.get("2025-04-03-ZZD")).toBe(first.id);
    expect(j.multiple).toEqual([{ ideaId: first.id, reviews: [expect.objectContaining({ id: "2025-04-01-ZZD" }), expect.objectContaining({ id: "2025-04-03-ZZD" })] }]);
  });

  it("reports a review that matches no idea", () => {
    const t = open({ symbol: "ZZE", openedAt: "2025-04-01T00:00:00-04:00" });
    const ideas = [idea({ id: t.id, underlying: "ZZE", date: "2025-04-01", style: "swing", tradeIds: [t.id], status: "open" })];
    const j = joinReviews(
      readReviews([
        review("Reviews/2025-04-02-ZZE.md", ["**Date:** 2025-04-02", "**Ticker:** ZZE"]),
        review("Reviews/notes.md", ["no date, no ticker"]),
      ], {}),
      { ideas, trades: [t] },
    );
    expect(j.unmatched.map((r) => r.id).sort()).toEqual(["2025-04-02-ZZE", "notes"]);
    expect(j.ideaOf.size).toBe(0);
  });

  it("prefers the Idea ID line over the file name", () => {
    const a = closed({ symbol: "ZZF", closedAt: "2025-04-01T10:00:00-04:00", net: 1 });
    const b = closed({ symbol: "ZZF", closedAt: "2025-04-02T10:00:00-04:00", net: 1 });
    const ideas = [
      idea({ id: a.id, underlying: "ZZF", date: "2025-04-01", style: "day", tradeIds: [a.id] }),
      idea({ id: b.id, underlying: "ZZF", date: "2025-04-02", style: "day", tradeIds: [b.id] }),
    ];
    const j = joinReviews(readReviews([review("Reviews/2025-04-01-ZZF.md", ["**Date:** 2025-04-01", `**Idea ID:** ${b.id}`])], {}), { ideas, trades: [a, b] });
    expect(j.ideaOf.get("2025-04-01-ZZF")).toBe(b.id);
    expect(j.method.get("2025-04-01-ZZF")).toBe("idea-id");
  });

  it("uses Trade Type to pick between a day and a swing idea on the same date", () => {
    const d = closed({ style: "day", symbol: "ZZG", closedAt: "2025-04-01T10:00:00-04:00", net: 1 });
    const s = open({ style: "swing", symbol: "ZZG", openedAt: "2025-04-01T00:00:00-04:00" });
    const ideas = [
      idea({ id: d.id, underlying: "ZZG", date: "2025-04-01", style: "day", tradeIds: [d.id] }),
      idea({ id: s.id, underlying: "ZZG", date: "2025-04-01", style: "swing", tradeIds: [s.id], status: "open" }),
    ];
    const j = joinReviews(readReviews([review("Reviews/2025-04-01-ZZG.md", ["**Date:** 2025-04-01", "**Trade Type:** SWING TRADE"])], {}), { ideas, trades: [d, s] });
    expect(j.ideaOf.get("2025-04-01-ZZG")).toBe(s.id);
  });

  it("joins the fixture Playbook against the fixture trades", () => {
    const j = joinReviews(readReviews(fixtureReviews(), symbols), expected);
    const ideaOf = Object.fromEntries(j.ideaOf);
    expect(ideaOf).toEqual({
      "2025-03-10-ZZTA": "wb-4fa89f0bc78f",
      "2025-03-10-ZZTA-2": "wb-4fa89f0bc78f",
      "2025-03-12-FAKU": "wb-8a319afe3829", // day idea (FAKE + FAKU)
      "2025-03-12-HOLD": "wb-f1716d322462",
      "2025-03-13-FAKU": "sc-532f259d6620", // swing idea, 2 FAKU trades
      "2025-03-14-OPSW": "sc-d050070a19f1",
      "2025-03-14-SDAY": "sc-15de00be7e1d",
    });
    expect(j.unmatched.map((r) => r.id)).toEqual(["2025-03-18-NOPE"]);
    expect(j.multiple.map((m) => m.ideaId)).toEqual(["wb-4fa89f0bc78f"]);
    expect(j.reviews[0]!.id).toBe("2025-03-18-NOPE"); // newest first
  });
});

describe("chart images", () => {
  const images = [
    "Images/2025-03-13/FAKU-intraday.png", "Images/2025-03-13/FAKU-daily.png", "Images/2025-03-13/FAKE-daily-2.png",
    "Images/2025-03-13/OTHR-daily.png", "Images/2025-03-12/FAKU-daily.png", "Images/2025-03-13/notes.txt",
  ];

  it("finds daily then intraday charts for the underlying and traded ETF on the given dates", () => {
    expect(chartsFor(images, ["2025-03-13"], ["FAKE", "FAKU"]).map((c) => c.path)).toEqual([
      "Images/2025-03-13/FAKE-daily-2.png", "Images/2025-03-13/FAKU-daily.png", "Images/2025-03-13/FAKU-intraday.png",
    ]);
    expect(parseChartPath("Images/2025-03-13/FAKU-intraday.png")).toMatchObject({ symbol: "FAKU", kind: "intraday", date: "2025-03-13" });
  });

  it("resolves review-relative image paths inside the Playbook only", () => {
    expect(resolvePlaybookPath("Reviews/2025-03-13-FAKU.md", "../Images/2025-03-13/FAKU-daily.png")).toBe("Images/2025-03-13/FAKU-daily.png");
    expect(resolvePlaybookPath("Reviews/x.md", "x/daily-chart.png")).toBe("Reviews/x/daily-chart.png");
    expect(resolvePlaybookPath("Reviews/x.md", "../../secret.png")).toBeNull();
    expect(resolvePlaybookPath("Reviews/x.md", "https://example.com/a.png")).toBeNull();
    expect(resolvePlaybookPath("Reviews/x.md", "data:image/png;base64,AAAA")).toBeNull();
  });
});
