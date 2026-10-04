// npm run dev:demo
//
// Runs the dev server on the synthetic fixtures (fake tickers only): a temporary
// trade-history built from test/fixtures/{history,expected}, the fixture
// Playbook in test/fixtures/playbook, and one made-up quote. Handy for checking
// the review, calendar and trade pages without touching real data.
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "vite";
import { REPO_ROOT } from "../cli/lib/history";

const fixtures = join(REPO_ROOT, "test", "fixtures");
const dir = mkdtempSync(join(tmpdir(), "tj-demo-"));
const history = join(dir, "history");
cpSync(join(fixtures, "history"), history, { recursive: true });
mkdirSync(join(history, "fills"));
mkdirSync(join(history, "derived"));
cpSync(join(fixtures, "expected", "fills-2025.json"), join(history, "fills", "2025.json"));
cpSync(join(fixtures, "expected", "trades.json"), join(history, "derived", "trades.json"));
writeFileSync(
  join(dir, "quotes.json"),
  JSON.stringify({ asOf: "2025-03-20T19:45:00Z", quotes: { OPSW: { price: 12.5, time: "2025-03-20T19:45:00Z", marketState: "REGULAR" } } }),
);
process.env.TRADE_HISTORY_DIR = history;
process.env.QUOTES_FILE = join(dir, "quotes.json");
process.env.PLAYBOOK_DIR = join(fixtures, "playbook");

const server = await createServer({ root: REPO_ROOT, server: { port: Number(process.env.PORT ?? 5174) } });
await server.listen();
server.printUrls();
console.log("  demo data: synthetic fixtures (add ?now=2025-03-20T16:00:00-04:00 to see the fixture week)");
