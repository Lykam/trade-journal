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

Status: milestone 3 (trades, trade detail, calendar, Playbook reviews, local) complete. Next: milestone 4, encrypted deploy.

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
```

`npm run dev` serves plaintext data from `$TRADE_HISTORY_DIR` and Playbook
reviews and chart images from `$PLAYBOOK_DIR` (default `../Playbook`) through
dev-only endpoints that are never part of `vite build`. Add
`?now=2026-10-02T15:00:00-04:00` to the URL to view the dashboard as of
another time.

The CLI reads and writes `$TRADE_HISTORY_DIR` (default `../trade-history`).
