// One-line explanations for what the demo build switches off (Q50). Only demo
// code paths import these, so real builds drop them.
export const DEMO_COMMIT_NOTE = "Demo: on the real site this writes one commit to a private repo.";
export const DEMO_REFRESH_NOTE = "Demo: prices are generated here; on the real site this starts the prices workflow.";
export const DEMO_TOKEN_NOTE = "Demo: the real site keeps an encrypted GitHub token here for imports and edits. The demo has none and sends nothing anywhere.";
export const DEMO_IMPORT_NOTE =
  "Demo: drop a Webull or Schwab CSV (or a sample below). It is parsed and previewed in your browser against the demo history; nothing is uploaded.";
