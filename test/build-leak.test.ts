// The dev data plugin must never put trade data, review text, review file names
// or chart images into `vite build` output, and the encrypted dist must reveal
// none of them either (SPEC §2, §7, Q34).
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bundleData } from "../build/bundle-data";
import { checkDist, checkEncrypted, findLeaks, playbookNames } from "../build/check-dist";
import { encryptBundle, readKdfParams } from "../build/encrypt";
import { REPO_ROOT } from "../cli/lib/history";
import { decryptData, decryptFile, deriveKeyBytes, importAesKey, KIND_IMAGE } from "../src/core/crypto";
import type { DataBundle, DerivedTrades } from "../src/core/types";
import { open } from "./factory";
import { FIXTURES } from "./helpers";

const CANARY = "CNRYQX";
const REVIEW_NAME = `2026-09-20-${CANARY}`;
const REVIEW_TEXT = "canary review sentence 7f3a9c";
const IMAGE_NAME = `${CANARY}-daily.png`;
const IMAGE_BYTES = "canary-image-bytes-51e0d2";
const PASS = "synthetic canary passphrase 42";
let tmp: string;
let outDir: string;
let encDir: string;
let sources: { historyDir: string; quotesFile: string; playbookDir: string };
const saved = { history: process.env.TRADE_HISTORY_DIR, quotes: process.env.QUOTES_FILE, playbook: process.env.PLAYBOOK_DIR };

/** Every file's bytes as latin1, so binary files are searched too. */
function allText(dir: string): string {
  return readdirSync(dir)
    .map((n) => join(dir, n))
    .map((p) => (statSync(p).isDirectory() ? allText(p) : readFileSync(p, "latin1")))
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
  // The deploy's next steps: bundle the same data and encrypt it into a copy of dist/.
  sources = { historyDir: history, quotesFile: join(tmp, "quotes.json"), playbookDir: playbook };
  encDir = join(tmp, "dist-enc");
  cpSync(outDir, encDir, { recursive: true });
  const { bundle, images } = bundleData(sources);
  encryptBundle(bundle, images, PASS, encDir);
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

  it("has no OPEN DEMO button or demo passphrase (only npm run preview:demo builds them in)", async () => {
    const { DEMO_PASSPHRASE } = await import("../build/preview-demo-passphrase");
    const text = allText(outDir);
    expect(text).not.toContain(DEMO_PASSPHRASE);
    expect(text).not.toContain("OPEN DEMO");
  });

  it("does not contain the dev data or image loaders at all", () => {
    expect(allText(outDir)).not.toContain("__data");
  });

  it("has a CSP, self-hosted fonts and no runtime code compilation (Q46)", () => {
    const html = readFileSync(join(outDir, "index.html"), "utf8");
    expect(html).toMatch(/<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'sha256-/);
    expect(html).not.toMatch(/googleapis|gstatic/);
    expect(readdirSync(join(outDir, "assets")).some((f) => f.endsWith(".woff2"))).toBe(true);
    expect(allText(outDir)).not.toContain("new Function");
  });

  it("passes the dist leak guard, which catches a planted symbol", () => {
    const logs: string[] = [];
    expect(checkDist(outDir, new Set([CANARY, "ZZ"]), (s) => logs.push(s))).toBe(0);
    writeFileSync(join(outDir, "planted.js"), `const s = "${CANARY}";`);
    expect(checkDist(outDir, new Set([CANARY]), (s) => logs.push(s))).toBe(1);
    expect(logs.join("\n")).not.toContain(CANARY);
  });
});

describe("encrypted dist (canary bundle)", () => {
  const names = () => playbookNames({ reviews: [{ path: `Reviews/${REVIEW_NAME}.md` }], images: [`Images/2026-09-20/${IMAGE_NAME}`] });

  it("really contains the canary data, readable with the passphrase", async () => {
    const kdf = readKdfParams();
    const key = await importAesKey(await deriveKeyBytes(PASS, kdf.salt, kdf.iterations));
    const data = await decryptData<DataBundle>(key, new Uint8Array(readFileSync(join(encDir, "data.enc"))));
    expect(data.derived.trades[0]!.symbol).toBe(CANARY);
    expect(data.playbook!.reviews[0]!.markdown).toContain(REVIEW_TEXT);
    const name = data.imageFiles![`Images/2026-09-20/${IMAGE_NAME}`]!;
    const img = await decryptFile(key, new Uint8Array(readFileSync(join(encDir, "img", `${name}.enc`))), KIND_IMAGE, name);
    expect(new TextDecoder().decode(img)).toBe(IMAGE_BYTES);
  });

  it("shows no symbol, review name, review text, image name or image bytes anywhere", () => {
    const text = allText(encDir);
    for (const s of [CANARY, REVIEW_NAME, REVIEW_TEXT, IMAGE_NAME, IMAGE_BYTES, "2026-09-20"]) expect(text).not.toContain(s);
    expect(text).not.toContain("__data");
  });

  it("passes the encrypted leak guard", () => {
    const logs: string[] = [];
    expect(checkEncrypted(encDir)).toEqual([]);
    expect(checkDist(encDir, new Set([CANARY]), (s) => logs.push(s), undefined, names(), { encrypted: true })).toBe(0);
  });

  it("fails the guard on a plaintext file, an unhashed image or an unpadded image count, without printing values", () => {
    const bad = join(tmp, "dist-bad");
    cpSync(encDir, bad, { recursive: true });
    writeFileSync(join(bad, "data.json"), "{}");
    writeFileSync(join(bad, "img", `${CANARY}.enc`), readFileSync(join(bad, "data.enc")));
    const problems = checkEncrypted(bad).join("\n");
    expect(problems).toContain("data.json: unexpected file");
    expect(problems).toContain("image file not named");
    expect(problems).toContain("file count not padded");
    const logs: string[] = [];
    expect(checkDist(bad, new Set([CANARY]), (s) => logs.push(s), undefined, names(), { encrypted: true, publicLog: true })).toBe(1);
    const out = logs.join("\n");
    expect(out).toContain("LEAK");
    expect(out).toContain("FAILED");
    expect(out).not.toMatch(/\d+ (symbols|LEAKS)/);
  });

  it("requires data.enc in --encrypted mode", () => {
    const logs: string[] = [];
    expect(checkDist(outDir, new Set(), (s) => logs.push(s), undefined, new Set(), { encrypted: true })).toBe(1);
    expect(logs.join("\n")).toContain("data.enc: missing");
  });

  it("handles a Playbook with no Reviews/ or Images/", () => {
    const empty = join(tmp, "empty-playbook");
    mkdirSync(empty);
    const { bundle, images } = bundleData({ ...sources, playbookDir: empty });
    expect(bundle.playbook).toEqual({ reviews: [], images: [] });
    expect(images).toEqual([]);
    const dir = join(tmp, "dist-empty");
    cpSync(outDir, dir, { recursive: true });
    rmSync(join(dir, "planted.js"), { force: true });
    encryptBundle(bundle, images, PASS, dir);
    expect(checkEncrypted(dir)).toEqual([]);
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
