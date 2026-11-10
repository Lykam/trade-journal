// The public demo's build output (SPEC §7, Q50): what may be in it. Used by
// check-demo (after npm run build:demo) and by check-dist --encrypted, which
// checks the copy deployed under dist/demo/.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { DEMO_PASSPHRASE } from "./preview-demo-passphrase.ts";

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
