// npm run build:demo runs this after `vite build --mode demo` (SPEC §7, Q50).
//
// The demo build must be an app shell only, with nothing that can reach the
// real site's vault: no data.enc or img/ fetch, no tj.key / tj.gh storage, no
// dev data loader, no OPEN DEMO passphrase, no GitHub API in its CSP. With a
// trade-history checkout next to this repo, the plaintext leak guard also runs
// on it, so a generator ticker that is really traded fails the build.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { REPO_ROOT, resolveHistoryDir } from "../cli/lib/history.ts";
import { appSourceText, checkDist } from "./check-dist.ts";
import { resolveQuotesFile } from "./fetch-quotes.ts";
import { resolvePlaybookDir } from "./playbook.ts";
import { DEMO_PASSPHRASE } from "./preview-demo-passphrase.ts";
import { privateTokens } from "./private-tokens.ts";
import { runMain } from "./public-log.ts";

export const DEMO_DIR = "dist-demo";
export const DEMO_BASE = "/trade-journal/demo/";

/** Strings that would mean the demo touches the vault, the dev data or the encrypted files. */
export const FORBIDDEN = ["data.enc", "img/", "tj.key", "tj.gh", "__data", "OPEN DEMO", DEMO_PASSPHRASE, "api.github.com"];

/** App-shell files only (the same rule as an encrypted dist, minus data.enc and img/). */
export const DEMO_SHELL_RE = /^(index\.html|favicon\.(ico|svg)|assets\/[\w.-]+\.(js|css|svg|woff2?))$/;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n)) : [join(dir, n)]));
}

/** Problems with a demo build, as "<file>: <what>"; [] when it is clean. */
export function checkDemoDist(dir: string, base = DEMO_BASE): string[] {
  if (!existsSync(join(dir, "index.html"))) return [`${dir}: no index.html (run vite build --mode demo)`];
  const problems: string[] = [];
  for (const f of files(dir)) {
    const rel = relative(dir, f).replace(/\\/g, "/");
    if (!DEMO_SHELL_RE.test(rel)) problems.push(`${rel}: not an app-shell file`);
    const text = readFileSync(f, "latin1");
    for (const s of FORBIDDEN) if (text.includes(s)) problems.push(`${rel}: contains "${s}"`);
  }
  const html = readFileSync(join(dir, "index.html"), "utf8");
  if (!html.includes(`src="${base}assets/`)) problems.push(`index.html: scripts are not under ${base}`);
  if (!/connect-src 'self';/.test(html)) problems.push("index.html: CSP connect-src is not 'self' only");
  if (!files(dir).some((f) => f.endsWith(".js") && readFileSync(f, "utf8").includes("DEMO · synthetic data"))) problems.push("assets: no DEMO marker (not a demo build?)");
  return problems;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  await runMain("check-demo", () => {
    const dir = join(REPO_ROOT, process.argv[2] ?? DEMO_DIR);
    const problems = checkDemoDist(dir, process.env.TJ_BASE ?? DEMO_BASE);
    for (const p of problems) console.error(`check-demo: BAD ${p}`);
    const tokens = privateTokens(resolveHistoryDir(), resolvePlaybookDir(), resolveQuotesFile());
    const leaks = tokens ? checkDist(dir, tokens.symbols, console.log, appSourceText(), tokens.names) : 0;
    if (!tokens) console.log("check-demo: no trade-history checkout; leak guard skipped");
    console.log(`check-demo: ${problems.length || leaks ? "FAILED" : "clean"}`);
    return problems.length || leaks ? 1 : 0;
  });
}
