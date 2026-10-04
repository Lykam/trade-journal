// npm run check:dist  (also runs at the end of npm run build)
//
// Leak guard (SPEC §7): fail if dist/ contains, in plaintext, any traded symbol
// from trade-history, any Playbook review file name or ticker, or any chart image
// name. Prints counts and dist file names only, never the matched values.
// Skips with a note when no trade-history checkout is available.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { loadHistory, REPO_ROOT, resolveHistoryDir } from "../cli/lib/history";
import { parseReviewHeader } from "../src/core/reviews/parse-header";
import { reviewIdOf } from "../src/core/reviews/join";
import { readQuotes, resolveQuotesFile } from "./fetch-quotes";
import { loadPlaybook, resolvePlaybookDir } from "./playbook";

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
/**
 * Private names that must never reach dist/: each review's file name and stem
 * ("2026-07-27-ABC.md", "2026-07-27-ABC") and each image's path and file name.
 */
export function playbookNames(playbook: { reviews: Array<{ path: string }>; images: string[] }): Set<string> {
  const names = new Set<string>();
  for (const r of playbook.reviews) {
    names.add(r.path.split("/").pop()!);
    names.add(reviewIdOf(r.path));
  }
  for (const i of playbook.images) {
    names.add(i);
    names.add(i.split("/").pop()!);
  }
  return names;
}

export function checkDist(
  distDir: string,
  allSymbols: Set<string>,
  log: (s: string) => void = console.log,
  sourceText = appSourceText(),
  names: Set<string> = new Set(),
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
    const text = readFileSync(f, "utf8");
    const hits = findLeaks(text, symbols);
    if (hits.length) {
      leaks += hits.length;
      log(`check-dist: LEAK ${relative(distDir, f)} contains ${hits.length} traded symbol(s)`);
    }
    const named = [...names].filter((n) => text.includes(n)).length;
    if (named) {
      leaks += named;
      log(`check-dist: LEAK ${relative(distDir, f)} contains ${named} review/image name(s)`);
    }
  }
  log(
    `check-dist: ${symbols.size} symbols and ${names.size} review/image names checked against ${list.length} files · ${leaks ? `${leaks} LEAKS` : "clean"}`,
  );
  return leaks ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const dir = resolveHistoryDir();
  if (!existsSync(join(dir, "config.json"))) {
    console.log("check-dist: no trade-history checkout; skipped");
  } else {
    const h = loadHistory(dir);
    const playbook = loadPlaybook(resolvePlaybookDir()) ?? { reviews: [], images: [] };
    const symbols = new Set<string>([
      ...h.fills.map((f) => f.symbol),
      ...(h.derived?.trades ?? []).flatMap((t) => [t.symbol, t.underlying]),
      ...Object.keys(readQuotes(resolveQuotesFile())?.quotes ?? {}),
      ...playbook.reviews.map((r) => parseReviewHeader(r.markdown).ticker).filter((t): t is string => t !== null),
    ]);
    process.exitCode = checkDist(join(REPO_ROOT, "dist"), symbols, console.log, appSourceText(), playbookNames(playbook));
  }
}
