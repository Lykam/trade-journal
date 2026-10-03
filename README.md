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

Status: milestone 1 (data core) complete. Next: milestone 2, gauges and dashboard.

## Development

```
npm install
npm test                 # Vitest, synthetic fixtures only
npm run import -- --dry-run [--all] [files…]   # preview an import into ../trade-history
npm run trades -- --date 2026-10-01 --style swing
npm run verify           # local only: recompute and check derived/trades.json
```

The CLI reads and writes `$TRADE_HISTORY_DIR` (default `../trade-history`).
