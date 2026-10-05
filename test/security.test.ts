// Security hardening (#5): the Pages guard, the scan's new checks, the CSP and
// the precompiled validators it needs. Fake values only.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { cspFor } from "../build/csp-plugin";
import { listRepos, otherPagesRepos } from "../build/pages-guard";
import { validatorsSource } from "../build/validators-plugin";
import { REPO_ROOT, schemaTexts } from "../cli/lib/history";
import { scanText, SHORT_WORDS } from "../cli/lib/private-scan";
import { DataFileError } from "../src/core/data-error";
import { makeValidator, SCHEMAS } from "../src/core/schema";
import { validatorFrom, type ValidateFn } from "../src/core/schema-names";
import { FIXTURES } from "./helpers";

describe("pages guard (S2)", () => {
  it("flags any other repo with Pages", () => {
    const repos = [{ name: "trade-journal", has_pages: true }, { name: "notes", has_pages: false }, { name: "blog", has_pages: true }];
    expect(otherPagesRepos(repos)).toEqual(["blog"]);
    expect(otherPagesRepos(repos.slice(0, 2))).toEqual([]);
  });

  it("pages through the repo list", async () => {
    const urls: string[] = [];
    const fake = (async (url: string) => {
      urls.push(url);
      const page = Number(new URL(url).searchParams.get("page"));
      const n = page === 1 ? 100 : 3;
      return new Response(JSON.stringify(Array.from({ length: n }, (_, i) => ({ name: `r${page}-${i}`, has_pages: false }))));
    }) as typeof fetch;
    expect(await listRepos(fake, "")).toHaveLength(103);
    expect(urls).toHaveLength(2);
  });
});

describe("scan (S3)", () => {
  const tokens = { symbols: new Set(["QZ", "QZLONG", "OK"]), names: new Set(["2025-01-02-QZLONG.md"]), accountIds: new Set(["987"]), fillIds: new Set(["wb-0123456789ab"]) };

  it("matches 1–2 letter symbols as whole words, but not common words", () => {
    expect(scanText("e.g. QZ for its ETF", tokens)).toEqual(["QZ"]);
    expect(scanText("QZX and xQZ", tokens)).toEqual([]);
    expect(SHORT_WORDS.has("OK")).toBe(true);
    expect(scanText("press OK", tokens)).toEqual([]);
  });

  it("finds account ids in their export, masked and JSON forms, reporting no value", () => {
    for (const t of ["Trading_XXX987_Transactions.csv", "acct ...987", '{"987": "schwab-main"}']) {
      expect(scanText(t, tokens)).toEqual(["(a Schwab account id)"]);
    }
    expect(scanText("timeout 9870 or 987 ms", tokens)).toEqual([]);
  });

  it("finds stored fill ids, not other ids", () => {
    expect(scanText("see wb-0123456789ab", tokens)).toEqual(["fill id wb-0123456789ab"]);
    expect(scanText("see wb-0123456789ac", tokens)).toEqual([]);
  });
});

describe("CSP (S4)", () => {
  it("allows inline scripts only by hash, and only GitHub's API besides the site", () => {
    const csp = cspFor('<head><script>var a = 1;</script><script type="module" src="/x.js"></script></head>');
    expect(csp).toMatch(/script-src 'self' 'sha256-[A-Za-z0-9+/=]{44}';/);
    expect(csp.match(/sha256-/g)).toHaveLength(1);
    expect(csp).toContain("connect-src 'self' https://api.github.com");
    expect(csp).not.toMatch(/unsafe-(inline|eval)/);
    expect(cspFor("<head></head>")).toContain("script-src 'self';");
  });
});

describe("precompiled validators (S4)", () => {
  const dir = mkdtempSync(join(tmpdir(), "tj-validators-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("need no eval and no require, and behave like the runtime ones", async () => {
    const src = validatorsSource(join(REPO_ROOT, "schema"));
    expect(src).not.toMatch(/new Function|\beval\(|require\(/);
    writeFileSync(join(dir, "v.mjs"), src);
    const mod = (await import(pathToFileURL(join(dir, "v.mjs")).href)) as Record<string, ValidateFn>;
    expect(Object.keys(mod).sort()).toEqual([...SCHEMAS].sort());
    const pre = validatorFrom((n) => mod[n]!);
    const run = makeValidator(schemaTexts());
    const outcome = (v: typeof pre, name: (typeof SCHEMAS)[number], data: unknown) => {
      try {
        v(name, data, "x.json");
        return "ok";
      } catch (e) {
        expect(e).toBeInstanceOf(DataFileError);
        return (e as Error).message;
      }
    };
    const cases: Array<[(typeof SCHEMAS)[number], unknown]> = [
      ["config", JSON.parse(readFileSync(join(FIXTURES, "history", "config.json"), "utf8"))],
      ["symbols", JSON.parse(readFileSync(join(FIXTURES, "history", "symbols.json"), "utf8"))],
      ["symbols", { QZ: { underlying: "", type: "leveraged_etf", leverage: "2", direction: "up" } }],
      ["fills", JSON.parse(readFileSync(join(FIXTURES, "expected", "fills-2025.json"), "utf8"))],
      ["trades", JSON.parse(readFileSync(join(FIXTURES, "expected", "trades.json"), "utf8"))],
      ["overrides", { trades: { x: { style: "both" } } }],
    ];
    for (const [name, data] of cases) expect(outcome(pre, name, data)).toBe(outcome(run, name, data));
    expect(outcome(pre, "symbols", cases[2]![1])).toContain("does not match symbols.schema.json");
  });
});
