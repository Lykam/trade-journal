// npm run build:demo runs this after `vite build --mode demo` (SPEC §7, Q50).
//
// The demo build must be an app shell only, with nothing that can reach the
// real site's vault: no data.enc or img/ fetch, no tj.key / tj.gh storage, no
// dev data loader, no OPEN DEMO passphrase, no GitHub API in its CSP. With a
// trade-history checkout next to this repo, the plaintext leak guard also runs
// on it, so a generator ticker that is really traded fails the build.
import { join, resolve } from "node:path";
import { REPO_ROOT, resolveHistoryDir } from "../cli/lib/history.ts";
import { appSourceText, checkDist } from "./check-dist.ts";
import { resolveQuotesFile } from "./fetch-quotes.ts";
import { resolvePlaybookDir } from "./playbook.ts";
import { checkDemoDist, DEMO_BASE, DEMO_DIR } from "./demo-dist.ts";
import { privateTokens } from "./private-tokens.ts";
import { isPublicLog, runMain } from "./public-log.ts";

export { checkDemoDist } from "./demo-dist.ts";

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  await runMain("check-demo", () => {
    const dir = join(REPO_ROOT, process.argv[2] ?? DEMO_DIR);
    const problems = checkDemoDist(dir, process.env.TJ_BASE ?? DEMO_BASE);
    for (const p of problems) console.error(`check-demo: BAD ${p}`);
    const tokens = privateTokens(resolveHistoryDir(), resolvePlaybookDir(), resolveQuotesFile());
    const leaks = tokens ? checkDist(dir, tokens.symbols, console.log, appSourceText(), tokens.names, { publicLog: isPublicLog() }) : 0;
    if (!tokens) console.log("check-demo: no trade-history checkout; leak guard skipped");
    console.log(`check-demo: ${problems.length || leaks ? "FAILED" : "clean"}`);
    return problems.length || leaks ? 1 : 0;
  });
}
