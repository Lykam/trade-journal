// npm run preview:demo
//
// The production site, locally, on the synthetic fixtures: vite build, encrypt
// the fixture bundle with a demo passphrase, check the encrypted dist, then
// serve it with `vite preview`. For trying the lock screen without real data.
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build, preview } from "vite";
import { REPO_ROOT } from "../cli/lib/history";
import { bundleData } from "./bundle-data";
import { checkEncrypted } from "./check-dist";
import { encryptBundle } from "./encrypt";

export const DEMO_PASSPHRASE = "demo passphrase for fixtures";

const fixtures = join(REPO_ROOT, "test", "fixtures");
const dir = mkdtempSync(join(tmpdir(), "tj-preview-"));
const history = join(dir, "history");
cpSync(join(fixtures, "history"), history, { recursive: true });
mkdirSync(join(history, "fills"));
mkdirSync(join(history, "derived"));
cpSync(join(fixtures, "expected", "fills-2025.json"), join(history, "fills", "2025.json"));
cpSync(join(fixtures, "expected", "trades.json"), join(history, "derived", "trades.json"));
const quotesFile = join(dir, "quotes.json");
writeFileSync(quotesFile, JSON.stringify({ asOf: "2025-03-20T19:45:00Z", quotes: { OPSW: { price: 12.5, time: "2025-03-20T19:45:00Z", marketState: "REGULAR" } } }));

const outDir = join(dir, "dist");
await build({ root: REPO_ROOT, mode: "production", logLevel: "warn", build: { outDir, emptyOutDir: true } });
const { bundle, images } = bundleData({ historyDir: history, quotesFile, playbookDir: join(fixtures, "playbook") });
encryptBundle(bundle, images, DEMO_PASSPHRASE, outDir);
const problems = checkEncrypted(outDir);
if (problems.length) throw new Error(`encrypted dist problems:\n${problems.join("\n")}`);

const server = await preview({ root: REPO_ROOT, build: { outDir }, preview: { port: Number(process.env.PORT ?? 4174) } });
server.printUrls();
console.log(`  demo passphrase: "${DEMO_PASSPHRASE}" (add ?now=2025-03-20T16:00:00-04:00 to see the fixture week)`);
