import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runImport } from "../cli/import";
import { generatorVersion, schemaTexts, validate } from "../cli/lib/history";
import { deriveKeyBytes, WrongKeyError } from "../src/core/crypto";
import { deployIncludes } from "../src/core/github/deploy";
import {
  checkActionsToken, checkToken, commitFiles, commitPlan, dispatchWorkflow, GitHubClient, GitHubError, PreviewChangedError, readHistory, RefMovedError, TokenError,
  type RemoteHistory,
} from "../src/core/github/client";
import { clearToken, loadToken, saveToken, tokenKey, TOKEN_STORAGE_KEY, type KeyValueStore, type TokenRecord } from "../src/core/github/token-store";
import { importFingerprint, importMessage, importWrites, planImport } from "../src/core/import/plan";
import { MissingTradesError, planOverrideCommit, type StagedAction } from "../src/core/journal/overrides";
import { FakeGitHub, TOKEN } from "./fake-github";
import { FIXTURES, IMPORTED_AT, SCHWAB_A, SCHWAB_B, WEBULL_A, WEBULL_B } from "./helpers";

const DATA = { owner: "tester", repo: "history-sandbox" };
const APP = { owner: "tester", repo: "app" };
const CSVS = [WEBULL_A, WEBULL_B, SCHWAB_A, SCHWAB_B];

/** The synthetic trade-history fixture (config, overrides, symbols) as repo files. */
function historyFiles(): Record<string, string> {
  return Object.fromEntries(readdirSync(join(FIXTURES, "history")).map((n) => [n, readFileSync(join(FIXTURES, "history", n), "utf8")]));
}

const inputs = (rels = CSVS) => rels.map((r) => ({ name: r.split("/").pop()!, bytes: new Uint8Array(readFileSync(join(FIXTURES, r))) }));
const ctx = (remote: RemoteHistory) => ({ generator: generatorVersion(), schemas: schemaTexts(), archived: remote.archived });

function computeImport(remote: RemoteHistory, rels = CSVS) {
  const plan = planImport(inputs(rels), remote.snap, { importedAt: IMPORTED_AT });
  return { plan, files: importWrites(plan, ctx(remote), validate), message: importMessage(plan), fingerprint: importFingerprint(plan) };
}

/** Import every fixture CSV through the browser path into a fake repo. */
async function seededRepo(opts = {}) {
  const fake = new FakeGitHub(historyFiles(), opts);
  const gh = new GitHubClient(TOKEN, fake.fetch);
  const remote = await readHistory(gh, DATA, validate);
  const c = computeImport(remote);
  await commitFiles(gh, remote.state, c.files, c.message);
  return { fake, gh };
}

function walk(root: string, dir = root): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(root, p) : [relative(root, p).replace(/\\/g, "/")];
  });
}

describe("GitHub client: read and commit", () => {
  it("reads config, symbols, overrides and fills fresh from the API", async () => {
    const { fake, gh } = await seededRepo();
    const remote = await readHistory(gh, DATA, validate);
    expect(remote.state.headSha).toBe(fake.head);
    expect(remote.snap.fills).toHaveLength(44);
    expect(remote.snap.config.accounts).toContain("webull");
    expect(remote.snap.derived?.generated).toBe(true);
    expect(remote.archived.paths.size).toBe(4);
  });

  it("writes exactly one commit (blobs → tree → commit → ref) with only the changed files", async () => {
    const fake = new FakeGitHub(historyFiles());
    const gh = new GitHubClient(TOKEN, fake.fetch);
    const remote = await readHistory(gh, DATA, validate);
    const c = computeImport(remote);
    const before = fake.commitCount();
    const res = await commitFiles(gh, remote.state, c.files, c.message);
    expect(fake.commitCount()).toBe(before + 1);
    expect(res!.paths.sort()).toEqual(
      ["derived/trades.json", "fills/2025.json", ...["config", "fills", "overrides", "symbols", "trades"].map((n) => `schema/${n}.schema.json`),
        ...CSVS.map((r) => `imports/raw/2025-03-20-${r.split("/").pop()}`)].sort(),
    );
    expect(fake.commits.get(fake.head)!.message).toBe("Import Webull + Schwab 2025-03-20: +44 fills");
    const patch = fake.calls.find((c) => c.method === "PATCH")!;
    expect(patch.body).toEqual({ sha: fake.head, force: false });
    expect(fake.calls.filter((c) => c.method === "PATCH")).toHaveLength(1);
  });

  it("makes no commit when nothing changed (re-importing the same CSVs)", async () => {
    const { fake, gh } = await seededRepo();
    const remote = await readHistory(gh, DATA, validate);
    const c = computeImport(remote);
    expect(c.plan.result.added).toHaveLength(0);
    const n = fake.commitCount();
    expect(await commitFiles(gh, remote.state, c.files, c.message)).toBeNull();
    expect(fake.commitCount()).toBe(n);
  });

  it("when main moved, re-reads and recomputes instead of forcing", async () => {
    let pushed = false;
    const fake = new FakeGitHub(historyFiles(), {
      beforePatch: (f) => {
        if (pushed) return;
        pushed = true;
        f.push({ "notes.txt": "someone else's commit\n" });
      },
    });
    const gh = new GitHubClient(TOKEN, fake.fetch);
    const remote = await readHistory(gh, DATA, validate);
    const out = await commitPlan(gh, validate, remote, computeImport(remote), (r) => computeImport(r));
    expect(out.commit).not.toBeNull();
    const patches = fake.calls.filter((c) => c.method === "PATCH");
    expect(patches).toHaveLength(2);
    expect(patches.every((p) => (p.body as { force: boolean }).force === false)).toBe(true);
    // Both the other commit and ours are on main, ours on top.
    expect(fake.text("notes.txt")).toBe("someone else's commit\n");
    expect(fake.commits.get(fake.head)!.message).toMatch(/^Import /);
    expect(fake.commitCount()).toBe(3);
  });

  it("stops with a new preview when the retry would commit something different", async () => {
    // Another import of one of the CSVs lands first, so our retry would add fewer fills.
    const fake = new FakeGitHub(historyFiles());
    const gh = new GitHubClient(TOKEN, fake.fetch);
    const remote = await readHistory(gh, DATA, validate);
    const plan = computeImport(remote);
    fake.opts.beforePatch = () => {
      fake.opts.beforePatch = undefined;
      const other = computeImport(remote, [WEBULL_A]);
      fake.push(Object.fromEntries(other.files.map((f) => [f.path, f.content])), "other import");
    };
    const err = await commitPlan(gh, validate, remote, plan, (r) => computeImport(r)).catch((e) => e);
    expect(err).toBeInstanceOf(PreviewChangedError);
    expect(fake.commits.get(fake.head)!.message).toBe("other import");
    expect((err as PreviewChangedError<{ plan: { result: { added: unknown[] } } }>).plan.plan.result.added.length).toBeLessThan(44);
  });

  it("gives up after the retry limit and never forces", async () => {
    const fake = new FakeGitHub(historyFiles(), { beforePatch: (f) => f.push({ [`n${Math.random()}.txt`]: "x" }) });
    const gh = new GitHubClient(TOKEN, fake.fetch);
    const remote = await readHistory(gh, DATA, validate);
    const plan = { files: [{ path: "a.txt", content: "a\n" }], message: "m", fingerprint: "f" };
    await expect(commitPlan(gh, validate, remote, plan, () => plan, 3)).rejects.toBeInstanceOf(RefMovedError);
    expect(fake.calls.filter((c) => c.method === "PATCH")).toHaveLength(3);
    expect(fake.calls.some((c) => (c.body as { force?: boolean } | undefined)?.force === true)).toBe(false);
  });
});

describe("GitHub client: errors and permissions", () => {
  it("maps 401 / 403 / 404 to clear errors", async () => {
    const fake = new FakeGitHub(historyFiles(), { write: false });
    await expect(readHistory(new GitHubClient("github_pat_wrong", fake.fetch), DATA, validate)).rejects.toMatchObject({ kind: "auth" });
    await expect(readHistory(new GitHubClient(TOKEN, fake.fetch), { owner: "tester", repo: "nope" }, validate)).rejects.toMatchObject({ kind: "not-found" });
    const gh = new GitHubClient(TOKEN, fake.fetch);
    const remote = await readHistory(gh, DATA, validate);
    const err = await commitFiles(gh, remote.state, [{ path: "x.txt", content: "x" }], "m").catch((e) => e);
    expect(err).toBeInstanceOf(GitHubError);
    expect(err.kind).toBe("permission");
  });

  it("checkToken: requires a fine-grained token with read and write; detects Actions access", async () => {
    const ok = new FakeGitHub(historyFiles(), { actions: true });
    const r = await checkToken(new GitHubClient(TOKEN, ok.fetch), TOKEN, DATA, APP);
    expect(r).toMatchObject({ write: true, actions: true, expiresAt: "2027-01-01 00:00:00 UTC" });
    // The Actions probe dispatches on a ref that doesn't exist, so nothing runs.
    const probe = ok.calls.find((c) => c.url.endsWith("/dispatches"))!;
    expect((probe.body as { ref: string }).ref).not.toBe("main");

    const noActions = new FakeGitHub(historyFiles());
    expect((await checkToken(new GitHubClient(TOKEN, noActions.fetch), TOKEN, DATA, APP)).actions).toBe(false);

    const readOnly = new FakeGitHub(historyFiles(), { write: false });
    await expect(checkToken(new GitHubClient(TOKEN, readOnly.fetch), TOKEN, DATA, APP)).rejects.toThrow(/not write/);
    const noAccess = new FakeGitHub(historyFiles(), { read: false });
    await expect(checkToken(new GitHubClient(TOKEN, noAccess.fetch), TOKEN, DATA, APP)).rejects.toThrow(/can.t see .*HTTP 404/);
    const classic = "ghp_" + "x".repeat(36);
    await expect(checkToken(new GitHubClient(classic, ok.fetch), classic, DATA, APP)).rejects.toBeInstanceOf(TokenError);
  });

  it("checkActionsToken: a separate token that may start prices.yml (Q38)", async () => {
    await expect(checkActionsToken(new GitHubClient(TOKEN, new FakeGitHub({}, { actions: true }).fetch), TOKEN, APP)).resolves.toBeUndefined();
    await expect(checkActionsToken(new GitHubClient(TOKEN, new FakeGitHub({}).fetch), TOKEN, APP)).rejects.toThrow(/can't start workflows/);
  });

  it("Refresh prices dispatches prices.yml on main", async () => {
    const fake = new FakeGitHub(historyFiles(), { actions: true });
    await dispatchWorkflow(new GitHubClient(TOKEN, fake.fetch), APP);
    expect(fake.calls.at(-1)).toMatchObject({ method: "POST", url: "https://api.github.com/repos/tester/app/actions/workflows/prices.yml/dispatches", body: { ref: "main" } });
  });
});

describe("the token stays private", () => {
  const spies: Array<ReturnType<typeof vi.spyOn>> = [];
  beforeEach(() => {
    for (const m of ["log", "info", "warn", "error", "debug"] as const) spies.push(vi.spyOn(console, m).mockImplementation(() => {}));
  });
  afterEach(() => {
    spies.splice(0).forEach((s) => s.mockRestore());
  });

  it("is sent only to api.github.com, and never appears in errors, logs or JSON", async () => {
    const seen: string[] = [];
    const fake = new FakeGitHub(historyFiles(), { actions: true });
    const spy = async (url: string, init: RequestInit) => {
      seen.push(new URL(url).origin);
      return fake.fetch(url, init);
    };
    const gh = new GitHubClient(TOKEN, spy);
    await checkToken(gh, TOKEN, DATA, APP);
    const remote = await readHistory(gh, DATA, validate);
    const c = computeImport(remote);
    await commitFiles(gh, remote.state, c.files, c.message);
    const errors: unknown[] = [];
    for (const repo of [{ owner: "tester", repo: "nope" }, DATA]) {
      await readHistory(new GitHubClient(TOKEN, async (u, i) => (repo === DATA ? Promise.reject(new TypeError("net")) : fake.fetch(u, i))), repo, validate).catch((e) => errors.push(e));
    }
    expect(new Set(seen)).toEqual(new Set(["https://api.github.com"]));
    expect(fake.calls.every((call) => call.url.startsWith("https://api.github.com/"))).toBe(true);
    const printed = JSON.stringify([errors.map((e) => [String(e), (e as Error).stack]), gh, spies.map((s) => s.mock.calls)]);
    expect(printed).not.toContain(TOKEN);
    expect(printed).not.toContain("fake-test-token");
  });

  it("refuses paths that would leave api.github.com", async () => {
    const f = vi.fn();
    const gh = new GitHubClient(TOKEN, f);
    await expect(gh.request("GET", "//evil.example/x")).rejects.toThrow();
    await expect(gh.request("GET", "@evil.example/x")).rejects.toThrow();
    expect(f).not.toHaveBeenCalled();
  });
});

describe("encrypted token storage", () => {
  const memory = (): KeyValueStore & { data: Map<string, string> } => {
    const data = new Map<string, string>();
    return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
  };
  const rec: TokenRecord = { token: TOKEN, repo: "tester/history-sandbox", actions: true, expiresAt: null, checkedAt: "2026-10-04T12:00:00Z" };
  const salt = new Uint8Array(16).fill(7);

  it("round-trips under the site key and stores no plaintext", async () => {
    const store = memory();
    const key = await tokenKey(await deriveKeyBytes("correct horse battery staple", salt, 1000));
    await saveToken(store, key, rec);
    const stored = store.data.get(TOKEN_STORAGE_KEY)!;
    expect(stored).not.toContain("fake-test-token");
    expect(stored).not.toContain("history-sandbox");
    expect(await loadToken(store, key)).toEqual({ status: "ok", record: rec });
    clearToken(store);
    expect(await loadToken(store, key)).toEqual({ status: "none" });
  });

  it("is unreadable with another key (a changed passphrase, or after LOCK forgot the key)", async () => {
    const store = memory();
    await saveToken(store, await tokenKey(await deriveKeyBytes("passphrase one is long", salt, 1000)), rec);
    const other = await tokenKey(await deriveKeyBytes("passphrase two is long", salt, 1000));
    expect(await loadToken(store, other)).toEqual({ status: "unreadable" });
  });

  it("uses a key separate from the data key", async () => {
    const { seal, unseal, importAesKey } = await import("../src/core/crypto");
    const raw = await deriveKeyBytes("passphrase one is long", salt, 1000);
    const sealed = await seal(await tokenKey(raw), "secret", "tj.gh.v1");
    // The data key itself is decrypt-only and can't open the token.
    await expect(unseal(await importAesKey(raw), sealed, "tj.gh.v1")).rejects.toBeInstanceOf(WrongKeyError);
  });
});

describe("browser import path = CLI import path", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "trade-history-"));
    cpSync(join(FIXTURES, "history"), dir, { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("writes byte-identical files from the same CSVs, including a second overlapping import", async () => {
    const fake = new FakeGitHub(historyFiles());
    const gh = new GitHubClient(TOKEN, fake.fetch);
    for (const batch of [[WEBULL_A, SCHWAB_A], [WEBULL_B, SCHWAB_B, WEBULL_A]]) {
      expect(runImport([...batch.map((r) => join(FIXTURES, r)), "--history-dir", dir, "--now", IMPORTED_AT], () => {})).toBe(0);
      const remote = await readHistory(gh, DATA, validate);
      const c = computeImport(remote, batch);
      await commitFiles(gh, remote.state, c.files, c.message);
    }
    const cli = Object.fromEntries(walk(dir).map((p) => [p, readFileSync(join(dir, p))]));
    const browser = fake.files();
    expect(Object.keys(browser).sort()).toEqual(Object.keys(cli).sort());
    for (const [p, bytes] of Object.entries(cli)) expect(Buffer.compare(Buffer.from(browser[p]!), bytes), p).toBe(0);
  });

  it("writes symbols.json and regroups trades when an ETF is mapped in the preview", async () => {
    const fake = new FakeGitHub(historyFiles());
    const gh = new GitHubClient(TOKEN, fake.fetch);
    const remote = await readHistory(gh, DATA, validate);
    const first = planImport(inputs(), remote.snap, { importedAt: IMPORTED_AT });
    const etf = first.result.unmappedEtfs[0]!;
    const mapping = { [etf.symbol]: { underlying: etf.guess.underlying!, type: "leveraged_etf" as const, leverage: etf.guess.leverage, direction: etf.guess.direction } };
    const plan = planImport(inputs(), remote.snap, { importedAt: IMPORTED_AT, mappings: mapping });
    expect(plan.result.unmappedEtfs.map((e) => e.symbol)).not.toContain(etf.symbol);
    expect(importMessage(plan)).toMatch(/: \+44 fills, 1 ETF mapped$/);
    const res = await commitFiles(gh, remote.state, importWrites(plan, ctx(remote), validate), importMessage(plan));
    expect(res!.paths).toContain("symbols.json");
    expect(JSON.parse(fake.text("symbols.json")!)[etf.symbol].underlying).toBe(etf.guess.underlying);
    const derived = JSON.parse(fake.text("derived/trades.json")!);
    expect(derived.trades.filter((t: { symbol: string }) => t.symbol === etf.symbol).every((t: { underlying: string }) => t.underlying === etf.guess.underlying)).toBe(true);
  });

  it("blocks writing when a file has errors", async () => {
    const fake = new FakeGitHub(historyFiles());
    const remote = await readHistory(new GitHubClient(TOKEN, fake.fetch), DATA, validate);
    const bad = [{ name: "Trading_XXX999_Transactions_1.csv", bytes: inputs([SCHWAB_A])[0]!.bytes }];
    const plan = planImport(bad, remote.snap, { importedAt: IMPORTED_AT });
    expect(plan.errors.length).toBeGreaterThan(0);
    expect(() => importWrites(plan, ctx(remote), validate)).toThrow(/errors/);
  });
});

describe("override commits", () => {
  it("replays staged actions on the current repo and commits overrides.json + derived/trades.json once", async () => {
    const { fake, gh } = await seededRepo();
    const remote = await readHistory(gh, DATA, validate);
    const [a, b] = remote.snap.derived!.trades.filter((t) => t.status === "closed");
    const staged: StagedAction[] = [
      { tradeIds: [a!.id, b!.id], action: { kind: "addTag", tag: "fixture-tag" } },
      { tradeIds: [a!.id], action: { kind: "setNote", note: "quick note" } },
    ];
    const plan = planOverrideCommit(remote.snap, staged, { generator: generatorVersion() }, validate);
    expect(Object.keys(plan.changes).sort()).toEqual([a!.id, b!.id].sort());
    expect(plan.preview.trades).toBe(2);
    const n = fake.commitCount();
    const res = await commitFiles(gh, remote.state, plan.files, plan.message);
    expect(res!.paths.sort()).toEqual(["derived/trades.json", "overrides.json"]);
    expect(fake.commitCount()).toBe(n + 1);
    expect(fake.commits.get(fake.head)!.message).toBe('Edit overrides: +tag "fixture-tag" on 2 trades; note on 1 trade (2 entries)');
    const derived = JSON.parse(fake.text("derived/trades.json")!);
    const ta = derived.trades.find((t: { id: string }) => t.id === a!.id);
    expect(ta.tags).toContain("fixture-tag");
    expect(ta.note).toBe("quick note");
    validate("overrides", JSON.parse(fake.text("overrides.json")!), "overrides.json");
  });

  it("keeps someone else's override edits when main moved (retry on the new overrides)", async () => {
    const { fake, gh } = await seededRepo();
    const remote = await readHistory(gh, DATA, validate);
    const [a, b] = remote.snap.derived!.trades;
    const staged: StagedAction[] = [{ tradeIds: [a!.id], action: { kind: "exclude", exclude: true } }];
    const compute = (r: RemoteHistory) => planOverrideCommit(r.snap, staged, { generator: generatorVersion() }, validate);
    fake.opts.beforePatch = (f) => {
      f.opts.beforePatch = undefined;
      const ov = { ...remote.snap.overrides, trades: { ...remote.snap.overrides.trades, [b!.id]: { tags: ["theirs"] } } };
      f.push({ "overrides.json": `${JSON.stringify(ov, null, 2)}\n` });
    };
    await commitPlan(gh, validate, remote, compute(remote), compute);
    const ov = JSON.parse(fake.text("overrides.json")!);
    expect(ov.trades[a!.id]).toEqual({ exclude: true });
    expect(ov.trades[b!.id]).toEqual({ tags: ["theirs"] });
  });

  it("refuses staged edits for trades that no longer exist", async () => {
    const { gh } = await seededRepo();
    const remote = await readHistory(gh, DATA, validate);
    expect(() => planOverrideCommit(remote.snap, [{ tradeIds: ["wb-000000000000"], action: { kind: "exclude", exclude: true } }], { generator: "x" }, validate)).toThrow(
      MissingTradesError,
    );
  });
});

describe("deploying…", () => {
  const commit = { sha: "b".repeat(40), date: "2026-10-05T14:00:00Z" };
  it("waits for a bundle built from our commit or a later one", () => {
    expect(deployIncludes({ loadedAt: "2026-10-05T14:01:00Z", history: { sha: "a".repeat(40), date: "2026-10-05T13:59:00Z" } }, commit)).toBe(false);
    expect(deployIncludes({ loadedAt: "2026-10-05T14:01:00Z", history: { sha: commit.sha, date: commit.date } }, commit)).toBe(true);
    expect(deployIncludes({ loadedAt: "2026-10-05T14:03:00Z", history: { sha: "c".repeat(40), date: "2026-10-05T14:02:00Z" } }, commit)).toBe(true);
  });
  it("for a test repo or a prices run, any bundle built after the time", () => {
    expect(deployIncludes({ loadedAt: "2026-10-05T13:59:59Z", history: null }, { date: commit.date })).toBe(false);
    expect(deployIncludes({ loadedAt: "2026-10-05T14:00:30Z", history: { sha: "a".repeat(40), date: "2026-10-01T00:00:00Z" } }, { date: commit.date })).toBe(true);
  });
});

describe("the app bundles the CLI's schemas and generator", () => {
  it("uses the same schema texts and derived/trades.json generator string", async () => {
    const remote = await import("../src/app/remote");
    expect(remote.schemas).toEqual(schemaTexts());
    expect(remote.GENERATOR).toBe(generatorVersion());
  });
});

describe("Import page file order", () => {
  it("applies exports oldest first, whatever order the file dialog gives", async () => {
    const { exportOrder } = await import("../src/core/import/plan");
    const picked = [
      "Webull_Orders_Records(10).csv", "Trading_XXX000_Transactions_20250320-170000.csv", "Webull_Orders_Records(1).csv",
      "Webull_Orders_Records.csv", "Trading_XXX000_Transactions_20250315-170000.csv", "Webull_Orders_Records(2).csv",
    ].map((name) => ({ name, lastModified: 0 }));
    expect(exportOrder(picked).map((f) => f.name)).toEqual([
      "Webull_Orders_Records.csv", "Webull_Orders_Records(1).csv", "Webull_Orders_Records(2).csv", "Webull_Orders_Records(10).csv",
      "Trading_XXX000_Transactions_20250315-170000.csv", "Trading_XXX000_Transactions_20250320-170000.csv",
    ]);
  });

  it("the reversed Webull order changes the kept symbol, which is why order matters", () => {
    const fake = new FakeGitHub(historyFiles());
    return readHistory(new GitHubClient(TOKEN, fake.fetch), DATA, validate).then((remote) => {
      const sym = (rels: string[]) => planImport(inputs(rels), remote.snap, { importedAt: IMPORTED_AT }).result.fills.map((f) => f.symbol);
      expect(sym([WEBULL_A, WEBULL_B])).not.toEqual(sym([WEBULL_B, WEBULL_A]));
    });
  });
});
