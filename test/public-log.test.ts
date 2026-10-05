// Scripts the workflows run must never print a data file's contents, a ticker,
// a fill id or a private path into the public Actions log (SPEC §8, Q35, Q43).
// Each entry point runs as a real process with TJ_PUBLIC_LOG=1 against a temp
// history that is broken in a way whose error message would quote a canary.
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PublicError, publicSafeError } from "../build/public-log";
import { REPO_ROOT, validate } from "../cli/lib/history";
import { DataFileError, parseJsonFile } from "../src/core/data-error";
import { FIXTURES } from "./helpers";

const CANARY = "CNRYQX";
let tmp: string;

/** A trade-history copy of the fixtures with one file replaced. */
function history(name: string, file: string, text: string): string {
  const dir = join(tmp, name);
  cpSync(join(FIXTURES, "history"), dir, { recursive: true });
  mkdirSync(join(dir, "fills"), { recursive: true });
  writeFileSync(join(dir, file), text);
  return dir;
}

const BROKEN = {
  // Node 24's JSON.parse error quotes the text around the bad token.
  "malformed fills JSON": ["fills/2026.json", `{"schemaVersion": 1, "fills": [{"symbol": ${CANARY}}]}`],
  // Ajv's instance path starts with the object key, i.e. the ticker.
  "schema-invalid symbols.json": ["symbols.json", JSON.stringify({ [CANARY]: { underlying: CANARY, type: "leveraged_etf", leverage: "two", direction: "long" } })],
} as const;

function run(script: string, args: string[], env: Record<string, string>) {
  const r = spawnSync(process.execPath, ["--import", "tsx", join(REPO_ROOT, "build", script), ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, TJ_PUBLIC_LOG: "1", PLAYBOOK_DIR: join(tmp, "no-playbook"), QUOTES_FILE: join(tmp, "quotes.json"), ...env },
    timeout: 60_000,
  });
  return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
}

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "tj-publog-"));
  mkdirSync(join(tmp, "dist"));
  writeFileSync(join(tmp, "dist", "index.html"), "<!doctype html>");
});

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe.each(Object.entries(BROKEN))("with a %s", (what, [file, text]) => {
  const dir = () => history(what.replace(/\W+/g, "-"), file, text);

  it.each([
    ["check-dist.ts", [] as string[]],
    ["fetch-quotes.ts", ["--out", "OUT"]],
    ["encrypt.ts", ["--dist", "DIST"]],
  ])("%s exits non-zero and names only the file and the error kind", (script, args) => {
    const h = dir();
    const argv = args.map((a) => (a === "OUT" ? join(tmp, `${what}-quotes.json`) : a === "DIST" ? join(tmp, "dist") : a));
    const r = run(script, argv, { TRADE_HISTORY_DIR: h, SITE_PASSPHRASE: "synthetic canary passphrase 42" });
    expect(r.code).not.toBe(0);
    expect(r.out).not.toContain(CANARY);
    expect(r.out).not.toContain(h);
    expect(r.out).not.toMatch(/\bat .+:\d+:\d+/); // no stack
    expect(r.out).toContain(`${file}: ${what.startsWith("malformed") ? "invalid JSON" : "schema mismatch"}`);
  }, 60_000);
});

describe("public log helper", () => {
  it("keeps the full message locally, so the canary test above is meaningful", () => {
    const h = history("local", ...BROKEN["schema-invalid symbols.json"]);
    const r = run("check-dist.ts", [], { TRADE_HISTORY_DIR: h, TJ_PUBLIC_LOG: "" });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain(CANARY);
  }, 60_000);

  it("quotes-cache restore of a garbage cache prints nothing from it", () => {
    const cache = join(tmp, "garbage.enc");
    writeFileSync(cache, `{"quotes": {"${CANARY}": 1}}`);
    const r = run("quotes-cache.ts", ["restore", "--cache", cache, "--quotes", join(tmp, "restored.json")], { SITE_PASSPHRASE: "synthetic canary passphrase 42" });
    expect(r.code).toBe(0);
    expect(r.out).not.toContain(CANARY);
  }, 60_000);

  it("reduces errors to their label and kind", () => {
    let parseErr: unknown;
    try {
      JSON.parse(`{"symbol": ${CANARY}}`);
    } catch (e) {
      parseErr = e;
    }
    expect(publicSafeError(parseErr, "x", false)).toContain(CANARY);
    expect(publicSafeError(parseErr, "x", true)).toBe("x: a data file is not valid JSON");
    expect(() => parseJsonFile(`[${CANARY}]`, "fills/2026.json")).toThrow(DataFileError);
    let schemaErr: unknown;
    try {
      validate("symbols", { [CANARY]: { underlying: 1 } }, "symbols.json");
    } catch (e) {
      schemaErr = e;
    }
    expect(schemaErr).toBeInstanceOf(DataFileError);
    expect(publicSafeError(schemaErr, "x", true)).toBe("x: symbols.json: schema mismatch");
    expect(publicSafeError(new Error(`ENOENT: ${CANARY}`), "x", true)).toBe("x: failed (Error)");
    expect(publicSafeError(new PublicError("SITE_PASSPHRASE is not set"), "x", true)).toBe("x: SITE_PASSPHRASE is not set");
    expect(publicSafeError("thrown string", "x", true)).toBe("x: failed (error)");
  });
});
