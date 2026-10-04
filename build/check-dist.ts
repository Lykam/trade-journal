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
import {
  DATA_BUCKET, decodeHeader, HEADER_BYTES, IMAGE_BUCKET, IMAGE_COUNT_BUCKET, IMAGE_NAME_RE, KIND_DATA, KIND_IMAGE, TAG_BYTES,
} from "../src/core/crypto";
import { isPublicLog, readQuotes, resolveQuotesFile } from "./fetch-quotes";
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

/**
 * Public third-party code the app bundles whose identifiers can look like
 * tickers (Ajv's code generator has short uppercase operator names). Like the app
 * source, it is public and holds no data (Q39).
 */
export const VENDOR_DIRS = ["node_modules/ajv/dist"];

/** All app source text (src/ and index.html, ticker-scanned before each commit) plus the bundled vendor code above. */
export function appSourceText(root = REPO_ROOT): string {
  const vendor = VENDOR_DIRS.flatMap((d) => (existsSync(join(root, d)) ? files(join(root, d)).filter((f) => f.endsWith(".js")) : []));
  return [...files(join(root, "src")), join(root, "index.html"), ...vendor].map((f) => readFileSync(f, "utf8")).join("\n");
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

/** Shannon entropy in bits per byte (8.0 for uniformly random bytes). */
export function entropy(bytes: Uint8Array): number {
  const counts = new Array<number>(256).fill(0);
  for (const b of bytes) counts[b]!++;
  let h = 0;
  for (const c of counts) if (c) h -= (c / bytes.length) * Math.log2(c / bytes.length);
  return h;
}

/** Problems with one encrypted file, or [] if it looks like a proper ciphertext of the expected kind. */
export function checkEncFile(bytes: Uint8Array, kind: number): string[] {
  try {
    const h = decodeHeader(bytes);
    const body = bytes.length - HEADER_BYTES - TAG_BYTES;
    const bucket = kind === KIND_DATA ? DATA_BUCKET : IMAGE_BUCKET;
    const out: string[] = [];
    if (h.kind !== kind) out.push("wrong kind");
    if (body <= 0 || body % bucket !== 0) out.push("not padded to its size bucket");
    if (entropy(bytes.subarray(HEADER_BYTES)) < 7.9) out.push("low entropy (not ciphertext?)");
    return out;
  } catch {
    return ["not an encrypted journal file"];
  }
}

/** App-shell files vite emits; anything else in an encrypted dist (a .json, .md, image…) is a leak. */
const SHELL_RE = /^(index\.html|favicon\.(ico|svg)|assets\/[\w.-]+\.(js|css|svg|woff2?))$/;

/** Structure of an encrypted dist (Q34). Returns problems as "<file>: <what>". */
export function checkEncrypted(distDir: string): string[] {
  const problems: string[] = [];
  if (!existsSync(join(distDir, "data.enc"))) problems.push("data.enc: missing (run npm run encrypt)");
  let imgs = 0;
  for (const f of files(distDir)) {
    const rel = relative(distDir, f).replace(/\\/g, "/");
    if (rel === "data.enc") {
      problems.push(...checkEncFile(readFileSync(f), KIND_DATA).map((p) => `${rel}: ${p}`));
    } else if (rel.startsWith("img/")) {
      imgs++;
      const name = rel.slice(4).replace(/\.enc$/, "");
      if (!rel.endsWith(".enc") || !IMAGE_NAME_RE.test(name)) problems.push(`${rel}: image file not named <32 hex>.enc`);
      problems.push(...checkEncFile(readFileSync(f), KIND_IMAGE).map((p) => `${rel}: ${p}`));
    } else if (!SHELL_RE.test(rel)) {
      problems.push(`${rel}: unexpected file in an encrypted dist`);
    }
  }
  if (imgs % IMAGE_COUNT_BUCKET !== 0 || imgs === 0) problems.push(`img/: file count not padded to a multiple of ${IMAGE_COUNT_BUCKET}`);
  return problems;
}

export function checkDist(
  distDir: string,
  allSymbols: Set<string>,
  log: (s: string) => void = console.log,
  sourceText = appSourceText(),
  names: Set<string> = new Set(),
  opts: { encrypted?: boolean; publicLog?: boolean } = {},
): number {
  const quiet = opts.publicLog ?? false;
  if (!existsSync(distDir)) {
    log(`check-dist: ${distDir} does not exist (run vite build)`);
    return 1;
  }
  // A symbol that is also a token in the app's own source (a UI word such as a
  // column label) can't be told apart from code, so it is skipped: dist/ can only
  // leak data that is not already in the public source.
  const inSource = new Set(findLeaks(sourceText, allSymbols));
  const symbols = new Set([...allSymbols].filter((s) => !inSource.has(s)));
  if (inSource.size && !quiet) log(`check-dist: ${inSource.size} symbol(s) also appear as words in the app source; skipped`);
  let leaks = 0;
  const list = files(distDir);
  for (const f of list) {
    // latin1 keeps every byte, so names and symbols are found in binary files too.
    const text = readFileSync(f, "latin1");
    // Random ciphertext regularly contains short uppercase runs, so in .enc files
    // only symbols of 6+ characters are searched; checkEncrypted proves the rest.
    const hits = findLeaks(text, f.endsWith(".enc") ? [...symbols].filter((s) => s.length >= 6) : symbols);
    if (hits.length) {
      leaks += hits.length;
      log(`check-dist: LEAK ${relative(distDir, f)} contains ${quiet ? "" : `${hits.length} `}traded symbol(s)`);
    }
    const rel = relative(distDir, f).replace(/\\/g, "/");
    if (findLeaks(rel, symbols).length || [...names].some((n) => rel.includes(n))) {
      leaks++;
      log(`check-dist: LEAK a dist file name contains a traded symbol or review/image name`);
    }
    const named = [...names].filter((n) => text.includes(n)).length;
    if (named) {
      leaks += named;
      log(`check-dist: LEAK ${relative(distDir, f)} contains ${quiet ? "" : `${named} `}review/image name(s)`);
    }
  }
  const encrypted = opts.encrypted || existsSync(join(distDir, "data.enc"));
  if (encrypted) {
    for (const p of checkEncrypted(distDir)) {
      leaks++;
      log(`check-dist: BAD ${p}`);
    }
  }
  const what = encrypted ? "encrypted dist" : "dist";
  log(
    quiet
      ? `check-dist: ${what} ${leaks ? "FAILED" : "clean"}`
      : `check-dist: ${symbols.size} symbols and ${names.size} review/image names checked against ${list.length} files (${what}) · ${leaks ? `${leaks} LEAKS` : "clean"}`,
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
    process.exitCode = checkDist(join(REPO_ROOT, "dist"), symbols, console.log, appSourceText(), playbookNames(playbook), {
      encrypted: process.argv.includes("--encrypted"),
      publicLog: isPublicLog(),
    });
  }
}
