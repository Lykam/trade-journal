// The QUOTES page (SPEC §3.6, §6.7b, Q81): sayings.json parsing, the form's
// normalizing, the one-commit plan and the list filters. Made-up quotes only.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { schemaTexts, validate } from "../cli/lib/history";
import { commitPlan, GitHubClient, readHistory } from "../src/core/github/client";
import { parseHistory, type HistorySnapshot } from "../src/core/history/files";
import {
  filterSayings, linkLabel, newestFirst, newSayingId, normalizeLink, normalizeTag, parseTags, planSayingCommit, safeHref, sayingFromDraft,
  sourceList, tagCounts, type SayingChange,
} from "../src/core/sayings/sayings";
import type { Saying } from "../src/core/types";
import { FakeGitHub, TOKEN } from "./fake-github";
import { FIXTURES } from "./helpers";

const config = JSON.parse(readFileSync(join(FIXTURES, "history", "config.json"), "utf8"));
const ctx = { schemas: schemaTexts() };
const base = { id: "q-0123456789ab", addedAt: "2026-11-15T15:00:00.000Z" };
const A: Saying = { id: "q-aaaaaaaaaaaa", text: "Cut losers fast.", source: "Own note", tags: ["exits", "discipline"], addedAt: "2026-11-01T14:00:00.000Z" };
const B: Saying = { id: "q-bbbbbbbbbbbb", text: "Volatility contracts before it expands.", source: "Review video", link: "https://example.com/v", tags: ["volatility"], addedAt: "2026-11-10T14:00:00.000Z" };

const snap = (sayings: Saying[] = []): HistorySnapshot => ({
  config, symbols: {}, overrides: { trades: {}, openingPositions: [] }, fills: [], derived: null, sayings: { schemaVersion: 1, sayings },
});

describe("sayings.json", () => {
  it("is optional: a trade-history without it reads as no quotes", () => {
    const s = parseHistory({ config: JSON.stringify(config), fills: [] }, validate);
    expect(s.sayings).toEqual({ schemaVersion: 1, sayings: [] });
  });

  it("rejects a non-web link, a bad tag and an empty quote", () => {
    for (const bad of [{ ...A, link: "javascript:alert(1)" }, { ...A, tags: ["Two Words"] }, { ...A, text: "" }, { ...A, id: "x" }]) {
      expect(() => validate("sayings", { schemaVersion: 1, sayings: [bad] }, "sayings.json")).toThrow(/does not match sayings.schema.json/);
    }
    expect(() => validate("sayings", { schemaVersion: 1, sayings: [A, B] }, "sayings.json")).not.toThrow();
  });
});

describe("the form", () => {
  it("normalizes tags to lowercase-hyphenated, without repeats", () => {
    expect(normalizeTag("  Relative Strength ")).toBe("relative-strength");
    expect(normalizeTag("#VCP")).toBe("vcp");
    expect(normalizeTag("risk/reward")).toBe("risk-reward");
    expect(normalizeTag("!!!")).toBeNull();
    expect(parseTags("volatility, Relative Strength,,volatility , ")).toEqual(["volatility", "relative-strength"]);
  });

  it("takes http(s) links, adds https:// when missing, and refuses anything else", () => {
    expect(normalizeLink("")).toBe("");
    expect(normalizeLink("youtu.be/abc123")).toBe("https://youtu.be/abc123");
    expect(normalizeLink(" https://www.youtube.com/watch?v=x&t=42 ")).toBe("https://www.youtube.com/watch?v=x&t=42");
    expect(normalizeLink("javascript:alert(1)")).toBeNull();
    expect(normalizeLink("ftp://example.com/x")).toBeNull();
    expect(normalizeLink("not a link")).toBeNull();
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("https://example.com/a")).toBe("https://example.com/a");
    expect(linkLabel("https://www.youtube.com/watch?v=x")).toBe("youtube.com");
  });

  it("builds the saying, leaving out empty optional fields", () => {
    expect(sayingFromDraft({ text: "  Cash is a position. ", source: " ", link: "", tags: "" }, base)).toEqual({ ...base, text: "Cash is a position." });
    expect(sayingFromDraft({ text: "Q", source: "Some  Trader", link: "example.com/v", tags: "Market, market" }, base)).toEqual({
      ...base, text: "Q", source: "Some Trader", link: "https://example.com/v", tags: ["market"],
    });
    expect(sayingFromDraft({ text: " ", source: "", link: "", tags: "" }, base)).toBe("Type the quote.");
    expect(sayingFromDraft({ text: "Q", source: "", link: "mailto:x@y.z", tags: "" }, base)).toMatch(/web address/);
  });

  it("makes ids the schema accepts", () => {
    expect(newSayingId(() => new Uint8Array([0, 1, 2, 0xab, 0xcd, 0xff]))).toBe("q-000102abcdff");
    expect(newSayingId()).toMatch(/^q-[0-9a-f]{12}$/);
  });
});

describe("the commit", () => {
  it("adds a quote at the end of sayings.json, with trade-history's copy of the schema", () => {
    const s = sayingFromDraft({ text: "Good to see relative strength, but we need to see some compression of volatility too.", source: "Review video", link: "", tags: "relative strength" }, base) as Saying;
    const plan = planSayingCommit(snap([A]), { kind: "put", saying: s }, ctx, validate);
    expect(plan.files.map((f) => f.path)).toEqual(["sayings.json", "schema/sayings.schema.json"]);
    expect(JSON.parse(plan.files[0]!.content as string).sayings).toEqual([A, s]);
    expect(plan.before).toBeNull();
    expect(plan.message).toBe('Quotes: add "Good to see relative strength, but we need to s…" (Review video)');
  });

  it("edits in place, removes, and writes nothing when the edit changes nothing", () => {
    const edited = { ...A, text: "Cut losers faster." };
    const plan = planSayingCommit(snap([A, B]), { kind: "put", saying: edited }, ctx, validate);
    expect(plan.sayings.sayings).toEqual([edited, B]);
    expect(plan.message).toBe('Quotes: edit "Cut losers faster." (Own note)');
    const rm = planSayingCommit(snap([A, B]), { kind: "remove", id: A.id }, ctx, validate);
    expect(rm.sayings.sayings).toEqual([B]);
    expect(rm.message).toBe('Quotes: remove "Cut losers fast." (Own note)');
    expect(planSayingCommit(snap([A]), { kind: "put", saying: A }, ctx, validate).files).toEqual([]);
    expect(() => planSayingCommit(snap([B]), { kind: "remove", id: A.id }, ctx, validate)).toThrow(/no longer/);
  });

  it("keeps a quote added elsewhere when main moved before the commit", async () => {
    const files = Object.fromEntries(readdirSync(join(FIXTURES, "history")).map((n) => [n, readFileSync(join(FIXTURES, "history", n), "utf8")]));
    const fake = new FakeGitHub({ ...files, "sayings.json": JSON.stringify({ schemaVersion: 1, sayings: [A] }) });
    const gh = new GitHubClient(TOKEN, fake.fetch);
    const data = { owner: "tester", repo: "history-sandbox" };
    const remote = await readHistory(gh, data, validate);
    expect(remote.snap.sayings.sayings).toEqual([A]);
    // Someone else adds B first.
    const other = planSayingCommit(remote.snap, { kind: "put", saying: B }, ctx, validate);
    await commitPlan(gh, validate, remote, other, (r) => planSayingCommit(r.snap, { kind: "put", saying: B }, ctx, validate));
    const mine: SayingChange = { kind: "put", saying: { ...base, text: "Mine." } };
    const plan = planSayingCommit(remote.snap, mine, ctx, validate);
    const out = await commitPlan(gh, validate, remote, plan, (r) => planSayingCommit(r.snap, mine, ctx, validate));
    expect(out.commit).not.toBeNull();
    const after = await readHistory(gh, data, validate);
    expect(after.snap.sayings.sayings.map((s) => s.id)).toEqual([A.id, B.id, base.id]);
  });
});

describe("the list", () => {
  const list = [A, B, { ...base, text: "Size down when the gauge says so.", source: "own note", tags: ["sizing", "discipline"] }];

  it("shows newest first and filters by words, tag and source", () => {
    expect(newestFirst(list).map((s) => s.id)).toEqual([base.id, B.id, A.id]);
    expect(filterSayings(list, { q: "VOLATILITY", tag: null, source: null })).toEqual([B]);
    expect(filterSayings(list, { q: "", tag: "discipline", source: null }).map((s) => s.id)).toEqual([A.id, base.id]);
    expect(filterSayings(list, { q: "", tag: null, source: "OWN NOTE" }).map((s) => s.id)).toEqual([A.id, base.id]);
    expect(filterSayings(list, { q: "gauge size", tag: "discipline", source: "Own note" }).map((s) => s.id)).toEqual([base.id]);
  });

  it("counts tags and lists sources by use", () => {
    expect(tagCounts(list)).toEqual([{ tag: "discipline", n: 2 }, { tag: "exits", n: 1 }, { tag: "sizing", n: 1 }, { tag: "volatility", n: 1 }]);
    expect(sourceList(list)).toEqual(["Own note", "Review video"]);
  });
});
