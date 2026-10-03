# Trade Journal — Spec (v0.4)

A personal, Tradervue-style trade journal and weekly "temperature gauge"
dashboard. Trades from Schwab and Webull are normalized into JSON in a
dedicated **trade-history** repo. Playbook reviews come from the existing
**Playbook** repo. The app itself lives in its own public repo, which also
hosts the site on GitHub Pages, with all data encrypted.

---

## 1. Goals

1. **One normalized trade history** across Schwab and Webull, stored as JSON in
   git with no database. It lives in its own repo so other apps can read it.
   Single-stock ETF trades (PALU) count toward their source ticker (PANW)
   while remembering they were ETF trades.
2. **Import from either place:** upload a CSV in the web app, or have Claude
   (or a CLI) import it from `~/Downloads`. Both paths must produce identical
   results.
3. **Weekly temperature gauges**, one for day trades and one for swing trades.
   Each compares this week's win rate with your rolling 90-day win rate and
   tells you whether to trade at **full, ½, or ¼ size**. The swing gauge also
   counts open positions at their current price.
4. **A journal like Tradervue:** a trade list, trade detail, P&L calendar,
   equity curve and breakdown stats.
5. **Playbook reviews in the app:** render `Reviews/*.md`, including images,
   linked to the matching trades.
6. **Hosted free and kept private:** anyone can load the page, but only you
   can read the data.

### Non-goals (v1)

- Options, short selling, futures and crypto. Only long stocks and ETFs; the
  schema should not rule these out later.
- TradingView / candlestick charts and MFE/MAE (see §11). Charts come from Playbook images.
- Multiple users, real-time broker API sync, and editing reviews in the app.
  Reviews are still written with the `playbook-review` skill.

---

## 2. Repositories and architecture

There are three repos, each with one job:

| Repo | Visibility | Owns | Written by |
|---|---|---|---|
| `Lykam/trade-journal` | **Public** | App source code, shared TS logic (parsers, grouping, gauge), import CLI, deploy workflow. **No data.** It serves GitHub Pages. | You and Claude (code) |
| `Lykam/trade-history` | Private | Normalized fills, overrides, config, derived trades, JSON Schema. The source of truth for "what I traded". | The import CLI (via Claude) or the web app's Import page |
| `Lykam/Playbook` | Private | `Reviews/*.md`, `Images/`, `Template.md`, the review skills. **Unchanged.** | The `playbook-review` skill |

```
 trade-history (private)          Playbook (private)
   fills/ overrides.json            Reviews/*.md  Images/
   derived/trades.json                    │
        │  on push: repository_dispatch   │ on push: repository_dispatch
        └──────────────┬──────────────────┘
                       ▼                      ◀── every 15 min in market hours
 trade-journal (PUBLIC) — GitHub Action           (prices.yml)
   checkout self + trade-history + Playbook (read-only token)
   test → build app → fetch quotes for open positions (Yahoo)
        → bundle data → ENCRYPT → actions/deploy-pages
                       │
                       ▼
 GitHub Pages: index.html, assets/*.js, data.enc, img/<hash>.enc
                       │  browser: passphrase → key → decrypt in memory
                       ▼
       Dashboard / Journal / Reviews
                       │  Import CSV / edit overrides
                       ▼
 GitHub Contents API → commit to trade-history → dispatch → redeploy (~1–2 min)
```

### Key consequences

- **No separate "site" repo.** The app repo is public, so it serves Pages
  itself. The deploy uses `actions/deploy-pages`, which uploads the build as
  an artifact, so **ciphertext is never committed** to any branch and no
  history of encrypted data builds up in git.
- **Cross-repo triggers.** `trade-history` and `Playbook` each get a tiny
  workflow that fires `repository_dispatch` (`data-updated`) at
  `trade-journal` on push. The journal also rebuilds on its own pushes and
  on `workflow_dispatch` (manual).
- **The public repo must never contain real trade data.** This includes test
  fixtures (§7) and anything printed in CI logs.
- **Local dev** expects sibling checkouts:
  `GitProjects/{trade-journal,trade-history,Playbook}`. Override the
  locations with the env vars `TRADE_HISTORY_DIR` and `PLAYBOOK_DIR`.
  `npm run dev` reads the plaintext data from those folders directly, with no
  encryption.

### Tokens and secrets

| Secret | Where | Scope |
|---|---|---|
| `DATA_READ_TOKEN` | Actions secret in `trade-journal` | Fine-grained PAT: **Contents: read** on `trade-history` and `Playbook` |
| `SITE_PASSPHRASE` | Actions secret in `trade-journal` | Encrypts the bundle |
| `DISPATCH_TOKEN` | Actions secret in `trade-history` and `Playbook` | Fine-grained PAT: **Contents: read & write** on `trade-journal` only. GitHub requires write access to send `repository_dispatch`. |
| Browser PAT | Entered in app Settings and stored encrypted in `localStorage` | Fine-grained PAT: **Contents: read & write** on `trade-history` only |

The browser never gets write access to `Playbook`, and reviews are read-only
in the app.

### Encryption

- AES-256-GCM. The key is derived from a passphrase with PBKDF2-SHA256 at
  600k iterations and a random salt. Both steps use WebCrypto in the browser
  and Node `crypto` in the Action.
- In the browser, the derived key (not the passphrase) is kept in
  `sessionStorage`. An optional "remember on this device" setting moves it to
  `localStorage`.
- The published site contains no plaintext tickers, dates, file names or
  counts. Image file names are hashes.

### Cost

$0: GitHub Free, Pages and Actions minutes. (If you later move to AWS, S3 and
CloudFront with the same static build cost about $1/month, and the encryption
model does not change.)

---

## 3. `trade-history` repo: the data contract

This repo is the shared contract other apps rely on, so it documents itself.

```
trade-history/
  README.md                   format overview, how to import, how to consume
  schema/                     copied from trade-journal/schema by the importer (Q17)
    fills.schema.json         JSON Schema for fills/<year>.json
    overrides.schema.json
    config.schema.json
    symbols.schema.json
    trades.schema.json        JSON Schema for derived/trades.json
  fills/2026.json             SOURCE OF TRUTH (append-only via importer)
  overrides.json              manual edits (style, tags, exclude, opening positions)
  symbols.json                single-stock ETF → underlying map (§3.4)
  config.json                 grouping + gauge settings
  derived/trades.json         GENERATED: fills + overrides → round-trip trades
  imports/raw/                archive of every original broker CSV (always kept)
  .github/workflows/
    validate.yml              schema-validate every JSON file on push
    notify-journal.yml        repository_dispatch → trade-journal
```

**Why commit `derived/trades.json`?** So other apps, such as the
`playbook-review` skill or a future tool, can read finished trades without
reimplementing the grouping logic. Only the journal's CLI and app write it, it
is regenerated on every import or override change, and it starts with
`"generated": true` plus the generator version. Consumers that want different
grouping can ignore it and read `fills/`.

### 3.1 `fills/<year>.json`

```jsonc
{
  "schemaVersion": 1,
  "fills": [
    {
      "id": "wb-3f9a1c2e07d4",        // broker prefix + 12-hex-char stable hash (see §4.3)
      "broker": "webull",             // "webull" | "schwab"
      "account": "webull",            // "schwab-main", room for more accounts later
      "symbol": "ABCD",
      "assetType": "equity",          // future: "option"
      "side": "buy",                  // "buy" | "sell"
      "qty": 1,
      "price": 3.50,
      "fees": 0,                      // Schwab "Fees & Comm"; Webull export has none
      "executedAt": "2026-01-15T09:45:05-05:00",
      "timePrecision": "second",      // "second" (Webull) | "day" (Schwab)
      "seq": 0,                       // order within the same timestamp, for "day" precision
      "source": "Webull_Orders_Records(6).csv",
      "importedAt": "2026-10-03T14:02:11Z"
    }
  ]
}
```

- One file per year by **execution** date. Size is roughly 1–1.5 MB/year at
  the expected pace (a few thousand fills per year).
- Sorted by `executedAt`, `seq`, `id`, and written with stable 2-space
  formatting so diffs stay small.

### 3.2 `overrides.json`

```jsonc
{
  "trades": {
    "wb-3f9a1c2e07d4": { "style": "swing", "exclude": false, "tags": ["imbalance"], "note": "" }
  },
  "openingPositions": [
    // positions held before the earliest imported fill, so a lone sell is still matched
    { "account": "schwab-main", "symbol": "XYZ", "qty": 10, "avgPrice": 12.30, "openedAt": "2026-05-01" }
  ]
}
```

### 3.3 `config.json`

```jsonc
{
  "timezone": "America/New_York",
  "weekStartsOn": "monday",
  "accounts": ["schwab-main", "webull"],      // anything else in an export is rejected
  "schwabAccounts": { "123": "schwab-main" }, // id in Trading_XXX<id>_Transactions_*.csv → account (Q16)
  "webullAccount": "webull",
  "styleByAccount": { "schwab-main": "swing", "webull": "day" },  // intent default; override per trade
  "gauge": {
    "baselineDays": 90,
    "excludeCurrentWeekFromBaseline": true,
    "minSample": { "day": 5, "swing": 3 },
    "bands": { "halfSizeBelowPts": 0, "quarterSizeBelowPts": 10 },
    "swingIncludesOpenPositions": true
  }
}
```

### 3.4 `symbols.json`: single-stock ETF → source ticker

Single-stock leveraged ETFs are traded as a play on their source stock (PALU
for PANW, MSFU for MSFT, HYNX for SK Hynix). This file maps each ETF to its
underlying, so the trade counts toward the source ticker while still recording
that it was an ETF trade.

```jsonc
{
  "PALU": { "underlying": "PANW",  "type": "leveraged_etf", "leverage": 2, "direction": "long", "issuer": "Direxion" },
  "MSFU": { "underlying": "MSFT",  "type": "leveraged_etf", "leverage": 2, "direction": "long", "issuer": "Direxion" },
  "HYNX": { "underlying": "000660.KS", "type": "leveraged_etf", "leverage": 2, "direction": "long", "issuer": "T-REX" }
  // "direction": "inverse" for bear ETFs (e.g. a 2X short fund). Holding one long
  // is a bearish bet on the underlying, and analysis can flag it as such.
}
```

- A symbol that isn't listed is a plain stock or ETF, and its underlying is
  itself.
- **Grouping by the ETF's own symbol.** Positions, flat-to-flat trades and P&L
  are always computed on the ETF itself (PALU shares are not PANW shares).
- **Grouping by underlying.** Ideas, reviews, live-quote labels and
  "by ticker" reports group by the underlying.
- **Import detection:** if an imported symbol isn't in `symbols.json` and its
  name (Schwab `Description`, Webull `Name`) looks like a leveraged
  single-stock ETF (`2X`, `BULL`, `BEAR`, `DAILY … SHARES`, `LONG … DAILY`),
  the import preview asks for the underlying, pre-filling a guess from the
  name (e.g. "DIREXION DAILY MSFT BULL2X SHARES" → MSFT, 2x, long). The answer
  is written to `symbols.json` in the same commit. Symbols that are never
  answered stay unmapped and are listed under "Needs attention".

### 3.5 `derived/trades.json`: trades and ideas

There are two levels:

- **Trade:** one flat-to-flat round trip. **This is the unit for every
  statistic** (win rate, gauges, profit factor). One failed entry doesn't
  mean the whole idea failed, so each round trip is scored on its own.
- **Idea:** a group of trades on the same thesis. **This is the unit for
  display and reviews.** A Playbook review describes an idea.

```ts
interface Trade {
  id: string;                 // id of the first fill (stable; overrides key on it)
  ideaId: string;
  account: "schwab-main" | "webull"; broker: "schwab" | "webull";
  symbol: string;             // what was actually traded, e.g. "PALU"
  underlying: string;         // source ticker, e.g. "PANW" (= symbol for plain stocks)
  instrument: "stock" | "leveraged_etf";
  leverage: number;           // 1 for stocks
  direction: "long" | "inverse";   // relative to the underlying
  style: "day" | "swing";     // intent: account default (styleByAccount), unless overridden
  sameDay: boolean;           // opened and closed on the same ET date (hold-time fact, separate from style)
  openedAt: string; closedAt: string | null;   // null means still open
  status: "open" | "closed" | "unmatched";
  maxPosition: number;
  openQty: number;            // > 0 only when status = "open"
  unmatchedQty: number;       // shares sold beyond the position; > 0 only when status = "unmatched"
  avgEntry: number; avgExit: number | null;
  grossPnl: number; fees: number; netPnl: number;   // realized
  result: "win" | "loss" | "breakeven" | null;   // >0 / <0 / =0.00; null while open
  holdMinutes: number | null; // null when Schwab has date-only precision
  fillIds: string[];
  avgCost: number;            // current average cost (re-averaged on adds)
  realizedPnl: number;        // locked in so far by trims (= netPnl once closed)
  events: Array<{             // position timeline, for Open Positions and Trade detail
    kind: "open" | "add" | "trim" | "close";
    at: string; qty: number; price: number;
    realized?: number;        // trims and close only
  }>;
  tags: string[];
  note?: string;              // quick note from overrides.json, when set
  excluded: boolean;
}

interface Idea {
  id: string;                 // id of its first trade
  underlying: string;         // ideas are keyed by underlying
  accounts: string[];         // an idea can span Schwab and Webull
  symbolsTraded: string[];    // e.g. ["PANW", "PALU"]
  usedEtf: boolean;           // any trade in the idea was a leveraged ETF
  style: "day" | "swing";
  date: string;               // ET date the idea opened (matches review file names)
  tradeIds: string[];
  netPnl: number;             // sum of realized trade P&L
  status: "open" | "closed";
}

// derived/trades.json
{ "generated": true, "generator": "trade-journal@x.y.z", "trades": Trade[], "ideas": Idea[] }
```

Unrealized P&L is **never** stored. It needs a live price, so it is computed
in the browser (§5.4).

Review links are **not** stored here. `trade-history` doesn't know about
`Playbook`; the journal joins the two at build time (§6).

---

## 4. Import and normalization

All parsing, dedupe and grouping code lives in `trade-journal` as pure TS
modules. The web app and the Node CLI both use it, so the browser and Claude
cannot drift apart.

### 4.1 Webull (`Webull_Orders_Records*.csv`)

Columns: `Name, Symbol, Side, Status, Filled, Total Qty, Price, Avg Price,
Time-in-Force, Placed Time, Filled Time`.

- Keep rows whose `Status` is `Filled` or `Partial Filled` and whose
  `Filled` > 0. Drop `Cancelled` rows.
- `qty` = `Filled`, `price` = `Avg Price`, and `executedAt` = `Filled Time`.
  Parse the EDT/EST abbreviation into an offset. Precision is `"second"`.
- Each export is a cumulative history, so successive exports overlap heavily.
  Dedupe handles this (§4.3).

### 4.2 Schwab (`Trading_XXX###_Transactions_*.csv`)

Columns: `Date, Action, Symbol, Description, Quantity, Price, Fees & Comm,
Amount`.

- Keep `Action` ∈ {`Buy`, `Sell`}. Skip `MoneyLink Transfer`, dividends,
  interest and journals. Skipped rows are counted in the preview.
- `Date` can be written as `"05/19/2026 as of 05/18/2026"`. Use the
  **as-of date** (the trade date).
- Strip `$` and `,` from numbers. `fees` = `Fees & Comm` (blank means 0).
- **There are no times.** `executedAt` is the date at 00:00 ET, precision is
  `"day"`, and `seq` preserves CSV order, reversed so the oldest row comes
  first. For same-day matching, buys are ordered before sells when the
  position is flat. This is safe because the account is long only.
  Concretely: within one day, CSV order is kept, except that when the next
  sell would take the position below zero, the next buy from later that day
  is moved ahead of it. The preview reports how many days needed this.

### 4.3 Dedupe and fill ids

- `id` = broker prefix + the first 12 hex characters of the SHA-256 of
  `account|symbol|side|qty|price|executedAt|n` (Q15), where `n` is the occurrence
  index of an otherwise identical row in the same file. Two real identical
  fills in the same second are both kept.
- A fill whose `id` already exists is skipped. The result reports
  **added / duplicate / skipped (non-trade) / errors**.
- An existing `id` whose content differs (a hash collision, or a broker
  changing a past row) is an **error**, never silently merged. A file with
  any error is not imported at all.
- Re-importing any file is idempotent.

### 4.4 Grouping (fills → trades → ideas)

**Trades.** Grouping is per account and symbol, in time order:

1. Track the running position. A trade opens when the position goes 0 → >0
   and closes when it returns to 0. Scale-ins and scale-outs in between stay
   inside that trade. P&L uses average cost.
2. There is no re-entry merge at this level. Every flat-to-flat round trip is
   its own trade.
3. A sell that would take the position below 0 marks the trade
   `unmatched`. It appears under "Needs attention" and is excluded from stats
   until it is fixed with `openingPositions`. Its P&L covers only the shares
   that were actually held (zero for a lone sell), and `result` is `null`.
4. **Style follows intent, not hold time.** A swing trade has a tight stop and
   can stop out intraday, but it was entered to be held. It counts as a
   **swing** trade and goes against the swing win rate, even if it closed the
   same day (e.g. a 2x ETF bought and stopped out the same session).
   - **Default by account** (`config.json` → `styleByAccount`):
     `schwab-main` → `swing`, `webull` → `day`. This matches how you already
     trade and how the `playbook-review` skill already sorts trades.
   - **Per-trade override** in `overrides.json` (`"style"`), for the
     occasional Schwab day trade or Webull swing. You can set it from Trade
     detail or with a bulk action on Trades.
   - **Sanity flag:** a `day` trade still open after its open date, or closed
     on a later date than it opened (a Webull position held overnight),
     appears under "Needs attention" as "Held overnight: still a day
     trade?". It is not changed automatically.
   - **Hold time** is still recorded and reported separately (Duration filter,
     "Performance by duration"). For example, you can see how many swings
     stopped out the same day versus worked over days.
5. **Result:** net P&L after fees. Webull fees are $0 because the order export
   has no fee column; Schwab uses `Fees & Comm`. **There are no scratches.**
   `win` if netPnl > $0, `loss` if netPnl < $0, and **`breakeven` if netPnl is
   exactly $0.00** (rounded to the cent). Breakevens are shown, in gray, but
   are left out of the win rate: `win rate = wins ÷ (wins + losses)`.

**Ideas.** Ideas group trades by **underlying** (§3.4), across both accounts
and across the stock and its single-stock ETFs:

- **Day trades:** all day-style trades on the same underlying on the same ET
  date form **one idea**, however far apart they are. This matches the
  one-review-per-ticker-per-day file names. For example, MU at 09:31, 09:52
  and 14:10 is 1 idea and 3 trades. PANW at 09:35 plus PALU at 10:15 is 1 PANW
  idea with `usedEtf: true`.
- **Swing trades:** a swing trade starts a new idea, unless it opens on the
  same ET date that the previous trade on that underlying closed (a re-entry
  with a different entry tactic, which could include switching between the
  stock and its ETF). In that case it joins the previous trade's idea.
- Ideas can be split or merged by hand later through `overrides.json`
  (`"ideaId"` on a trade). This is not in v1's UI.

### 4.5 Import paths

Both paths write `fills/<year>.json` **and** regenerate `derived/trades.json`
in the same commit.

**A. In the web app (Import page)**
1. Drop one or more CSVs. The broker is detected from the header row.
2. The app parses them in the browser, then loads the current `fills/*.json`,
   `overrides.json` and `config.json` from `trade-history` through the
   GitHub API.
3. It shows a preview: N new fills, M duplicates, skipped rows, and the
   resulting new or changed trades with their P&L.
4. On **Commit**, it makes one commit to `trade-history/main` through the
   Git Data API (blobs, tree, commit), for example
   `"Import Webull 2026-10-03: +42 fills"`. The same commit always archives
   the original CSV to `imports/raw/<YYYY-MM-DD>-<original name>.csv`, so all
   data can be rebuilt from the originals if a parser bug is ever found.
5. `notify-journal.yml` dispatches the redeploy. The app shows "deploying…"
   until the new `data.enc` hash appears.

Editing overrides on the Trade detail page uses the same commit flow.

**B. Through Claude or the CLI** (run from `trade-journal`)
- `npm run import -- [files…]`. With no arguments, it uses the newest
  `Webull_Orders_Records*.csv` and `Trading_*_Transactions_*.csv` in
  `~/Downloads`; `--all` uses every matching export there (oldest first),
  for backfills. It writes into `$TRADE_HISTORY_DIR` (default
  `../trade-history`, or `--history-dir`).
- The CLI writes files only; it never runs git. Commits and pushes are made
  separately, after the preview is approved.
- `--dry-run` prints the same preview as the web app.
- `npm run trades -- --date YYYY-MM-DD [--style day|swing]` lists derived
  trades in a readable form.
- The CLI also archives each original CSV to `imports/raw/`, as path A does.
- **Claude never pushes an import without your OK.** It runs `--dry-run`
  first, shows you the preview (new, duplicate and skipped counts; new or
  changed trades with P&L; ETF symbols to map), and waits. Only after you
  approve does it write, commit and push `trade-history`, because the push
  publishes to the site.

### 4.6 Changes to the Playbook repo (small, optional, milestone 6)

- The `playbook-review` skill reads `../trade-history/derived/trades.json`
  (path configurable) instead of parsing `~/Downloads`. This gives Schwab
  swing trades the importer they don't have today, and `import_webull.py` is
  retired.
- Add `notify-journal.yml` so a pushed review triggers a redeploy.
- Optionally add an `**Idea ID:**` header line to `Template.md`, so a review
  pins its exact idea instead of relying on date and ticker matching.
- The skill presents **ideas** (e.g. "MU: 3 trades, +$85") as the things to
  review, which replaces the 30-minute-gap clustering in `import_webull.py`.

---

## 5. Temperature gauges (dashboard centerpiece)

There are two gauges side by side: **Day Trading** and **Swing Trading**.
Each style is computed independently. Every input is a **trade** (a
flat-to-flat round trip), never an idea.

### 5.1 Day gauge inputs

- **Window:** closed, non-excluded day trades whose `closedAt`
  falls in the current week (Mon–Sun, ET).
- **Backfill:** if the window has fewer than 5 trades, it is padded with the
  most recent earlier day trades. The gauge shows a label such as
  "3 this week + 2 prior".

### 5.2 Swing gauge inputs

The window combines realized and unrealized results:

1. **Closed this week:** non-excluded swing trades whose
   `closedAt` falls in the current week. They are scored on realized net P&L.
2. **All currently open swing positions,** whenever they were opened. Each one
   is **marked to market** with the latest quote from §5.4 for the symbol
   actually held (HYNX, not 000660.KS):
   `unrealized = (lastPrice − avgEntry) × openQty`, plus any realized P&L from
   partial sells. It counts as a win if > $0, a loss if < $0, and is left out
   if it is exactly $0.00.
3. **Backfill:** if (1) + (2) gives fewer than 3, the window is padded with the
   most recent earlier closed swing trades.
4. If a position has no quote (a newly imported position not yet priced, a
   failed fetch, or an unknown symbol), it is **left out** and the gauge shows
   "2 open positions not priced". Positions are never guessed. A quote older
   than one trading session is still used, but is labeled **stale**.

Example: closed AAPL +$120 (W), NVDA −$40 (L); open MU +$85 (W), AMD −$30 (L),
TSLA +$10 (W). The window is 3W / 2L = 60%.

### 5.3 Baseline and sizing state

- **Baseline:** win rate of that style's **closed** trades in the 90 days
  *before* the current week. Open positions never enter the baseline. If the
  baseline has fewer than 20 trades, a "low-confidence baseline" note is
  shown.
- Let `Δ = windowWinRate − baselineWinRate` (percentage points):

| State | Condition | Example, baseline 60% | Message |
|---|---|---|---|
| 🟢 **Full size** | Δ ≥ 0 | ≥ 60% | "At or above your average. Full size." |
| 🟡 **½ size** | −10 ≤ Δ < 0 | 50–59.9% | "Below average. Trade ½ size until the win rate is back to average." |
| 🔴 **¼ size** | Δ < −10 | < 50% | "Well below average. Trade ¼ size until the win rate is back to average." |

- Full size requires being at or above the average, so recovery means getting
  "back to average+" by definition, and no extra hysteresis is needed. The
  state is re-derived from the data on every load, with no stored flag. Bands
  are set in `config.json`.
- The swing gauge updates as each new set of prices is deployed. Its label
  shows "prices as of HH:MM ET".

### 5.4 Prices: scheduled GitHub Action (no keys)

Prices are fetched **server-side by a GitHub Action**, not by the browser.
There are no API keys and nothing to set up per device, and the site stays
fully static.

- **Workflow:** `prices.yml` in `trade-journal`, which also serves the site.
  Public-repo Actions minutes are free and unlimited.
  - **Schedule:** cron `*/15 13-21 * * 1-5` (UTC), which covers 09:30–16:00
    ET in both EDT and EST. One extra run at about 16:20 ET captures the
    close.
  - A run first checks whether the market is open (weekday, NYSE hours, and
    Yahoo's `marketState`, which catches holidays), and exits in seconds when
    it's closed, apart from the post-close run.
  - It can also be run by hand with `workflow_dispatch`.
- **Steps:**
  1. Check out `trade-history` read-only with `DATA_READ_TOKEN`.
  2. Read the open positions from `derived/trades.json`.
  3. Fetch quotes for only those symbols with the `yahoo-finance2` npm package
     (no key; keeps the codebase all TypeScript).
  4. Write `quotes.json`:
     `{ "asOf": "...", "quotes": { "PALU": { "price": 61.12, "time": "...", "marketState": "REGULAR" } } }`.
  5. Continue into the same build → bundle → **encrypt** → deploy steps as
     `deploy.yml`. Both workflows call one reusable workflow and share
     `concurrency: pages`.
- **Quotes are never committed** to any repo, and symbols are never printed in
  the logs. They exist only inside the encrypted `data.enc`. The public repo
  doesn't reveal what you hold.
- **Freshness:** about 15 minutes in theory. GitHub often starts scheduled runs
  5–15 minutes late, and occasionally skips one under heavy load, so expect
  prices 15–30 minutes old. The dashboard always shows the `asOf` time, and
  "stale" after one trading session. That's fine for judging swing positions,
  which is the only thing that uses prices.
- **Import ordering:** an import that opens a new position triggers a normal
  deploy, which runs the price step too. New positions are priced right away
  instead of waiting for the next scheduled run.
- **"Refresh prices" button (optional):** the dashboard can start `prices.yml`
  on demand through `workflow_dispatch`. This needs the browser PAT to also
  have **Actions: read & write** on `trade-journal`. The new prices appear
  after the redeploy, in about 1–2 minutes.
- **Source risk:** Yahoo's endpoint is unofficial and has broken before. The
  fetch is behind a small `QuoteProvider` interface, so another source (e.g.
  Finnhub or Alpaca with a key stored as an Actions secret) can be swapped in
  with a code change. If a fetch fails, the previous `quotes.json` (cached
  with `actions/cache`) is reused and marked stale, rather than the gauge
  losing its open positions.
- **Privacy:** Yahoo sees requests from GitHub's servers, not from you.

### 5.5 Display

- A semicircle dial with the needle at the window win rate. The colored bands
  are positioned relative to the baseline, and a marker sits at the baseline.
- A large label shows the size recommendation.
- Window stats: W/L count (swing shows closed vs. open separately), realized
  and unrealized P&L, avg win / avg loss, profit factor, and expectancy per
  trade.
- A sparkline of the last 8 weeks' win rates against the baseline, from
  closed trades only.
- **Open swing positions table** under the swing gauge: symbol, open date,
  qty, avg entry, last price, unrealized $ / %, and days held.

---

## 6. App features (v1)

Modeled on Tradervue's Dashboard, Reports, Trades and Trade detail pages
(reference screenshots, 2026-10-03), with two deliberate differences:
**notes are your Playbook reviews** (`Reviews/*.md`) and **charts are your
Playbook images** (`Images/<date>/`). There are no embedded TradingView or
candlestick charts in v1 (see §11).

### 6.0 Shell and global controls

- **Layout:** a top bar (see Visual direction below). There is no sidebar.
- **Visual direction: "Terminal"** (chosen 2026-10-03; mockups in the
  "Trade Journal look & feel" canvas):
  - Near-black background (`#0a0a0a`) and panels (`#121212`) with 1 px
    `#2a2a2a` borders. Square corners, no shadows.
  - **JetBrains Mono everywhere.** Uppercase, letter-spaced section labels.
    Dense tables.
  - **Amber accent** (`#f5a524`) for the active nav item, selected toggles,
    links and the line under the top bar.
  - **Green `#22c55e` gains / red `#ef4444` losses.** Yellow `#facc15` is used
    only for the "½ size" state.
  - **Top navigation bar** instead of a sidebar: DASH · OPEN · CAL · TRADES ·
    REPORTS · JOURNAL · SETTINGS, with IMPORT and LOCK on the right. It wraps
    at phone width.
  - All colors are CSS variables, so a light theme or different palette can be
    added later without touching components.
- **Global filter bar** on Trades and Reports, kept in the URL so views can be
  bookmarked:
  - **Symbol:** matches the traded symbol *or* the underlying, so `PANW` finds
    PALU trades too.
  - **Tags:** multi-select.
  - **Style:** All / Day / Swing (this replaces Tradervue's "Side", since
    everything is long).
  - **Instrument:** All / Stock / Leveraged ETF.
  - **Broker:** All / Schwab / Webull.
  - **Duration:** All / Intraday / Multi-day.
  - **Result:** Win / Loss / Breakeven.
  - **Has review.**
  - **Date range:** From – To, with presets.
- **Gross / Net toggle:** applies everywhere P&L is shown. The default is Net.
- **Count by Trade / Idea toggle** on the Trades table and the Reports stats
  grid. Gauges always count trades (§5).

### 6.1 Dashboard

From top to bottom:

The first three blocks answer, at a glance: *what size should I trade, what am
I holding, and how are my latest trades going?* They sit at the top, above
everything else, and are never hidden.

1. **Temperature gauges:** Day and Swing side by side (§5). This is the
   centerpiece, and it is not in Tradervue.
2. **Open positions (quick view):** every open position, all on the main
   page.
   - **Header totals:** count, **Unrealized**, **Realized (from trims)**,
     **Total open P&L**, "as of HH:MM ET" for the prices, and a
     **DETAILS ›** link to the Open Positions page (§6.1a).
   - **One row per position:**
     - Symbol (with `→UNDERLYING 2x` for ETFs) and style.
     - **Opened** date (plus days held) and **Trims** (date, −qty, @price for
       each partial sell).
     - Shares now / max held, avg cost, last price.
     - **Unrealized $** and %, **Realized $**, and **Total $**.
   - An empty state reads "No open positions" (one line, no table).
3. **Recent 10, Day | Swing:** two columns side by side, stacked at phone
   width.
   - **Day:** the last 10 closed day trades. **Swing:** the last 10 closed
     swing trades.
   - **Each column's header:**
     - A **10-square streak strip**, oldest → newest, colored win / loss /
       breakeven (gray).
     - The W/L(/BE) count, win %, and net $.
     - An **ALL ›** link to Trades, filtered to that style.
   - **Each row:** a result dot, date, symbol (with underlying for ETFs), hold
     time ("same day" / "3 days" for Schwab), an R marker if reviewed, and
     net P&L. Clicking a row opens Trade detail.
   - This always counts **trades** (round trips), not ideas, and ignores the
     30/60/90 range.
4. **Week strip:** seven day cards (Sun–Sat). Each shows the date, net P&L
   (colored) and the number of trades. A 📄 icon appears if any review exists
   for that day. Clicking a card opens the Trades page filtered to that day.
   Arrows step to previous weeks.
5. **Range selector:** **30 / 60 / 90 days** (top right). It drives every
   widget below it.
6. **Widget grid:**
   - **Cumulative P&L** line chart.
   - **Win % by day** bar chart.
   - **Winning vs Losing trades:** a donut with counts and %. Breakevens are a
     thin gray slice.
   - **Hold time, winners vs losers:** two bars (e.g. "about 3 hours" vs
     "about 1 hour"), with day and swing hold times computed separately.
     Schwab trades without times show as multi-day or same-day only.
   - **Average winning vs losing trade:** two bars.
   - **Largest gain vs largest loss:** a half-gauge, with links to both
     trades.
   - **Performance by day of week:** P&L and % of total, one bar per day.
   - **Performance by duration:** buckets of < 5 min, 5–30 min, 30 min–2 h,
     2 h to close, 1–5 days, 1–4 weeks, > 4 weeks.
   - **Needs attention:** unmatched fills, unmapped ETF symbols, unpriced
     open positions, and OPEN swing reviews whose position has closed.
7. **Edit Layout** (show, hide and reorder widgets, saved per browser) is a
   v1.1 nice-to-have, not v1. Blocks 1–3 stay pinned at the top regardless.

### 6.1a Open Positions page (in-depth)

Nav item **OPEN**, the second item in the top bar. It holds everything the
dashboard quick view has, plus:

- **Totals strip:** unrealized, realized from trims, total open P&L, market
  value vs cost, and the count of green vs red positions.
- **Filter:** All / Swing / Day.
- **Per position,** extra columns: **Market value** and **Unrealized %**,
  plus a **timeline** of every event:
  - `OPEN date BUY qty @ price`.
  - `ADD date BUY qty @ price`.
  - `TRIM date SELL qty @ price  +realized`.
  - `NOW shares @ last`.
- A totals row.
- **Math:**
  - **Average-cost basis:** adds re-average the cost, and trims realize
    `(sell − avg cost) × qty`.
  - `Unrealized = shares × (last − avg cost)`.
  - `Total = realized + unrealized`.
  - These numbers can differ from Schwab's tax-lot (FIFO) realized figures by
    design. The journal measures trade performance, not taxes.
- Clicking a symbol opens Trade detail for that position, which shows the
  same timeline plus its review and charts.
- A position without a quote shows "—" for last, unrealized and total, and is
  flagged under Needs attention (§5.2).

### 6.2 Calendar

- A month grid. Each day cell shows net P&L (green or red background tint),
  the number of trades, and 📄 if a review exists. A weekly total column sits
  on the right.
- Clicking a day opens the Trades page filtered to that date. Arrows step
  between months, and a **year view** shows a 12-month heatmap.

### 6.3 Trades

- **Table** columns: Date, Symbol (with an `ETF→PANW` badge on leveraged
  ETFs), Style, Volume (shares), Executions (fill count), Hold, Gross/Net P&L,
  Review (📄 links to the review), Notes (short note, truncated), and Tags.
  - **Removed from Tradervue's table:** "Shared".
- **Rows** are one per trade by default, matching Tradervue (e.g. two MSFU
  rows on 01 Oct). The **Idea view** collapses them into one row per idea,
  which expands to show its trades.
- **Sortable** on every column. Paginated at 50 per page, or virtualized if
  that's simpler.
- **Bulk select** with checkboxes, then **Add tag / Remove tag / Set style /
  Exclude**. Every bulk action is one commit to `trade-history/overrides.json`.
- **Views:** only *Table* in v1. Tradervue's "Charts (large/small)" views are
  dropped until charts exist.

### 6.4 Trade detail

The header is the symbol and date-time ("MSFU · Jan 15, 2026"; day-precision
Schwab trades show the date only). Below it are the tag chips, with an
**Add tags +** control. The top right has **Back**, **Previous trade** and
**Next trade**, which follow the current filter and sort.

- **Stats panel:**
  - Shares traded, executions, avg entry, avg exit, gross / fees / net P&L,
    % return on cost, hold time, style, broker and account.
  - The underlying and leverage, for ETF trades.
  - Unrealized P&L at the latest quote, for open swing positions.
  - **Not shown in v1:** MFE/MAE ("best exit", position and price
    MFE/MAE). Those need intraday price history (§11).
- **Executions table:** time, side, qty, price and fees for every fill.
- **Idea panel:** the other trades in the same idea, with their P&L and a
  combined idea total. For example, "Idea: PANW · 3 trades · +$85 (2 PANW,
  1 PALU)".
- **Notes panel (right side), from your Playbook review:**
  - If a review is linked to this trade's idea (§6.11), it is rendered here:
    headings, the Finviz `<details>` block, and images inline, with template
    HTML comments hidden. An **Open full review** link goes to the Journal.
  - If there is no review, the panel shows a short **quick note**, editable
    and saved to `overrides.json` (one or two lines, like Tradervue's notes
    field). It also has a **Start review** button that copies
    `/playbook-review <TICKER> <DATE>` to the clipboard to paste into Claude.
    This replaces Tradervue's "Insert template".
- **Charts section, from your Playbook images:** a gallery of
  `Images/<date>/<UNDERLYING>-daily*` and `-intraday*` (also matching the
  traded ETF symbol). Thumbnails open a full-size lightbox. If there are no
  images, it shows "No charts saved for this trade. Use `/chart-image` in
  Playbook."

### 6.5 Reports

- **Tabs:** v1 includes **Overview**, **Detailed**, **Win vs Loss Days**,
  **Drawdown**, **Compare** and **Tag Breakdown**. Tradervue's "Advanced" tab
  is dropped.
- **Controls:**
  - P&L type: Gross / Net.
  - View mode: **$ value** / **% return**.
  - Count by: Trade / Idea.
- **Overview:** the cumulative P&L, daily P&L bars, win % and volume charts
  over the filtered range.
- **Detailed: the stats grid.** Every stat is unlocked. Tradervue gates some
  behind paid plans; here they are all computed:

  | | | |
  |---|---|---|
  | Total gain/loss | Largest gain ↗ | Largest loss ↗ |
  | Avg daily gain/loss | Avg daily volume | Avg per-share gain/loss |
  | Avg trade gain/loss | Avg winning trade | Avg losing trade |
  | Total trades | # winning (%) | # losing (%) |
  | Avg hold (all) | Avg hold (winners) | Avg hold (losers) |
  | # breakeven ($0.00) | Max consecutive wins ↗ | Max consecutive losses ↗ |
  | Trade P&L std dev | SQN | Probability of random chance |
  | Kelly % | K-ratio | Profit factor |
  | Total commissions | Total fees | Expectancy |

  ↗ links to the trade or streak. MFE/MAE rows are left out until price
  history exists.
- **Breakdown sub-tabs** under the grid. Each is a set of horizontal bar
  charts of P&L, with win rate, trade count and expectancy on hover:
  - **Days/Times:** day of week, hour of day (Webull only; Schwab is
    excluded and labeled), month.
  - **Price/Volume:** entry price buckets and position size buckets.
  - **Instrument:**
    - Performance by symbol, **Top 20 / Bottom 20**.
    - The same by **underlying**.
    - **Stock vs leveraged ETF**.
    - **"Same underlying, stock vs ETF":** for each underlying traded both
      ways, a side-by-side comparison.
  - **Win/Loss/Expectation:** distribution of trade P&L, win rate and
    expectancy by style and broker.
  - **Not in v1:** Tradervue's "Market Behavior" and "Liquidity" sub-tabs,
    which need market data.
- **Win vs Loss Days:** the stats grid split into green days vs red days, to
  show how behavior differs on losing days (trade count, size, hold time).
- **Drawdown:** an underwater equity curve, max drawdown $ and %, the longest
  drawdown in days, and recovery time.
- **Compare:** two filter sets side by side, each with its own stats grid and
  cumulative P&L. Examples are "Day vs Swing", "Stock vs ETF", or "this month
  vs last month".
- **Tag Breakdown:** the stats grid for each tag, plus each review
  `Category`, plus each style.

### 6.6 Tags

- **Automatic tags** are computed and can't be removed:
  - `Day` / `Swing` (from the style).
  - `ETF` (leveraged ETF trades).
  - `Reviewed` (a review is linked).
  - The review's `Category` value (e.g. "Breaking news"), applied to every
    trade in the idea.
- **Manual tags** are free text, stored in `overrides.json`, and added from
  Trade detail or bulk select. Your existing Tradervue tags
  carry over this way.

### 6.7 Journal (Playbook reviews)

- A list of reviews, newest first, with the date, ticker, Trade Type,
  Status (OPEN / CLOSED), the linked idea's P&L and the trade count. It is
  filterable by the global filter bar.
- The review page renders the full markdown with images. A header strip
  shows the linked idea's trades and P&L, with links to each trade.
- Read-only. Reviews are written in Playbook with the `playbook-review`
  skill.

### 6.8 Import

See §4.5A. Drag-and-drop CSVs, then a preview (new, duplicate and skipped
counts; any new ETF symbols to map; resulting trades), then **Commit**.

### 6.9 Settings

- Lock the app and change "remember on this device".
- GitHub PAT.
- A read-only view of `config.json` and `symbols.json`, with links to edit
  them on GitHub.

### 6.10 Not in v1 (compared with Tradervue)

TradingView or candlestick charts on Trade detail, MFE/MAE and "best exit",
Market Behavior and Liquidity reports, Edit Layout, manual "New Trade" entry,
Community, Share, and the Charts views of the Trades page.

### 6.11 Review ↔ idea join (done in the journal, at build time and in dev)

Reviews attach to **ideas**, not individual trades.

1. If the review has an `**Idea ID:**` line, use it.
2. Otherwise, match `Reviews/<DATE>-<TICKER>.md` to the idea whose
   **underlying** is `<TICKER>` and whose `date` (open date) is `<DATE>`. A
   review named for the ETF (e.g. `…-PALU.md`) is first resolved to its
   underlying through `symbols.json`. Swing reviews are created at entry, so
   their date is the open date. Day ideas are one per ticker per day, so this
   is normally an exact 1:1 match.

---

## 7. `trade-journal` repo: tech and layout

- **App:** Vite + React + TypeScript; Recharts; `react-markdown` with
  `rehype-raw` and `rehype-sanitize`; Papa Parse.
- **Shared logic:** pure TS in `src/core/`, imported by both the app and the
  CLI. Hashing uses `@noble/hashes` (synchronous, identical in browser and
  Node).
- **JSON Schemas:** the canonical copies live in `trade-journal/schema/`, are
  validated against the synthetic output in tests, and are copied into
  `trade-history/schema/` by the importer on every write (Q17). The CLI
  validates every file it reads or writes with Ajv.
- **CLI:** run with `tsx`.
- **Tests:** Vitest with **synthetic fixtures only**, because the repo is
  public. These are hand-written CSVs that copy the exact Schwab and Webull
  formats with fake tickers and prices. Golden tests cover dedupe of
  overlapping exports, `as of` dates, `Partial Filled` rows, flat-to-flat
  trades vs. idea grouping, ETF → underlying mapping, same-day Schwab day
  trades, unmatched sells, gauge bands, and swing mark-to-market with missing
  or stale quotes.
  There is also an optional local-only `npm run verify` that runs the
  pipeline against the real `trade-history` and prints summary totals. It
  never runs in CI.

```
trade-journal/
  docs/SPEC.md
  src/
    core/normalize/    schwab.ts, webull.ts, dedupe.ts
    core/trades/       grouping.ts, stats.ts
    core/gauge/        gauge.ts
    core/reviews/      parse-header.ts, join.ts
    app/               React pages and components
  cli/                 import.ts, trades.ts, verify.ts, lib/ (Node I/O + report printing)
  schema/              canonical JSON Schemas (copied into trade-history)
  build/               bundle-data.ts, encrypt.ts, fetch-quotes.ts
  test/fixtures/       synthetic CSVs + expected JSON
  .github/workflows/
    build-deploy.yml   reusable: checkout data → [quotes] → build → encrypt → deploy
    deploy.yml         on push / repository_dispatch / manual → build-deploy
    prices.yml         on schedule / manual → build-deploy with quotes
```

### Deploy workflow (`deploy.yml`)

Triggers: `push` to `main`, `repository_dispatch: [data-updated]`,
`workflow_dispatch`.

1. Check out `trade-journal`, then `trade-history` and `Playbook` into
   `./_data/` using `DATA_READ_TOKEN`.
2. `npm ci`, `npm test`, `vite build`.
3. `build/fetch-quotes.ts` prices the open positions (§5.4). This runs on
   every deploy, not only scheduled ones, so prices are never older than the
   latest deploy.
4. `build/bundle-data.ts` gathers fills, overrides, config, symbols, derived
   trades, quotes, review markdown and the image list, then
   `build/encrypt.ts` writes
   `data.enc` and `img/<hash>.enc`.
5. **Leak guard:** fail the deploy if `dist/` contains any symbol from the
   fills or any review file name in plaintext.
6. `actions/upload-pages-artifact` → `actions/deploy-pages`.
7. Use `concurrency: pages` so back-to-back imports and price runs collapse
   into one deploy.
8. Nothing from `_data/` or the quotes is ever echoed to the logs.

---

## 8. Security notes

- The browser PAT can write only to `trade-history`. It is stored encrypted
  and sent only to `api.github.com`.
- No market-data keys exist in v1. Prices are fetched by the Action and travel
  only inside the encrypted bundle.
- Markdown is sanitized before rendering.
- Because the repo is public, PR-triggered workflows must **never** get
  secrets. The deploy runs only on `push` to `main`, dispatch and manual
  triggers, never on `pull_request`.
- If the passphrase is forgotten, change the secret and redeploy. Nothing is
  lost, because the plaintext lives in the private repos.

---

## 9. Milestones

1. **Repos and data core:** create `trade-journal` and `trade-history`;
   build the parsers, dedupe, grouping and CLI import with synthetic tests;
   backfill all existing exports from `~/Downloads` into `trade-history`;
   check the totals with `npm run verify`.
2. **Gauges and dashboard,** running locally against the sibling checkouts,
   including `fetch-quotes.ts` (run with `npm run quotes` locally) and the
   open-positions table.
3. **Trades, detail, calendar, reviews,** still local.
4. **Encrypted deploy:** secrets, the `build-deploy` / `deploy` / `prices`
   workflows, and dispatch workflows in both data repos.
5. **In-browser import and override editing** through the GitHub API.
6. **Playbook integration:** update the review skill to read
   `derived/trades.json`; optionally add `Idea ID` to the template.
7. **Reports** (§6.5: Overview, Detailed grid, breakdowns, Win vs Loss Days, Drawdown, Compare, Tag Breakdown).

---

## 10. Decisions log (2026-10-03)

| # | Question | Decision |
|---|---|---|
| Q1 | Trade boundary | **Trade = flat-to-flat round trip** (the unit for stats). **Idea** = day: same ticker + same day; swing: a same-day re-entry joins the previous idea (the unit for display and reviews). |
| Q2 | Win definition | Net P&L after fees. Webull fees = $0. |
| Q3 | Scratches | **No scratches.** Win if net P&L > $0, loss if < $0, **breakeven if exactly $0.00** (shown in gray, left out of the win rate). (Revised from ±$1: at 2–10 share sizes most trades are under $1.) |
| Q4 | Size bands | Full at ≥ baseline; ½ from 0 to 10 points below; ¼ more than 10 below. |
| Q5 | Swing gauge | Swings closed this week + **all open swing positions marked to market** (prices from a scheduled GitHub Action, see Q9), backfilled to a minimum of 3 with earlier closed swings. The baseline uses closed trades only. |
| Q6 | Accounts | One Schwab account and Webull only. The real Schwab account suffix lives only in private `trade-history/config.json` (this public spec uses `schwab-main`). |
| Q7 | Naming | Repo `Lykam/trade-journal`, site `lykam.github.io/trade-journal`, no custom domain. |
| Q8 | Single-stock ETFs | Trades in ETFs like PALU count toward the **underlying** (PANW) for ideas, reviews and ticker stats, while keeping `symbol`, `instrument`, `leverage` and `direction` for analysis. P&L and positions are computed on the ETF itself. Mapping lives in `trade-history/symbols.json`, and the import preview prompts for any new ETF it detects. |
| Q9 | Price source | A **scheduled GitHub Action** fetches quotes for open positions every 15 min during market hours (Yahoo through `yahoo-finance2`, no keys), plus on every deploy. Quotes travel only in the encrypted bundle. Expect them to be 15–30 min old. Browser-side live quotes are deferred to Future. |
| Q11 | Day vs swing | **Style = intent, not hold time.** Default by account (Schwab → swing, Webull → day), overridable per trade. A swing stopped out intraday still counts as a swing. A day trade held overnight is flagged for review, not changed automatically. |
| Q12 | Main-page content | Dashboard top, always visible: (1) gauges, (2) **open positions quick view** (opened date, trim dates, realized / unrealized / total P&L per position, plus totals), (3) **Recent 10 Day / Recent 10 Swing** side by side. An in-depth **Open Positions page** (event timeline, market value) sits behind it. |
| Q13 | Gauge details | Confirmed: open swing positions count in **every** week's swing gauge until closed. Padding minimums stay at **5 day / 3 swing**. Baseline = closed trades in the 90 days before this week. |
| Q14 | Import handling | Every original CSV is **archived** to `trade-history/imports/raw/`. When Claude imports, it shows the dry-run preview and **waits for your OK** before committing and pushing. |
| Q15 | Fill id length | 12 hex chars of SHA-256 (48 bits), not 8. At ~20k fills, 8 chars gives about a 5% chance of a collision; 12 makes it negligible. Collisions are still detected and reported as errors. (2026-10-03, milestone 1) |
| Q16 | Account mapping | `config.json` maps the Schwab export's file-name id to an account label (`schwabAccounts`), and names the Webull account (`webullAccount`). The real id exists only in private `trade-history`; tests use a fake `000`. (2026-10-03, milestone 1) |
| Q17 | Schema location | Canonical schemas live with the code in `trade-journal/schema/` and are copied into `trade-history/schema/` on each import, so the code and the contract can't drift. (2026-10-03, milestone 1) |
| Q10 | Look and feel | Direction **B "Terminal"** (monospace, near-black, amber accent, top nav) with **standard green/red** gain/loss colors (§6.0). |

### Still open

- Nothing blocks milestone 1.

## 11. Future

- **TradingView charts on Trade detail,** using the free
  `lightweight-charts` library with execution markers. This needs intraday
  bars from a market-data source, which would also unlock MFE/MAE,
  "best exit", and the Market Behavior and Liquidity reports.
- Dashboard **Edit Layout**, manual **New Trade** entry, and a one-time
  **import of Tradervue's tags and notes** from a Tradervue export.
- Live browser-side quotes (Finnhub free key, stored encrypted) layered on top
  of the scheduled Action prices, if 15–30 min delay ever proves too slow.
- R-multiples, if a planned stop is recorded per trade.
- Short selling and options. `assetType` is reserved, and grouping would need
  signed positions.
- Auto-suggest "worth reviewing" trades.
