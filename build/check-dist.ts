// npm run check:dist  (also runs at the end of npm run build)
//
// Leak guard (SPEC §7): fail if dist/ contains any traded symbol from
// trade-history in plaintext. Prints counts and file names only, never symbols.
// Skips with a note when no trade-history checkout is available.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { loadHistory, REPO_ROOT, resolveHistoryDir } from "../cli/lib/history";
import { readQuotes, resolveQuotesFile } from "./fetch-quotes";

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Symbols that appear as whole tokens. 1–2 letter symbols only count inside quotes (minified code is full of short identifiers). */
export function findLeaks(text: string, symbols: Iterable<string>): string[] {
  const hits: string[] = [];
  for (const s of symbols) {
    const re = s.length <= 2 ? new RegExp(`["'\`]${escape(s)}["'\`]`) : new RegExp(`(?<![A-Za-z0-9_$])${escape(s)}(?![A-Za-z0-9_$])`);
    if (re.test(text)) hits.push(s);
  }
  return hits;
}

/** All app source text (src/ and index.html), which is public anyway and ticker-scanned before each commit. */
export function appSourceText(root = REPO_ROOT): string {
  return [...files(join(root, "src")), join(root, "index.html")].map((f) => readFileSync(f, "utf8")).join("\n");
}

/**
 * A symbol that is also a token in the app's own source (a UI word such as a
 * column label) can't be told apart from code, so it is skipped: dist/ can only
 * leak data that is not already in the public source.
 */
export function checkDist(
  distDir: string,
  allSymbols: Set<string>,
  log: (s: string) => void = console.log,
  sourceText = appSourceText(),
): number {
  if (!existsSync(distDir)) {
    log(`check-dist: ${distDir} does not exist (run vite build)`);
    return 1;
  }
  const inSource = new Set(findLeaks(sourceText, allSymbols));
  const symbols = new Set([...allSymbols].filter((s) => !inSource.has(s)));
  if (inSource.size) log(`check-dist: ${inSource.size} symbol(s) also appear as words in the app source; skipped`);
  let leaks = 0;
  const list = files(distDir);
  for (const f of list) {
    const hits = findLeaks(readFileSync(f, "utf8"), symbols);
    if (hits.length) {
      leaks += hits.length;
      log(`check-dist: LEAK ${relative(distDir, f)} contains ${hits.length} traded symbol(s)`);
    }
  }
  log(`check-dist: ${symbols.size} symbols checked against ${list.length} files · ${leaks ? `${leaks} LEAKS` : "clean"}`);
  return leaks ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const dir = resolveHistoryDir();
  if (!existsSync(join(dir, "config.json"))) {
    console.log("check-dist: no trade-history checkout; skipped");
  } else {
    const h = loadHistory(dir);
    const symbols = new Set<string>([
      ...h.fills.map((f) => f.symbol),
      ...(h.derived?.trades ?? []).flatMap((t) => [t.symbol, t.underlying]),
      ...Object.keys(readQuotes(resolveQuotesFile())?.quotes ?? {}),
    ]);
    process.exitCode = checkDist(join(REPO_ROOT, "dist"), symbols);
  }
}
