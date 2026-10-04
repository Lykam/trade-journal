// The dev data plugin must never put trade data, review text, review file names
// or chart images into `vite build` output (SPEC §2, §7).
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkDist, findLeaks, playbookNames } from "../build/check-dist";
import { REPO_ROOT } from "../cli/lib/history";
import type { DerivedTrades } from "../src/core/types";
import { open } from "./factory";
import { FIXTURES } from "./helpers";

const CANARY = "CNRYQX";
const REVIEW_NAME = `2026-09-20-${CANARY}`;
const REVIEW_TEXT = "canary review sentence 7f3a9c";
const IMAGE_NAME = `${CANARY}-daily.png`;
const IMAGE_BYTES = "canary-image-bytes-51e0d2";
let tmp: string;
let outDir: string;
const saved = { history: process.env.TRADE_HISTORY_DIR, quotes: process.env.QUOTES_FILE, playbook: process.env.PLAYBOOK_DIR };

function allText(dir: string): string {
  return readdirSync(dir)
    .map((n) => join(dir, n))
    .map((p) => (statSync(p).isDirectory() ? allText(p) : readFileSync(p, "utf8")))
    .join("\n");
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "tj-leak-"));
  const history = join(tmp, "history");
  cpSync(join(FIXTURES, "history"), history, { recursive: true });
  mkdirSync(join(history, "derived"));
  const derived: DerivedTrades = {
    generated: true, generator: "test", ideas: [], trades: [open({ symbol: CANARY, openedAt: "2026-09-20T00:00:00-04:00" })],
  };
  writeFileSync(join(history, "derived", "trades.json"), JSON.stringify(derived));
  writeFileSync(join(tmp, "quotes.json"), JSON.stringify({ asOf: "x", quotes: { [CANARY]: { price: 1, time: "x" } } }));
  const playbook = join(tmp, "playbook");
  mkdirSync(join(playbook, "Reviews"), { recursive: true });
  mkdirSync(join(playbook, "Images", "2026-09-20"), { recursive: true });
  writeFileSync(join(playbook, "Reviews", `${REVIEW_NAME}.md`), `**Date:** 2026-09-20
**Ticker:** ${CANARY}

## Context

${REVIEW_TEXT}
`);
  writeFileSync(join(playbook, "Images", "2026-09-20", IMAGE_NAME), IMAGE_BYTES);
  process.env.PLAYBOOK_DIR = playbook;
  process.env.TRADE_HISTORY_DIR = history;
  process.env.QUOTES_FILE = join(tmp, "quotes.json");
  outDir = join(tmp, "dist");
  // Build exactly as `npm run build` does: production mode (vitest itself runs with NODE_ENV=test).
  const env = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    await build({ root: REPO_ROOT, mode: "production", logLevel: "silent", build: { outDir, emptyOutDir: true } });
  } finally {
    process.env.NODE_ENV = env;
  }
}, 120_000);

afterAll(() => {
  const restore = (k: string, v: string | undefined) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
  restore("TRADE_HISTORY_DIR", saved.history);
  restore("QUOTES_FILE", saved.quotes);
  restore("PLAYBOOK_DIR", saved.playbook);
  rmSync(tmp, { recursive: true, force: true });
});

describe("vite build output", () => {
  it("contains no data from TRADE_HISTORY_DIR or quotes.json", () => {
    expect(allText(outDir)).not.toContain(CANARY);
  });

  it("contains no review file names, review text or chart images from PLAYBOOK_DIR", () => {
    const text = allText(outDir);
    for (const s of [REVIEW_NAME, REVIEW_TEXT, IMAGE_NAME, IMAGE_BYTES]) expect(text).not.toContain(s);
  });

  it("does not contain the dev data or image loaders at all", () => {
    expect(allText(outDir)).not.toContain("__data");
  });

  it("passes the dist leak guard, which catches a planted symbol", () => {
    const logs: string[] = [];
    expect(checkDist(outDir, new Set([CANARY, "ZZ"]), (s) => logs.push(s))).toBe(0);
    writeFileSync(join(outDir, "planted.js"), `const s = "${CANARY}";`);
    expect(checkDist(outDir, new Set([CANARY]), (s) => logs.push(s))).toBe(1);
    expect(logs.join("\n")).not.toContain(CANARY);
  });
});

describe("findLeaks", () => {
  it("matches whole tokens; short symbols only when quoted", () => {
    expect(findLeaks("x=CNRYQX;", ["CNRYQX"])).toEqual(["CNRYQX"]);
    expect(findLeaks("xCNRYQXy", ["CNRYQX"])).toEqual([]);
    expect(findLeaks("function ZZ(){}", ["ZZ"])).toEqual([]);
    expect(findLeaks('a="ZZ"', ["ZZ"])).toEqual(["ZZ"]);
  });
});
