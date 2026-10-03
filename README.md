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

Status: specification complete; implementation starts with milestone 1 (data
core).
