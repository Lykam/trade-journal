# Trade Journal

A personal, Tradervue-style trade journal with weekly day/swing "temperature
gauges" that recommend full, ½ or ¼ size based on this week's win rate versus
the rolling 90-day average.

- **This repo (public):** app source code only. It contains no trade data.
- **Data:** read at build time from two private repos, `trade-history`
  (normalized Schwab and Webull fills) and `Playbook` (trade reviews and
  chart images). The data is published to GitHub Pages **encrypted** and
  decrypted in the browser with a passphrase.

See [`docs/SPEC.md`](docs/SPEC.md) for the full specification and the
decisions log (§10).

Status: milestones 1–7 are done and live at https://lykam.github.io/trade-journal/ (encrypted; owner only).

The Import page and the Commit buttons need a fine-grained GitHub token (Contents: read and write on trade-history only), entered in Settings; see SPEC §2 and Q38.

## Development

```
npm install
npm test                 # Vitest, synthetic fixtures only
npm run import -- --dry-run [--all] [files…]   # preview an import into ../trade-history
npm run trades -- --date 2026-10-01 --style swing
npm run verify           # local only: recompute and check derived/trades.json
npm run quotes           # price open positions -> quotes.json (gitignored; prints counts only)
npm run dev              # app at http://localhost:5173/trade-journal/ with local data
npm run dev:demo         # the same on synthetic fixtures (port 5174), no real data needed
npm run scan             # before committing: check added lines for real tickers / review names
npm run build            # production build + leak guard (no data in dist/)
SITE_PASSPHRASE=… npm run encrypt   # bundle + encrypt into dist/data.enc, dist/img/*.enc
npm run check:dist -- --encrypted   # leak guard on the encrypted dist
npm run preview:demo     # encrypted production site on fixtures (port 4174), demo passphrase printed
```

`npm run dev` serves plaintext data from `$TRADE_HISTORY_DIR` and Playbook
reviews and chart images from `$PLAYBOOK_DIR` (default `../Playbook`) through
dev-only endpoints that are never part of `vite build`. Add
`?now=2026-10-02T15:00:00-04:00` to the URL to view the dashboard as of
another time.

The CLI reads and writes `$TRADE_HISTORY_DIR` (default `../trade-history`).

## Deploy

`.github/workflows/deploy.yml` (push to main, `repository_dispatch: data-updated`
from the data repos, manual) and `prices.yml` (every 15 min in market hours plus
~16:20 ET) both call `build-deploy.yml`: test → check out the private repos →
build → quotes → encrypt → leak guard → GitHub Pages. Secrets: read-only deploy
keys `TRADE_HISTORY_DEPLOY_KEY` / `PLAYBOOK_DEPLOY_KEY` and `SITE_PASSPHRASE` here, `DISPATCH_TOKEN` in `trade-history` and `Playbook`
(SPEC §2, §7).
