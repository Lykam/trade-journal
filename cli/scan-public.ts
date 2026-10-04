// npm run scan  (local only; never in CI)
//
// Before committing to this PUBLIC repo: check what a commit would add (lines
// added since HEAD, staged or not, plus new non-ignored files; `--all` checks
// every file instead), plus an optional commit message, for real traded symbols
// from ../trade-history and real review/image names and review tickers from
// ../Playbook. Hits are printed to the local terminal only, so a false positive
// (a ticker that is also a UI word) can be judged by eye.
//
//   npm run scan [-- --all] [-- --message "commit message"]
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { findLeaks, playbookNames } from "../build/check-dist";
import { loadPlaybook, resolvePlaybookDir } from "../build/playbook";
import { parseReviewHeader } from "../src/core/reviews/parse-header";
import { loadHistory, REPO_ROOT, resolveHistoryDir } from "./lib/history";

const args = process.argv.slice(2);
const mi = args.indexOf("--message");
const message = mi >= 0 ? (args[mi + 1] ?? "") : null;

const historyDir = resolveHistoryDir();
if (!existsSync(join(historyDir, "config.json"))) {
  console.log("scan: no trade-history checkout; nothing to compare against");
  process.exit(0);
}
const h = loadHistory(historyDir);
const playbook = loadPlaybook(resolvePlaybookDir()) ?? { reviews: [], images: [] };
const symbols = new Set<string>([
  ...h.fills.map((f) => f.symbol),
  ...(h.derived?.trades ?? []).flatMap((t) => [t.symbol, t.underlying]),
  ...Object.values(h.symbols).map((s) => s.underlying),
  ...playbook.reviews.map((r) => parseReviewHeader(r.markdown).ticker).filter((t): t is string => t !== null),
]);
const names = playbookNames(playbook);

const git = (...a: string[]) => execFileSync("git", a, { cwd: REPO_ROOT, encoding: "utf8" }).split("\n").filter(Boolean);
const scannable = (f: string) => {
  const p = join(REPO_ROOT, f);
  return existsSync(p) && statSync(p).isFile() && !/\.(png|jpe?g|gif|webp|bmp|ico)$/i.test(f) && f !== "package-lock.json";
};
const untracked = git("ls-files", "--others", "--exclude-standard").filter(scannable);
const all = args.includes("--all");
const files = all ? [...new Set([...git("ls-files"), ...untracked])].filter(scannable) : untracked;

/** Lines added since HEAD, per file. */
function addedLines(): Map<string, string> {
  const out = new Map<string, string>();
  let file = "";
  for (const line of git("diff", "HEAD", "--unified=0", "--no-color", "--", ".", ":(exclude)package-lock.json")) {
    if (line.startsWith("+++ ")) file = line.slice(6);
    else if (line.startsWith("+") && file) out.set(file, `${out.get(file) ?? ""}${line.slice(1)}\n`);
  }
  return out;
}

let hits = 0;
const check = (label: string, text: string) => {
  const s = findLeaks(text, symbols);
  const n = [...names].filter((x) => text.includes(x));
  if (s.length || n.length) {
    hits += s.length + n.length;
    console.log(`scan: ${label}: ${[...s, ...n].join(", ")}`);
  }
};
for (const f of files) check(f, readFileSync(join(REPO_ROOT, f), "utf8"));
const added = all ? new Map<string, string>() : addedLines();
for (const [f, text] of added) check(`${f} (added lines)`, text);
if (message !== null) check("commit message", message);
console.log(
  `scan: ${symbols.size} symbols, ${names.size} review/image names vs ${all ? `all ${files.length} files` : `${files.length} new files + ${added.size} changed files`}${message !== null ? " + message" : ""} · ${hits ? `${hits} HIT(S)` : "clean"}`,
);
process.exitCode = hits ? 1 : 0;
