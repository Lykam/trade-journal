# Trade Journal — Spec (v0.17)

A personal, Tradervue-style trade journal and weekly "temperature gauge"
dashboard. Trades from Schwab and Webull are normalized into JSON in a
dedicated **trade-history** repo. Playbook reviews come from the existing
**Playbook** repo. The app itself lives in its own public repo, which also
hosts the site on GitHub Pages, with all data encrypted.

---

## 1. Goals

1. **One normalized trade history** across Schwab and Webull, stored as JSON in
   git with no database. It lives in its own repo so other apps can read it.
   Single-stock ETF trades (NVQU) count toward their source ticker (NVQX)
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
| `Lykam/Playbook` | Private | `Reviews/*.md`, `Images/`, `Template.md`, the review skills (which read `trade-history/derived/trades.json`, §4.6). | The `playbook-review` skill |

```
 trade-history (private)          Playbook (private)
   fills/ overrides.json            Reviews/*.md  Images/
   derived/trades.json                    │
        │  on push: repository_dispatch   │ on push: repository_dispatch
        └──────────────┬──────────────────┘
                       ▼                      ◀── every 15 min in market hours
 trade-journal (PUBLIC) — GitHub Action           (prices.yml)
   checkout self + trade-history + Playbook (read-only deploy keys)
   test → build app → fetch quotes for open positions (Yahoo)
        → bundle data → ENCRYPT → actions/deploy-pages
                       │
                       ▼
 GitHub Pages: index.html, assets/*.js, data.enc, img/<hash>.enc,
              demo/ (public demo: app shell only, synthetic data)
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
| `TRADE_HISTORY_DEPLOY_KEY`, `PLAYBOOK_DEPLOY_KEY` | Actions secrets in `trade-journal` | Private halves of **read-only deploy keys** on `trade-history` and `Playbook` (one repo each, no expiry). Replaces the planned `DATA_READ_TOKEN` PAT (Q37). |
| `SITE_PASSPHRASE` | Actions secret in `trade-journal` | Encrypts the bundle |
| `DISPATCH_TOKEN` | Actions secret in `trade-history` and `Playbook` | Fine-grained PAT: **Contents: read & write** on `trade-journal` only. GitHub requires write access to send `repository_dispatch`. |
| Browser PAT | Entered in app Settings and stored encrypted in `localStorage` | Fine-grained PAT: **Contents: read & write** on `trade-history` only |
| Browser Actions PAT (optional) | Same, alongside the browser PAT | Fine-grained PAT: **Actions: read & write** on `trade-journal` only, for "Refresh prices". Separate because a token's permissions apply to every repo it selects (Q38). |

The browser never gets write access to `Playbook`, and reviews are read-only
in the app. Neither browser token can write `trade-journal`'s code.

**Browser token at rest (Q38):** sealed with AES-GCM under a key derived (HKDF,
`src/core/github/token-store.ts`) from the site key, in `localStorage` only;
the plaintext lives in memory while unlocked. LOCK forgets the site key, so the
sealed token can't be read until the passphrase is entered again; a changed
passphrase makes it unreadable and Settings asks for it again. Saving checks
the token: fine-grained (`github_pat_`), can read `main` and create a blob
(an unreferenced blob, no commit) in the data repo, and, for the Actions token,
that a `workflow_dispatch` on a ref that doesn't exist is refused with 422 (no
such ref) rather than 403. The client sends it only to `https://api.github.com`.

### Encryption

- AES-256-GCM. The key is derived from a passphrase with PBKDF2-SHA256 at
  600k iterations and a random salt. Both steps use WebCrypto in the browser
  and Node `crypto` in the Action.
- The salt is random but **fixed**, in `build/kdf.json` (salts are public), so
  the key a browser remembers keeps working across the many deploys a day.
  Editing `kdf.json` (or changing `SITE_PASSPHRASE`) makes every device ask
  for the passphrase again (Q34).
- File format (`src/core/crypto.ts`): `"TJE1"` | kind | iterations | salt | IV
  | ciphertext + tag. The header is the GCM additional data, and an image also
  binds its own file name, so files can't be swapped or altered. Plaintext is
  length-prefixed and zero-padded to a size bucket (64 KiB for `data.enc`,
  32 KiB per image); `data.enc` holds gzipped JSON.
- Image files are named by an HMAC of path + content under a key derived
  (HKDF) from the data key, and random decoys pad `img/` to a multiple of 16
  files, so names and the image count stay hidden.
- In the browser, the derived key (not the passphrase) is kept in
  `sessionStorage`. An optional "remember on this device" setting moves it to
  `localStorage`. LOCK clears both and reloads, which drops the decrypted data
  and image blob URLs from memory. A saved key that no longer opens the data
  is cleared and the lock screen says why.
- `SITE_PASSPHRASE` must be at least 16 characters; `data.enc` is public, so
  it can be attacked offline. Use a long random passphrase (e.g. 6+ random
  words).
- The published site contains no plaintext tickers, dates, file names or
  counts. Image file names are hashes.
- **Public demo (Q51):** `lykam.github.io/trade-journal/demo/` serves a
  separate build of the app on synthetic data generated in the visitor's
  browser (§7). It holds no data and no code that reads `data.enc`, `img/`,
  the stored key or the token.

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
  },
  "balances": {                                  // optional; edited in Settings → Account value (Q68)
    "schwab-main": {
      "start": { "date": "2026-06-22", "amount": 500 },  // cash that day, before its trades
      "checkpoints": [                             // actual values from the broker, at a close
        { "date": "2026-10-06", "value": 503.10, "marks": { "NVQU": 29.5 } }
      ]
    }
  }
}
```

### 3.4 `symbols.json`: single-stock ETF → source ticker

Single-stock leveraged ETFs are traded as a play on their source stock (NVQU
for NVQX, MZRU for MZRT, HXQY for a Korean-listed stock). This file maps each ETF to its
underlying, so the trade counts toward the source ticker while still recording
that it was an ETF trade.

```jsonc
{
  "NVQU": { "underlying": "NVQX",  "type": "leveraged_etf", "leverage": 2, "direction": "long", "issuer": "Demo Funds" },
  "MZRU": { "underlying": "MZRT",  "type": "leveraged_etf", "leverage": 2, "direction": "long", "issuer": "Demo Funds" },
  "HXQY": { "underlying": "999990.KS", "type": "leveraged_etf", "leverage": 2, "direction": "long", "issuer": "Demo Funds" }
  // "direction": "inverse" for bear ETFs (e.g. a 2X short fund). Holding one long
  // is a bearish bet on the underlying, and analysis can flag it as such.
}
```

- A symbol that isn't listed is a plain stock or ETF, and its underlying is
  itself.
- **Grouping by the ETF's own symbol.** Positions, flat-to-flat trades and P&L
  are always computed on the ETF itself (NVQU shares are not NVQX shares).
- **Grouping by underlying.** Ideas, reviews, live-quote labels and
  "by ticker" reports group by the underlying.
- **Import detection:** if an imported symbol isn't in `symbols.json` and its
  name (Schwab `Description`, Webull `Name`) looks like a leveraged
  single-stock ETF (`2X`, `BULL`, `BEAR`, `DAILY … SHARES`, `LONG … DAILY`),
  the import preview asks for the underlying, pre-filling a guess from the
  name (e.g. "DEMO DAILY MZRT BULL2X SHARES" → MZRT, 2x, long). The answer
  is written to `symbols.json` in the same commit. Symbols that are never
  answered stay unmapped and are listed under "Needs attention".
- **Mapping from the app (Q66):** an ETF whose broker name doesn't look like
  one is never offered at import. Trade detail (**SET UNDERLYING +**, or
  **UNDERLYING … · EDIT** once mapped) and Settings → **Symbol mappings**
  (EDIT, ADD MAPPING +) set, change or remove a mapping. COMMIT reads
  trade-history fresh, previews the trades whose underlying changes and the
  ideas that regroup, and writes `symbols.json` plus a regenerated
  `derived/trades.json` in one commit (the Q40 flow). Existing keys keep their
  order and new ones are appended, as the importer writes them; a mapping
  trade-history already has commits nothing.

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
  symbol: string;             // what was actually traded, e.g. "NVQU"
  underlying: string;         // source ticker, e.g. "NVQX" (= symbol for plain stocks)
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
    fees?: number;            // open and add only: the buy's fees, when non-zero (Q44)
  }>;
  tags: string[];
  note?: string;              // quick note from overrides.json, when set
  excluded: boolean;
}

interface Idea {
  id: string;                 // id of its first trade
  underlying: string;         // ideas are keyed by underlying
  accounts: string[];         // an idea can span Schwab and Webull
  symbolsTraded: string[];    // e.g. ["NVQX", "NVQU"]
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
- **Webull rewrites the symbol on past rows after a ticker change** (seen in
  real exports: the same fills appear under the old ticker in one export and
  the new ticker in the next). Webull fill ids therefore leave the symbol out
  (§4.3), the first-seen symbol is kept, and the preview lists each
  "OLD → NEW" ticker change (Q18).

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

- `id` = broker prefix + the first 12 hex characters of the SHA-256 of the
  fill's identity plus `|n` (Q15):
  - Schwab: `account|symbol|side|qty|price|executedAt`. Rows are date-only,
    so the symbol is needed to tell same-day fills apart.
  - Webull: `account|side|qty|price|executedAt|placedAt` (`Placed Time`),
    without the symbol, because Webull renames past rows (§4.1, Q18)., where `n` is the occurrence
  index of an otherwise identical row in the same file. Two real identical
  fills in the same second are both kept.
- A fill whose `id` already exists is skipped. The result reports
  **added / duplicate / skipped (non-trade) / errors**.
- An existing `id` whose content differs (a hash collision, or a broker
  changing a past row) is an **error**, never silently merged. A file with
  any error is not imported at all.
- **Webull partial fills (Q45):** an order exported while partly filled and
  again once finished has a different id each time (Filled, Avg Price and
  Filled Time change). When a new Webull fill's order (account, side, placed
  time) already has a stored fill that the export no longer lists, the import
  stops with an error ("same order seen with a different filled qty"). The
  check re-hashes the stored fill with the incoming placed time, so fills
  still don't store it.
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
  one-review-per-ticker-per-day file names. For example, ZNRG at 09:31, 09:52
  and 14:10 is 1 idea and 3 trades. NVQX at 09:35 plus NVQU at 10:15 is 1 NVQX
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
4. ETF symbols the preview detects get a row with the name-based guess
   pre-filled; checked rows are written to `symbols.json` in the same commit
   and the trades are regrouped with them (the CLI still lists them for a hand
   edit).
5. On **Commit**, it makes one commit to `trade-history/main` through the
   Git Data API (blobs, tree, commit, then a non-forced ref update), for example
   `"Import Webull 2026-10-03: +42 fills"`. The same commit always archives
   the original CSV to `imports/raw/<YYYY-MM-DD>-<original name>.csv`, so all
   data can be rebuilt from the originals if a parser bug is ever found.
   Only files whose content changed are written (compared by git blob id),
   and a CSV whose bytes are already under `imports/raw/` isn't archived
   again. If `main` moved since the read, the app re-reads and recomputes; if
   the result differs from what the preview showed, it stops and shows the new
   preview instead of committing (Q40). It never force-pushes.
6. `notify-journal.yml` dispatches the redeploy. The app shows "Deploying…",
   polling `data.enc` (no-store) until a new one decrypts to a bundle built
   from that commit or a later one (the bundle records the trade-history HEAD
   it was built from), then offers RELOAD. After 5 minutes it links to the
   Actions runs instead.

Editing overrides (bulk actions, Add tags, quick note) uses the same commit
flow: the staged actions are replayed on `overrides.json` as it is on `main`
now, the preview against that is shown, and CONFIRM writes `overrides.json` and
a regenerated `derived/trades.json` in one commit. Staging is paused while that
preview is open, so CONFIRM writes exactly what it shows; a commit removes only
the actions it wrote from the staged list, and its "COMMITTED · VIEW COMMIT ↗"
line stays until the next edit (`src/core/journal/staging.ts`). The browser and the CLI share
`src/core/import/plan.ts` and `src/core/history/files.ts`, and a test checks
that the same CSVs give byte-identical files through both paths.

The token's repository is a setting (default `Lykam/trade-history`), so the
commit path can be tried on a throwaway repo; a commit there never appears in
`data.enc`, so "Deploying…" then waits for any newer deploy.

**B. Through Claude or the CLI** (run from `trade-journal`)
- `npm run import -- [files…]`. With no arguments, it uses the newest
  `Webull_Orders_Records*.csv` and `Trading_*_Transactions_*.csv` in
  `~/Downloads`; `--all` uses every matching export there (oldest first),
  for backfills. "Oldest first" is one rule shared with the Import page
  (`exportOrder`): the file's modified time, then the name (Webull's `(n)`
  number, Schwab's export stamp), then the plain name. The time comes first
  because Webull's numbering restarts after Downloads is cleaned (#4). It writes into `$TRADE_HISTORY_DIR` (default
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

### 4.6 Changes to the Playbook repo (milestone 6, Q41)

- The `playbook-review` skill reads `../trade-history/derived/trades.json`
  (`$TRADE_HISTORY_DIR` or `--history-dir` to override) through
  `scripts/trade_ideas.py`, instead of parsing `~/Downloads`. Schwab swing
  trades now have an importer, and `import_webull.py` is retired. The skill
  pulls `trade-history` first (`git pull --ff-only`), since imports from the
  site commit on GitHub. It never imports: with no ideas for the date, it
  tells you to import through the journal first.
- The skill presents **ideas** (e.g. "ZNRG: 3 trades, +$85") as the things to
  review, replacing the 30-minute-gap clustering. An idea is listed for a date
  when it opened that day or one of its trades opened or closed that day (a
  swing exit or re-entry), with its Idea ID, its trades and its review file if
  one exists.
- Reviews are named `Reviews/<IDEA DATE>-<UNDERLYING>.md`: the idea's open date
  and its underlying, even for ETF trades. An OPEN swing review on an idea that
  has since closed is resumed for the exit phase.
- `Template.md` has an `**Idea ID:** {{IDEA ID}}` header line, which the skill
  fills in, so a review pins its exact idea (§6.11). A manual review keeps the
  placeholder and is matched on date and ticker.
- `sync_review.py` also embeds charts saved under any symbol traded in a pinned
  idea (e.g. the ETF), as the journal's gallery does (Q33).
- `notify-journal.yml` makes a pushed review trigger a redeploy.
- The skill scripts are plain Python with `unittest` tests in Playbook
  (`.claude/skills/playbook-review/tests`). The skill's review matcher mirrors
  `src/core/reviews/join.ts`, and checks itself against
  `test/fixtures/expected/review-join.json`, a golden file the journal's tests
  generate from the synthetic fixtures.

### 4.7 One-time Tradervue import (Q53)

`npm run import:tradervue -- [file] [--dry-run]` reads a Tradervue **trades**
export (one row per trade: `Open Datetime`, `Close Datetime`, `Symbol`, `Side`,
`Volume`, `Exec Count`, `Entry Price`, `Exit Price`, `Gross P&L`, `Notes`,
`Tags`, plus % and MFE/MAE columns it ignores). With no file it uses the one
CSV in `~/Downloads` with that header. Code: `src/core/tradervue/`
(`parse.ts`, `match.ts`, `plan.ts`), `cli/import-tradervue.ts`.

- **What it changes:** `overrides.json` only, plus the regenerated
  `derived/trades.json`, the schema copies (Q17) and the archived export under
  `imports/raw/`, through the same writers as §4.5. It never adds or edits
  fills: a trades export has no executions, and the broker fills stay the
  source of truth for prices, quantities and P&L.
- **Reading the export:** times are ET wall-clock. Date-only trades (Schwab)
  are logged at `12:00:00` on both ends. `Volume` counts both sides, so a
  closed trade bought `Volume ÷ 2` shares. Short rows (`Side` = `S`) are
  skipped. Notes are HTML and are converted to plain text.
- **Matching:** timed trades match a journal trade on the exact ET open and
  close second plus shares bought, whatever the symbol. Webull renames past
  rows (Q18), and Tradervue may hold the new ticker, or both. Date-only trades
  match on symbol, open and close date and shares; several same-day round
  trips are told apart by gross P&L, then paired in order. A Tradervue row
  that fits an already matched trade is a **duplicate copy** (Tradervue keeps
  one per overlapping file it imported).
- **Tradervue wins for tags and style:**
  - A matched trade's manual tags become the union of its Tradervue copies'
    tags, minus automatic tags (§6.6).
  - Its style is `swing` if a copy has the style tag (`Swing`, `--style-tag`)
    and `day` otherwise, stored only where it differs from the account default.
  - Its quick note becomes the Tradervue note (distinct notes of all copies
    joined with " · "), cut at a word boundary to 500 characters
    (`--note-max`). An existing journal note stays when Tradervue has none.
  - Unmatched journal trades are left alone.
- **Preview** (`--dry-run`, local terminal only):
  - fills added (always 0)
  - matches, duplicates and ticker changes
  - unmatched Tradervue trades, with a reason: before broker fills,
    split or quantity differs, or no journal trade
  - journal trades in the export's dates with no Tradervue trade
  - trades changed, ideas regrouped and style changes
  - tags added, and **journal tags that would be removed**
  - notes set, replaced and cut
  - discrepancies: P&L equal after rounding, same-day lots paired
    differently, P&L differs, execution count differs (fees aren't in the
    export)
  - the gauges' 90-day baselines before and after
  - the style × broker summary before and after
- **Trades from before the broker exports:** these exist only in Tradervue.
  Representing them would need synthetic fills (a new `source` and id prefix)
  or `openingPositions`; neither was needed for the first import, so neither
  is built. Such trades are listed as unmatched ("before broker fills").

---

## 5. Temperature gauges (dashboard centerpiece)

There are two gauges side by side: **Day Trading** and **Swing Trading**.
Each style is computed independently. Every input is a **trade** (a
flat-to-flat round trip), never an idea.

### 5.1 Day gauge inputs

- **Window:** closed, non-excluded day trades whose `closedAt`
  falls in the current week (Mon–Sun, ET).
- **Backfill:** if the window has fewer than 5 decisive (win or loss) trades,
  it is padded with the most recent earlier day trades. Breakevens are shown
  but don't count toward the 5 (Q20). The gauge shows a label such as
  "3 this week + 2 prior".

### 5.2 Swing gauge inputs

The window combines realized and unrealized results:

1. **Closed this week:** non-excluded swing trades whose
   `closedAt` falls in the current week. They are scored on realized net P&L.
2. **All currently open swing positions,** whenever they were opened. Each one
   is **marked to market** with the latest quote from §5.4 for the symbol
   actually held (HXQY, not 999990.KS):
   `unrealized = (lastPrice − avgCost) × openQty` on the current average cost
   (§6.1a), plus any realized P&L from partial sells (Q25). It counts as a win if > $0, a loss if < $0, and is left out
   if it is exactly $0.00.
3. **Backfill:** if (1) + (2) gives fewer than 3, the window is padded with the
   most recent earlier closed swing trades.
4. If a position has no quote (a newly imported position not yet priced, a
   failed fetch, or an unknown symbol), it is **left out** and the gauge shows
   "2 open positions not priced". Positions are never guessed. A quote older
   than one trading session is still used, but is labeled **stale**: a full
   regular session (weekday 09:30–16:00 ET) has passed since the quote, or
   the quote was carried over from a failed fetch (Q21).
5. **"As of now":** the gauge takes `now` as a parameter. Trades closed after
   `now` are ignored, and a position open at `now` is rebuilt from its events,
   so any past week can be recomputed and the tests are deterministic (Q23).

Example: closed CRQL +$120 (W), AQRS −$40 (L); open BLNQ +$85 (W), TRVQ −$30 (L),
MZRT +$10 (W). The window is 3W / 2L = 60%.

### 5.3 Baseline and sizing state

- **Baseline:** win rate of that style's **closed** trades in the 90 days
  *before* the current week. Open positions never enter the baseline. If the
  baseline has fewer than 20 trades, a "low-confidence baseline" note is
  shown.
- Let `Δ = windowWinRate − baselineWinRate` (percentage points):

| State | Condition | Example, baseline 60% | Message |
|---|---|---|---|
| 🟢 **Full size** | Δ ≥ 0 | ≥ 60% | "At or above your average." |
| 🟡 **½ size** | −10 ≤ Δ < 0 | 50–59.9% | "Below your average: trade half size." |
| 🔴 **¼ size** | Δ < −10 | < 50% | "Well below your average: trade quarter size." |


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
  1. Check out `trade-history` read-only with its deploy key.
  2. Read the open positions from `derived/trades.json`.
  3. Fetch quotes for only those symbols with the `yahoo-finance2` npm package
     (no key; keeps the codebase all TypeScript).
  4. Write `quotes.json`:
     `{ "asOf": "...", "attemptedAt": "...", "quotes": { "NVQU": { "price": 61.12, "time": "...", "marketState": "REGULAR" } } }`.
     `asOf` is the last successful fetch; a quote carried over from a failed
     fetch has `"stale": true`. Symbols no longer held are dropped.
  5. Continue into the same build → bundle → **encrypt** → deploy steps as
     `deploy.yml`. Both workflows call one reusable workflow and share
     `concurrency: pages`.
- **Quotes are never committed** to any repo, and symbols are never printed in
  the logs (`npm run quotes` prints counts only locally and no counts at all
  in the workflows (Q35), and error messages are
  reduced to their type because they can echo the request). They exist only inside the encrypted `data.enc`. The public repo
  doesn't reveal what you hold.
- **Market check:** `build/market-open.ts` (`npm run market -- --mode
  regular|post-close`) checks the ET clock, then Yahoo's `marketState` for a
  broad index ETF (never a held symbol). Regular runs need `REGULAR`; the
  post-close cron (`20 20,21 * * 1-5`, whichever slot is 16:20 ET) needs a
  session today. If the lookup fails, the clock decides.
- **Cached quotes are encrypted** (`npm run quotes:cache -- save|restore`)
  under the site key before `actions/cache` stores them, because other
  workflow runs in a public repo can restore caches (Q34).
- **Freshness:** about 15 minutes in theory. GitHub often starts scheduled runs
  5–15 minutes late, and occasionally skips one under heavy load, so expect
  prices 15–30 minutes old. The dashboard always shows the `asOf` time, and
  "stale" after one trading session. That's fine for judging swing positions,
  which is the only thing that uses prices.
- **Import ordering:** an import that opens a new position triggers a normal
  deploy, which runs the price step too. New positions are priced right away
  instead of waiting for the next scheduled run.
- **"Refresh prices" button (optional):** the dashboard can start `prices.yml`
  on demand through `workflow_dispatch`. This needs the optional **Actions
  token** (Actions: read & write on `trade-journal` only, Q38); the button is
  hidden without it. The new prices appear after the redeploy, in about 1–2
  minutes, behind the same "Deploying…" banner as a commit.
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
- A large label shows the size recommendation (½ / ¼ glyphs only here;
  sentences spell out "half size" / "quarter size", since ½ reads as % at
  body size in JetBrains Mono).
- Under it: the gap (`−4.3 PTS VS AVG`), what the window holds
  (`11 CLOSED THIS WEEK`, `1 CLOSED, 6 OPEN`, `+ 4 EARLIER` when backfilled),
  and, below full size, the wins that would get back to it, all else equal:
  `FULL SIZE AT 8W 5L (+2 WINS)` (`winsToFull`; each added win pushes the
  oldest backfilled trade out, Q55).
- Window stats: W/L count as `6W 5L` (swing: `CLOSED 1W 0L · OPEN 4W 2L`),
  realized and unrealized P&L, avg win / avg loss, profit factor, and
  expectancy per trade, all spelled out. Notes say when earlier trades fill
  in the window (`4 EARLIER TRADES FILL IN UNTIL THIS WEEK HAS 5`) and that
  open positions count at the last price.
- At phone width the gauge is compact: a small dial beside the call, with the
  stats behind a **STATS** toggle.
- A sparkline of the last 8 weeks' win rates against the baseline, from
  closed trades only. The 8th bar is the current (partial) week.
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
    REPORTS · JOURNAL · SETTINGS, with IMPORT and LOCK on the right. Beside
    them, the data stamps: `PRICES FRI 10-02 16:00 ET · WEBULL 10-02 ·
    SCHWAB 10-02`, the last import per broker turning amber with `!` when it
    is older than the latest closed session (Q55). At phone width it is one
    line that scrolls sideways, IMPORT included, with the active tab kept in
    view (Q57).
  - All colors are CSS variables, so a light theme or different palette can be
    added later without touching components.
- **Global filter bar** on Trades and Reports, kept in the URL so views can be
  bookmarked. It starts collapsed to one line unless a filter is active (and
  on desktop), and when collapsed shows the active filters as chips (Q62):
  - **Symbol:** matches the traded symbol *or* the underlying, so `NVQX` finds
    NVQU trades too.
  - **Tags:** multi-select.
  - **Style:** All / Day / Swing (this replaces Tradervue's "Side", since
    everything is long).
  - **Instrument:** All / Stock / ETF (leveraged single-stock ETFs).
  - **Broker:** All / Schwab / Webull.
  - **Duration:** All / Intraday / Multi-day.
  - **Result:** Win / Loss / Breakeven.
  - **Reviewed:** All / Yes / No.
  - **Date range:** From – To, with presets spelled out (THIS WEEK, LAST
    MONTH…; the short forms THIS WK, LAST MO only below 640 px).
- **Gross / Net toggle:** on Trades, Trade detail, Calendar and Journal, kept
  in the URL (`pnl=gross`). The default is Net. Results (win / loss /
  breakeven) and win rates always use net P&L, in both modes (Q2). The
  dashboard stays Net, because the gauges are defined on net (Q27).
- **Count by Trade / Idea toggle** on the Trades table, the Calendar and the
  Reports stats grid, kept in the URL (`count=idea`). Gauges always count
  trades (§5). An idea row is built from those of its trades that pass the
  filter, and scores as a win or loss on their combined net P&L (Q28).
- **URL form:** `#/trades?symbol=ABC,XYZ&tags=…&tagmode=all&style=day&
  instrument=leveraged_etf&broker=webull&duration=intraday&result=win,loss&
  review=yes&range=lastweek|from=…&to=…|date=…&flag=overnight&pnl=gross&
  count=idea&sort=-pnl&page=2`. Defaults are left out. Trade detail and review
  pages carry the same query, so Back / Previous / Next follow it.
- **Trade date** for the date filter and the Trades date column is the
  ET close date, or the open date while a trade is open (Q26).
- **Booked date:** the calendar and the week strip count P&L on the day it
  was booked instead: each trim on its own day and the rest on the close, so
  a trim on a still-open swing shows the day it was taken (Q67). Their links
  add `booked=1` to the date, which lists the trades with a trim or close in
  the range (open ones included), shown as a `BOOKED` chip in the filter bar.
  The list then values each trade at what it booked in the range (an open
  trade's trims read `+4.46 TRIM`) and totals that, so it matches the day.

### 6.1 Dashboard

From top to bottom:

The first blocks answer, at a glance: *what size should I trade, what needs
checking, what am I holding, and how are my latest trades going?* They sit at
the top, above everything else, in the same order at phone width.

1. **Temperature gauges:** Day and Swing side by side (§5). This is the
   centerpiece, and it is not in Tradervue.
1a. **Needs attention** (Q55): one line under the gauges, `! NEEDS ATTENTION
   3 ITEMS ›`, that opens into the list; hidden when nothing needs
   attention. It lists unmatched fills, unpriced open positions, stale prices
   (with their stamp), day trades held overnight, today's unreviewed **swing** trades
   (`2 unreviewed trades today REVIEW ›`, the Trades view
   `style=swing&range=today&review=no`; day-trade reviews are optional, Q70), and the review checks: OPEN swing reviews whose
   idea has closed (`NVQX idea from 08-25 closed 09-23: write the exit`),
   reviews that match no idea, and ideas with more than one review. Unmapped
   ETFs need the broker's name column, which fills don't store, so they
   surface in the import preview.
2. **Open positions (quick view):** every open position, all on the main
   page.
   - **Header totals:** count, **Unrealized**, **Realized** (trims, less buy fees; Q54),
     **Total open P&L**, and an **ALL OPEN ›** link to the Open Positions
     page (§6.1a). The price stamp is in the top bar.
   - **Account line** (Q68), once an account has a balance: its **value**
     and **cash** (with cash's share), `N AT COST` when a position has no
     price, and EDIT › to Settings.
   - **One row per position:**
     - Symbol (with the `2x→UNDERLYING` badge for ETFs, `−2x→` for inverse)
       and style.
     - **Opened** date (plus days held) and **Trims** (date, −qty, @price for
       each partial sell).
     - Shares now / max held, avg cost, last price.
     - **% ACCT:** the position's share of its account's value (Q68).
     - **Unrealized $** and %, **Realized $**, and **Total $**.
   - An empty state reads "No open positions" (one line, no table).
3. **Recent 10, Day | Swing:** two columns side by side, stacked at phone
   width.
   - **Day:** the last 10 closed day trades. **Swing:** the last 10 closed
     swing trades.
   - **Each column's header:**
     - A **10-square streak strip**, newest first (left), like the list,
       colored win / loss / breakeven (gray).
     - The W/L(/BE) count, win %, and net $.
     - An **ALL TRADES ›** link to Trades, filtered to that style.
   - **Each row:** a result dot, date, symbol (with underlying for ETFs), hold
     time ("same day" / "3d" for Schwab), 📄 if reviewed, and net P&L.
     Clicking a row opens Trade detail.
   - This always counts **trades** (round trips), not ideas, and ignores the
     30/60/90 range.
4. **Week strip:** day cards for the gauge week (`weekStartsOn`, Mon–Sun by
   default, Q19), all styles (labeled). Saturday and Sunday get a card only
   when something was booked on them. Each shows the date, the net P&L booked
   that day, trims included (colored, Q67), and the number of trades that
   booked it. A 📄 icon appears if any review exists for that day.
   Clicking a card opens the Trades page with the trades booked that day. Arrows step to
   previous weeks. At phone width the cards show the weekday only.
5. **Range selector:** **30 / 60 / 90 days** (top right), plus **ALL / DAY /
   SWING** (Q55), both remembered per browser. They drive every widget below.
6. **Widget grid:**
   - **Key stats row:** net P&L, win %, profit factor, avg win / loss (with
     the ratio), day hold (win / loss), best / worst trade.
   - **Cumulative P&L** line chart.
   - **Daily win %** bar chart.
   - **Winning vs Losing trades:** a donut with counts and %. Breakevens are a
     thin gray slice.
   - **Hold time, winners vs losers:** two bars (e.g. "about 3 hours" vs
     "about 1 hour"), with day and swing hold times computed separately.
     Schwab trades without times show as multi-day or same-day only.
   - **Average winning vs losing trade:** two bars.
   - **Largest gain vs largest loss:** two bars from one zero line, with
     links to both trades.
   - **P&L by weekday:** P&L and trade count, one bar per day.
   - **P&L by hold time:** buckets of < 5 min, 5–30 min, 30 min–2 h,
     2h – close, 1–5 days, 1–4 weeks, > 4 weeks.
7. **Edit Layout** (show, hide and reorder widgets, saved per browser) is a
   v1.1 nice-to-have, not v1. Blocks 1–3 stay pinned at the top regardless.


### 6.1a Open Positions page (in-depth)

Nav item **OPEN**, the second item in the top bar. It holds everything the
dashboard quick view has, plus:

- **Totals strip:** unrealized, realized (with its trim count and buy fees,
  e.g. `0 TRIMS · 0.65 FEES`, Q54), total open P&L, market value vs cost, and
  the count of green vs red positions.
- **Filter:** All / Swing / Day. **Sortable** on every column; unpriced
  values sort last.
- **Last price:** a stale quote shows its own stamp on the row
  (`9.80 * 10-01 14:00`).
- **Account line** and a sortable **% OF ACCT** column (with a total) once
  an account has a balance (Q68).
- **Per position,** extra columns: **Market value** and **Unrealized %**,
  plus a **timeline** of every event, shown only when the position has adds
  or trims (and not at phone width):
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

- A month grid. Each day cell shows the P&L booked that day (green or red
  background tint): each trim on the day it was taken and the rest of a
  trade on its close, so a trade's days add up to its P&L (Q67). It also
  shows the number of trades that booked P&L that day, and 📄 if a review
  exists. A weekly total column sits on the right; a week that reaches into another month is dimmed and says
  so (`WK · INCL. SEP`), since its total includes those days. At phone width
  amounts are whole dollars (`+16`, `−43`).
- **Weekdays only** (Q69): the month grid and the year heatmap show Mon–Fri.
  If a weekend day in view has trades, that month (or year) shows all seven
  days again, in the `weekStartsOn` order, so nothing is ever hidden.
- Clicking a day opens the Trades page with the trades booked that day
  (`booked=1`, Q67). Today's cell
  has an amber outline. Arrows step between months, and a **year view**
  shows a 12-month heatmap with weekday letters above each month and a
  one-line color legend.

### 6.3 Trades

- **Table** columns: Date, Symbol (with a `2x→NVQX` badge on leveraged
  ETFs, `−2x→NVQX` on inverse ones), Style, Volume (shares), Fills, Hold,
  Gross/Net P&L,
  Review (📄 links to the review), Notes (short note, truncated), and Tags.
  - **Removed from Tradervue's table:** "Shared".
- **Rows** are one per trade by default, matching Tradervue (e.g. two MZRU
  rows on 01 Oct). The **Idea view** collapses them into one row per idea,
  which expands to show its trades.
- **Sortable** on every column. Paginated at 50 per page, or virtualized if
  that's simpler.
- **Open trades** have no result yet: P&L shows their mark at the last price
  in muted text (`open +19.50`, or `open —` without a quote), never colored
  as a win or loss, and they sort after the closed trades on P&L (Q54). The
  Journal list, the review page and the Idea panel do the same.
- **Date** is always the close date (the open date while open); a multi-day
  row's range shows under Hold (`27d · from 09-02`). The **Notes** column
  shows only when a row on the page has a note (Q62).
- **Bulk select** with checkboxes (the bar docks at the bottom of the
  screen, below the table, so ticking a box never moves the rows), then
  **Add tag / Remove tag / Mark Day /
  Mark Swing / Exclude from stats / Include**. Every bulk action is one commit
  to `trade-history/overrides.json`.
- **Views:** only *Table* in v1. Tradervue's "Charts (large/small)" views are
  dropped until charts exist.

### 6.4 Trade detail

The header is the symbol and date-time ("MZRU · 2026-01-15 15:41 ET";
day-precision Schwab trades show the date only). Below it are the manual tag
chips and any review Category, with an **Add tags +** control (style, ETF and
reviewed already show in the header and stats). The top right has **Back** and
**‹ Newer / Older ›**, which follow the current filter and sort; under a sort
other than date they read **‹ Prev / Next ›**.

- **Stats panel:**
  - Size (max shares held), volume, fills, avg entry, avg exit, gross / fees / net P&L,
    % return on cost, hold time, style, broker and account.
  - The underlying and leverage, for ETF trades.
  - Unrealized P&L at the latest quote, for open swing positions. For an
    open trade, Total open P&L, Unrealized and Realized come first, and
    Gross / Net P&L and % return on cost show "—" until it closes (Q54).
    Hold is "open 17d" in whole ET calendar days, the same count as the
    dashboard.
  - **Not shown in v1:** MFE/MAE ("best exit", position and price
    MFE/MAE). Those need intraday price history (§11).
- **Fills table:** time, side, qty, price and fees for every fill.
- **Idea panel:** the other trades in the same idea, with their P&L and a
  combined idea total. For example, "Idea: NVQX · 3 trades · +$85 (2 NVQX,
  1 NVQU)".
- **Notes panel (right side), from your Playbook review:**
  - If a review is linked to this trade's idea (§6.11), it is rendered here:
    headings, the Finviz `<details>` block, and images inline, with template
    HTML comments hidden. A **Full review ›** link goes to the Journal.
  - If there is no review, the panel shows a short **quick note**, editable
    and saved to `overrides.json` (one or two lines, like Tradervue's notes
    field). The edit is staged, previewed, then committed (Q32, §4.5A). It also has a **Start review** button that copies
    `/playbook-review <TICKER> <DATE>` to the clipboard to paste into Claude.
    This replaces Tradervue's "Insert template".
- **Keys:** `j` / `k` step to the next / previous trade in the list (not
  while typing). A 📄 beside the header links to the review.
- **Charts section, from your Playbook images** (in the left column, under the
  timeline and idea, beside the review): a gallery of
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
  | Total trades | Winners | Losers |
  | Avg hold (all) | Avg hold (winners) | Avg hold (losers) |
  | Breakeven | Max consecutive wins ↗ | Max consecutive losses ↗ |
  | Trade P&L std dev | SQN | Chance it's luck |
  | Kelly % | K-ratio | Profit factor |
  | Fees & commissions | Win % | Expectancy |

  ↗ links to the trade (Trade detail, carrying the filter) or the streak (the
  Trades page for the streak's dates under the same filter). MFE/MAE rows are
  left out until price history exists. The exports carry one combined
  "Fees & Comm" figure, so commissions and fees are one stat, and the freed
  cell shows the win rate as defined in §4.4 (Q42). Win % appears once, as
  wins ÷ (wins + losses), the same figure as the dashboard tile, its donut
  and the gauges; the counts rows carry no second percentage (Q56). When
  both styles are in the grid, the three hold cells split by style
  (`day 1h 08m · swing 16.0d`).
- **What counts:** closed, matched, non-excluded trades that pass the global
  filter (`isScored`). In the Idea view each idea is one unit built from its
  trades that pass (Q28). Results always come from net P&L; Gross / Net only
  changes the values. Formulas are in Q42 and `src/core/reports/`.
- **$ / % return:** % mode replaces each unit's P&L by P&L ÷ the cost of the
  shares it bought (every open and add), and totals, averages, std dev, SQN and
  the curves use those returns (totals add them). Totals are labeled **sum of
  trade %** (not an account return; Q56). Per-share P&L, volume and
  fees stay in dollars. URL: `#/reports?tab=detailed&sub=price&mode=pct&…`,
  plus `b=` (Compare's second filter, as its own query string) and `tag=`
  (Tag Breakdown's open grid).
- **Breakdown sub-tabs** under the grid. Each is a set of horizontal bar
  charts of P&L, with win rate, trade count and expectancy on hover:
  - **Days/Times:** day of week, entry time (15-minute buckets from 09:30
    to 11:00, then hourly, with pre-market apart; Webull only, Schwab is
    excluded and labeled; Q61), month.
  - **Price/Volume:** entry price buckets and position size buckets.
  - **Instrument:**
    - Performance by symbol: up to 40 symbols, one list best to worst;
      more, the **best 20** and the **worst 20 of the losing ones** (Q61).
    - The same by **underlying**.
    - **Stock vs leveraged ETF**.
    - **"Same underlying, stock vs ETF":** for each underlying traded both
      ways, a side-by-side comparison.
  - **Win/Loss/Expectation:** distribution of trade P&L, win rate and
    expectancy by style and broker.
  - **Not in v1:** Tradervue's "Market Behavior" and "Liquidity" sub-tabs,
    which need market data.
- **Win vs Loss Days:** the stats grid split into green days vs red days, to
  show how behavior differs on losing days (trade count, size, hold time). A
  day's color is its total net P&L on the ET close date; $0.00 days are
  counted as flat.
- **Drawdown:** an underwater equity curve, max drawdown $ and %, the longest
  drawdown in days, and recovery time. Max drawdown % is the drawdown of the
  summed % returns (points), with the $ drawdown as a share of its peak
  (`OF PEAK PROFIT`) shown beside it when that peak is above $0 and the view
  is in $ (Q42, Q56).
- **Compare:** two filter sets side by side, each with its own stats grid and
  cumulative P&L. Examples are "Day vs Swing", "Stock vs ETF", or "this month
  vs last month". Set A is the global filter; set B has its own filter bar
  (collapsed at first). The presets (Day vs Swing, Stock vs ETF, Schwab vs
  Webull, This month vs Last month) first reset the fields any preset sets
  (style, instrument, broker, dates) and then put their difference on top of
  the rest of the current filter on both sides, so presets never stack (Q59).
  Each side is named by what differs from the other plus its dates
  (`A · DAY · ALL DATES`), the grid has a **B − A** column, and when A and B
  are the same filter a one-line hint replaces the duplicate grids.
- **Tag Breakdown:** the stats grid for each tag, plus each review
  `Category`, plus each style. A summary table per kind (count, win %, P&L,
  expectancy, profit factor, SQN); picking a tag opens its full grid. A trade
  with several tags counts in each. The tables are headed **Tag (manual)** and
  **Category (from review)**, kept apart even when names match (owner
  decision). Profit factor, SQN and Kelly are grayed under 10 units, and a
  group without losses shows "—" for profit factor with the hover "No
  losses" (Q61).

### 6.6 Tags

- **Automatic tags** are computed and can't be removed:
  - `Day` / `Swing` (from the style).
  - `ETF` (leveraged ETF trades).
  - `Reviewed` (a review is linked).
  - The review's `Category` value (e.g. "Breaking news"), applied to every
    trade in the idea.
- **Manual tags** are free text, stored in `overrides.json`, and added from
  Trade detail or bulk select. Your existing Tradervue tags
  carry over this way, through the one-time import (§4.7, Q53).

### 6.7 Journal (Playbook reviews)

- A list of reviews, newest first, with the date, ticker, Trade Type,
  review status (with the idea's folded in: `CLOSED · idea open`), category,
  the linked idea's P&L and the trade count. An OPEN review whose idea has
  closed shows **EXIT MISSING** in the loss color and sorts to the top
  (Q63). It is filterable by the global filter bar, without the Reviewed
  filter (every row is a review).
- The review page renders the full markdown with images. A header strip
  shows the linked idea's trades and P&L (`DAY · 10-01 → 10-01 · CLOSED`, how
  it was linked on hover), with links to each trade.
- Read-only. Reviews are written in Playbook with the `playbook-review`
  skill.

### 6.8 Import

See §4.5A. Drag-and-drop CSVs, then a preview (new fills and trades, with
changed, removed, duplicate and skipped counts shown only when above zero and
errors always; Webull ticker changes; new ETF symbols to map with a guess;
new or changed trades with P&L; and the full `--dry-run` report, collapsed,
carrying the commit it was computed against), then **Commit** (the files it
writes in a collapsed list). Errors block the commit. Needs the browser token.
A new ETF row starts ticked when its guessed underlying is a symbol already
traded, and unticked otherwise; it is only written on Commit (Q64). After a
commit the page offers **BACK TO DASH ›**, and IMPORT shows as active in the
top bar.

### 6.9 Settings

- Lock the app and change "remember on this device".
- GitHub token: repository (default `Lykam/trade-history`), the token, and the
  optional Actions token; checked on save, with Replace and Clear. Links open
  GitHub's new-token page with name, description, expiry and permissions
  pre-filled (`?name=…&target_name=Lykam&expires_in=90&contents=write`);
  repository access can't be pre-filled and is picked by hand.
- **Gauge rules** in plain words, from `config.json` ("Average = your win %
  over the last 90 days, this week excluded. Half size below your average;
  quarter size 10+ points below it…", Q64).
- **Account value** (Q68): per account, the starting balance, the value and
  cash now, and the latest actual value with its correction. SET START /
  EDIT START (date and amount), ENTER ACTUAL VALUE (a close date, the
  broker's total, and the price of each symbol held at that close,
  pre-filled from the latest quotes for today), and a list of actual values
  with REMOVE. Each commits `config.json` through the usual preview (Q40).
- A read-only view of `config.json` with a link to edit it on GitHub, and a
  **Symbol mappings** table for `symbols.json`, editable in the app (§3.4, Q66).

### 6.10 Not in v1 (compared with Tradervue)

TradingView or candlestick charts on Trade detail, MFE/MAE and "best exit",
Market Behavior and Liquidity reports, Edit Layout, manual "New Trade" entry,
Community, Share, and the Charts views of the Trades page.

### 6.11 Review ↔ idea join (done in the journal, at build time and in dev)

Reviews attach to **ideas**, not individual trades.

1. If the review has an `**Idea ID:**` line, use it.
2. Otherwise, match `Reviews/<DATE>-<TICKER>.md` to the idea whose
   **underlying** is `<TICKER>` and whose `date` (open date) is `<DATE>`. A
   review named for the ETF (e.g. `…-NVQU.md`) is first resolved to its
   underlying through `symbols.json`. Swing reviews are created at entry, so
   their date is the open date. Day ideas are one per ticker per day, so this
   is normally an exact 1:1 match.

The `playbook-review` skill uses the same rules (in Python) to show whether an
idea already has a review; `test/fixtures/expected/review-join.json` keeps the
two in step (§4.6).

---

## 7. `trade-journal` repo: tech and layout

- **App:** Vite + React + TypeScript; hand-rolled SVG charts (Q22);
  `react-markdown` with `rehype-raw` and `rehype-sanitize`; Papa Parse.
  Hash routes (`#/`, `#/open`, …) so GitHub Pages needs no rewrites.
- **Local data (`npm run dev`):** a dev-only Vite plugin
  (`build/dev-data-plugin.ts`, `apply: "serve"`) serves `$TRADE_HISTORY_DIR`
  (`config.json`, `symbols.json`, `overrides.json`, `fills/` without source
  file names, `derived/trades.json`), `$PLAYBOOK_DIR` (`Reviews/*.md` and the
  image list) and the local `quotes.json` at `<base>__data/bundle.json`, serves
  Playbook images at `<base>__data/playbook/<path>` (only files in the image
  list), and reloads the page when any of them change. The app fetches it only behind `import.meta.env.DEV`, so `vite build`
  contains neither the data nor the loader (`test/build-leak.test.ts`).
  `?now=<ISO>` pins the app's clock for checking past weeks.
  `npm run dev:fixtures` runs the same server on the synthetic fixtures
  (`test/fixtures/{history,expected,playbook}`).
- **Public demo build (Q50):** `vite build --mode demo` sets `__TJ_DEMO__`
  (false in every other build, so the demo code is dropped from the real
  site). It generates its data in the browser (`src/demo/`, Q49): no lock
  screen, no `data.enc`, no key or token storage, no GitHub code, and a CSP
  without `api.github.com`. IMPORT is a browser-only dry run against the demo
  history, with sample Webull and Schwab CSVs to try or download; COMMIT,
  bulk-edit / tag / note CONFIRM and Refresh prices are disabled with a
  one-line reason; Settings shows one line instead of the token panel; LOCK
  is a `DEMO` chip and a "DEMO · synthetic data" line sits under the nav. UI
  preferences use a `tj.demo.*` prefix. Base path `/trade-journal/demo/`
  (`TJ_BASE` overrides it), output `dist-demo/`. `npm run build:demo` builds
  and runs `build/check-demo.ts` (app shell only, none of `data.enc`, `img/`,
  `tj.key`, `tj.gh`, `__data`, OPEN DEMO or the GitHub API, plus the
  plaintext leak guard when the sibling checkouts exist); `npm run
  serve:demo` serves it; `npm run dev:demo` is the dev server in demo mode.
  `test/build-leak.test.ts` builds both and checks each has none of the
  other's code.
- **Before each commit:** `npm run scan [-- --message "…"]` checks the lines a
  commit adds (and the message) for real traded symbols (1–2 letter ones as
  whole words, minus a fixed list of common words), Schwab account ids, stored
  fill ids and review / image names, read from the sibling checkouts
  (`cli/lib/private-scan.ts`, Q47). Local only.
- **Shared logic:** pure TS in `src/core/`, imported by both the app and the
  CLI. Hashing uses `@noble/hashes` (synchronous, identical in browser and
  Node).
- **JSON Schemas:** the canonical copies live in `trade-journal/schema/`, are
  validated against the synthetic output in tests, and are copied into
  `trade-history/schema/` by the importer on every write (Q17). The CLI
  validates every file it reads or writes with Ajv.
- **CLI:** run with `tsx`. Files that `vite.config.ts` loads (the build plugins and
  what they import) use explicit `.ts` import extensions, because Vite loads the
  config with Node's own TypeScript support, which needs them.
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
    core/dashboard/    dashboard.ts (open positions, recent 10, week strip, range widgets)
    core/account/      value.ts (cash, account value, % of account, checkpoints), commit.ts (config.json balances)
    core/calendar.ts   ET dates, weeks, trading sessions
    core/quotes.ts     quotes.json merge rules
    core/crypto.ts     encrypted file format + WebCrypto decrypt (shared with build/encrypt.ts)
    core/market.ts     prices-workflow market window
    core/reviews/      parse-header.ts, join.ts, images.ts
    core/reports/      math.ts (std dev, SQN, t-test, Kelly, K-ratio, streaks, drawdown), units.ts,
                       grid.ts, breakdowns.ts, reports.ts (tabs URL, win/loss days, drawdown, tags)
    core/journal/      filter.ts (URL state, matching), rows.ts (table rows, sort, prev/next),
                       calendar-view.ts, tags.ts, overrides.ts (bulk actions, commit plan), journal.ts
    core/import/       plan.ts (one import: parse, merge, regroup, preview, files), report.ts
    core/history/      files.ts (parse trade-history, exact bytes to write, git blob ids)
    core/github/       client.ts (REST + Git Data API), token-store.ts, deploy.ts
    core/schema.ts     Ajv validator over the schema texts (CLI: disk; app: bundled)
    app/               React pages and components
  cli/                 import.ts, trades.ts, verify.ts, scan-public.ts, lib/ (Node I/O)
  schema/              canonical JSON Schemas (copied into trade-history)
  build/               fetch-quotes.ts, load-bundle.ts, playbook.ts, dev-data-plugin.ts,
                       dev-demo.ts, check-dist.ts
                       bundle-data.ts, encrypt.ts, quotes-cache.ts, market-open.ts, preview-demo.ts, kdf.json,
                       public-log.ts (public-safe errors), pages-guard.ts, csp-plugin.ts, validators-plugin.ts
  test/fixtures/       synthetic CSVs + expected JSON
  .github/workflows/
    build-deploy.yml   reusable: test → demo → checkout data → [quotes] → build → encrypt → deploy
    ci.yml             on push / pull_request: typecheck + tests, read-only, no secrets (README badge)
    deploy.yml         on push / repository_dispatch / manual → build-deploy
    prices.yml         on schedule / manual → build-deploy with quotes
```

### Deploy workflow (`deploy.yml`)

Triggers: `push` to `main`, `repository_dispatch: [data-updated]`,
`workflow_dispatch`.

All of this lives in the reusable `build-deploy.yml`; `deploy.yml` and
`prices.yml` only call it.

1. Check that the deploy-key secrets and `SITE_PASSPHRASE` exist, check out
   `trade-journal`, `npm ci`, `npm test` (synthetic fixtures only), then
   `npm run pages-guard`: fail if any other repo of the account serves GitHub
   Pages (Q48), then `npm run build:demo` (`dist-demo/`, checked by
   `check-demo`; Q51). The demo is built before any private data is on disk
   and without `SITE_PASSPHRASE` in its environment; a broken demo fails the
   deploy.
2. Only then check out `trade-history` and `Playbook` into `./_data/` using
   their read-only deploy keys (`persist-credentials: false`), so neither the install
   nor the tests ever have the private data on disk (Q36).
3. Restore the encrypted quotes cache, `npm run build` (`tsc`, `vite build`,
   `check-dist` on the plain build).
4. `build/fetch-quotes.ts` prices the open positions (§5.4). This runs on
   every deploy, not only scheduled ones, so prices are never older than the
   latest deploy. A failed fetch never blocks the deploy.
5. `build/bundle-data.ts` gathers fills, overrides, config, symbols, derived
   trades, quotes, review markdown and the image list, then
   `build/encrypt.ts` (`npm run encrypt`) writes
   `data.enc` and `img/<hash>.enc`.
6. **Leak guard:** fail the deploy if `dist/` contains any symbol from the
   fills, any review ticker, or any review file name or image name in
   plaintext, in file contents or file names. `build/check-dist.ts` runs at
   the end of `npm run build`, and again as `check:dist -- --encrypted` after
   encryption, which also requires: only the app shell, `data.enc` and
   `img/*.enc` exist; every `.enc` file is well-formed, padded to its bucket
   and high-entropy; image files are `<32 hex>.enc` and their count is a
   multiple of 16. In `.enc` files only symbols of 6+ characters are
   token-searched, since random ciphertext often contains short uppercase
   runs. It skips a symbol that
   is also a word in the app's own source (e.g. a UI label), since the source
   is public and ticker-scanned before every commit (Q24).
   After `encrypt`, `dist-demo/` is copied to `dist/demo/`; `check:dist --
   --encrypted` allows only demo app-shell files there (`demo/index.html`,
   `demo/assets/*.{js,css,svg,woff2}`), reruns the demo checks on them, and
   its plaintext leak scan covers `demo/` too, so a demo ticker that is
   really traded fails the deploy.
7. `actions/upload-pages-artifact` → `actions/deploy-pages`.
8. The job uses `concurrency: pages` (not cancelling), so back-to-back imports
   and price runs queue and a newer pending run replaces an older one.
9. Nothing from `_data/` or the quotes is ever echoed to the logs, and with
   `TJ_PUBLIC_LOG=1` the scripts print no counts either (Q35).

**Local checks:** `npm run preview:demo` builds the production site on the
synthetic fixtures, encrypts it with a demo passphrase, runs the encrypted
checks and serves it with `vite preview`, for trying the lock screen. Only
that build has an **OPEN DEMO** button on the lock screen (the public demo
passphrase is compiled in with a Vite `define`); every real build has neither
the button nor the passphrase, which `test/build-leak.test.ts` checks, and the
demo passphrase can't open the real `data.enc` anyway.

### Data-repo dispatch (`notify-journal.yml`)

`trade-history` and `Playbook` each run a one-step workflow on push to
`main`: `gh api repos/Lykam/trade-journal/dispatches -f
event_type=data-updated` with `DISPATCH_TOKEN`. No payload, so nothing about
the commit leaves the private repo.

---

## 8. Security notes

- The browser PAT can write only to `trade-history`. It is stored encrypted
  and sent only to `api.github.com`.
- No market-data keys exist in v1. Prices are fetched by the Action and travel
  only inside the encrypted bundle.
- Markdown is sanitized before rendering.
- Because the repo is public, PR-triggered workflows must **never** get
  secrets. The deploy runs only on `push` to `main`, dispatch and manual
  triggers, never on `pull_request`. `ci.yml` (typecheck and tests) does run
  on pull requests, with `contents: read` and no secrets.
- If the passphrase is forgotten, change the secret and redeploy. Nothing is
  lost, because the plaintext lives in the private repos.
- **Public logs and artifacts.** Actions logs and the Pages artifact of a
  public repo are visible to anyone, so neither may hold plaintext data or
  counts (Q35). The `actions/cache` entry is encrypted (Q34). Fork pull
  requests should need approval for **all** outside contributors
  (Settings → Actions → General), so no fork workflow runs unreviewed.
  (Owner setting; the repo was on "first-time contributors" in the
  2026-10-04 review.)
- **One origin for all Pages sites (Q48).** `lykam.github.io` serves every
  project Pages site of the account, and the owner's browser keeps the site
  key and the sealed token in that origin's `localStorage`. Nothing may be
  served there that isn't built from this repo, so **no other Lykam repo
  enables GitHub Pages**; `npm run pages-guard` fails the deploy if one does.
  Visitors are not at risk either way: only the owner's browser holds a key.
- **Content-Security-Policy (Q46).** The built `index.html` carries a CSP
  meta tag: scripts, styles and fonts from the site only (the inline
  cache-reload script by hash), images also as `blob:` / `data:`, network to
  the site and `https://api.github.com` only, no `eval`. JetBrains Mono is
  self-hosted, so the page that holds the key loads no third-party CSS.
- **Actions pinned to commit SHAs** (with the version in a comment) in every
  workflow, since the deploy job holds the deploy keys and `SITE_PASSPHRASE`.
  Owner setting: Settings → Actions → General → allow GitHub-owned actions
  only.
- **The demo shares the site's origin (Q51).** `/trade-journal/demo/` is on
  `lykam.github.io`, where the owner's browser keeps the site key and sealed
  token. Visitors' browsers hold neither, so the demo can't expose data to
  anyone else; the remaining risk is demo code misusing the key in the
  owner's browser. The demo is built from this repo with the vault, token and
  GitHub code compiled out, its CSP allows no network beyond its own origin,
  its UI preferences use `tj.demo.*` keys, and tests plus `check-demo` /
  `check-dist` fail any build that references `data.enc`, `img/`, `tj.key`,
  `tj.gh` or the dev data.
- **Checkout SHAs in the log.** `actions/checkout` prints the trade-history
  and Playbook HEAD commit ids in the public log. They reveal only timing,
  which the run timestamps already show; accepted.
- **Error messages in public logs (Q43).** Every script the workflows run
  (`check-dist`, `fetch-quotes`, `encrypt`, `quotes-cache`, `market-open`)
  ends through `build/public-log.ts`: with `TJ_PUBLIC_LOG=1` an error prints
  only the script label and the error kind (`symbols.json: schema mismatch`,
  `fills/2026.json: invalid JSON`, or the error type), never the message, an
  Ajv instance path or a stack. Locally the full message prints.

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
6. **Playbook integration:** the review skill reads `derived/trades.json` and
   lists ideas; `Idea ID` in the template (§4.6).
7. **Reports** (§6.5: Overview, Detailed grid, breakdowns, Win vs Loss Days, Drawdown, Compare, Tag Breakdown).
8. **Review fixes** (2026-10-04 review, issues #1–#6): public-safe error
   messages in CI (Q43), staged edits during a commit preview, unmatched
   volume, buy fees in past marks (Q44), one export order, Webull partial-fill
   detection (Q45), CSP and self-hosted font (Q46), scan coverage (Q47), the
   shared Pages origin guard (Q48), pinned actions, cleanups.
9. **Demo build mode** (#7): a build that runs on synthetic data in the
   browser, with write features disabled and a "DEMO · synthetic data" line.
10. **Synthetic data generator** (#8, Q49): `src/demo/`.
11. **Demo hosting** (#9): `lykam.github.io/trade-journal/demo/` in the same
    Pages deploy, built before private data is checked out.
12. **Public repo polish** (#10): README, CI badge, metadata, fake tickers in
    the docs.

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
| Q8 | Single-stock ETFs | Trades in ETFs like NVQU count toward the **underlying** (NVQX) for ideas, reviews and ticker stats, while keeping `symbol`, `instrument`, `leverage` and `direction` for analysis. P&L and positions are computed on the ETF itself. Mapping lives in `trade-history/symbols.json`, and the import preview prompts for any new ETF it detects. |
| Q9 | Price source | A **scheduled GitHub Action** fetches quotes for open positions every 15 min during market hours (Yahoo through `yahoo-finance2`, no keys), plus on every deploy. Quotes travel only in the encrypted bundle. Expect them to be 15–30 min old. Browser-side live quotes are deferred to Future. |
| Q11 | Day vs swing | **Style = intent, not hold time.** Default by account (Schwab → swing, Webull → day), overridable per trade. A swing stopped out intraday still counts as a swing. A day trade held overnight is flagged for review, not changed automatically. |
| Q12 | Main-page content | Dashboard top, always visible: (1) gauges, (2) **open positions quick view** (opened date, trim dates, realized / unrealized / total P&L per position, plus totals), (3) **Recent 10 Day / Recent 10 Swing** side by side. An in-depth **Open Positions page** (event timeline, market value) sits behind it. |
| Q13 | Gauge details | Confirmed: open swing positions count in **every** week's swing gauge until closed. Padding minimums stay at **5 day / 3 swing**. Baseline = closed trades in the 90 days before this week. |
| Q14 | Import handling | Every original CSV is **archived** to `trade-history/imports/raw/`. When Claude imports, it shows the dry-run preview and **waits for your OK** before committing and pushing. |
| Q15 | Fill id length | 12 hex chars of SHA-256 (48 bits), not 8. At ~20k fills, 8 chars gives about a 5% chance of a collision; 12 makes it negligible. Collisions are still detected and reported as errors. (2026-10-03, milestone 1) |
| Q16 | Account mapping | `config.json` maps the Schwab export's file-name id to an account label (`schwabAccounts`), and names the Webull account (`webullAccount`). The real id exists only in private `trade-history`; tests use a fake `000`. (2026-10-03, milestone 1) |
| Q17 | Schema location | Canonical schemas live with the code in `trade-journal/schema/` and are copied into `trade-history/schema/` on each import, so the code and the contract can't drift. (2026-10-03, milestone 1) |
| Q18 | Webull ticker changes | Webull rewrites past rows to a new ticker (e.g. after a reverse merger). Webull fill ids hash the order's placed time instead of the symbol, so a renamed row dedupes to the same fill. The **first-seen symbol is kept** (what was traded, matching Tradervue and reviews written at the time), and the preview lists ticker changes. Schwab ids keep the symbol. (2026-10-03, milestone 1) |
| Q19 | Week strip | The dashboard week strip shows the **gauge week** (`weekStartsOn`, Mon–Sun), not Sun–Sat, so the strip and the gauges always cover the same days; on a Sunday a Sun–Sat strip would show an empty week. (2026-10-04, milestone 2) |
| Q20 | Backfill minimum | `minSample` counts **decisive** (win/loss) trades. Breakevens in the window are shown but don't count toward the 5 / 3 minimum, so the win rate always rests on at least that many trades. Labels count W/L. (2026-10-04, milestone 2) |
| Q21 | Stale quote | Stale = at least one complete regular session (weekday 09:30–16:00 ET) ended after the quote time, or the quote was carried over from a failed fetch. Friday's close is fresh over the weekend and on Monday until 16:00. Holidays aren't modeled, so a holiday makes a quote stale a day early. (2026-10-04, milestone 2) |
| Q22 | Charts | Hand-rolled SVG instead of Recharts: the widgets are simple, the Terminal look stays exact, and the bundle stays small. Green/red follow Q10; every value also carries its sign and a direct label, because red↔green is weak for color-blind readers. (2026-10-04, milestone 2) |
| Q23 | Gauge "now" | Gauges are computed as of `now`: later closes are ignored and open positions are rebuilt from their events, so past weeks (sparkline, tests, `?now=`) are reproducible. Historical marks use whatever quotes are passed in. (2026-10-04, milestone 2) |
| Q24 | Dev data and leak guard | Dev data comes from a serve-only Vite plugin behind `import.meta.env.DEV`; a build test plants a canary symbol and checks `dist/`. `check-dist` skips symbols that are also words in the public source. (2026-10-04, milestone 2) |
| Q25 | Swing mark basis | Open swing positions are marked on the **current average cost** (`avgCost`) plus realized P&L from trims, the same numbers as the Open Positions page, rather than `avgEntry`. (2026-10-04, milestone 2) |
| Q26 | Trade date | A trade belongs to its **ET close date** (the open date while open) for the Trades date column and date filter, the calendar and the week strip, so a day card and the trades it links to always agree. The calendar sums scored trades only (closed, matched, not excluded). (2026-10-04, milestone 3) Superseded for the calendar and week strip by Q67 (booked date). |
| Q27 | Gross / Net | Resolves the open item: a URL parameter (`pnl=gross`, default Net) on Trades, Trade detail, Calendar and Journal. Win / loss / breakeven always come from net P&L (Q2), so a trade that is green gross but red after fees is a loss in both modes. The dashboard stays Net. (2026-10-04, milestone 3) |
| Q28 | Idea view | An idea row is made of those of its trades that pass the filter; its result is the sign of their combined net P&L (scored trades only), and the summary counts ideas. Previous / Next in the Idea view walk each idea's trades oldest first. (2026-10-04, milestone 3) |
| Q29 | Review join details | Header fields win over the file name (`<DATE>-<TICKER>[-suffix].md`). A ticker matches the idea's underlying (through `symbols.json`) or any symbol traded in the idea. If a day and a swing idea share the underlying and date, the review's Trade Type picks one. A swing review dated a re-entry trade's open date links to the idea that trade joined. An Idea ID that no longer exists falls back to date + ticker. Unmatched reviews and ideas with several reviews appear under Needs attention. (2026-10-04, milestone 3) |
| Q30 | Category tag | The automatic Category tag is the first clause of the review's `## Category` section (up to `.`, `,`, `;`, `:` or a dash), capitalized, and only if it is at most 32 characters. Free-form sentences add no tag. (2026-10-04, milestone 3) |
| Q31 | Filters | Symbol accepts a comma list and matches the symbol or underlying exactly. Tags match **any** selected tag by default, with an ALL switch. Result is multi-select. Date presets (today, this / last week, this / last month, 30D, 90D, YTD) stay relative in the URL (`range=`). The calendar ignores the date filter, since its month arrows choose the dates. (2026-10-04, milestone 3) |
| Q32 | Edits before milestone 5 | Bulk actions (add / remove tag, set style, exclude / include), Add tags on Trade detail and the quick note are built and **staged**: the app applies them to `overrides.json` in memory and re-derives the trades from the fills to preview what changes (including ideas a style change regroups). The Commit button stays disabled until milestone 5. Nothing writes to trade-history. (2026-10-04, milestone 3) |
| Q33 | Charts and images | The Trade detail gallery shows `Images/<date>/<SYMBOL>-daily*` / `-intraday*` for the idea date and every open / close date of the idea's trades, for the underlying and every symbol traded. Images embedded in a review resolve relative to the review file. Start review copies `/playbook-review <UNDERLYING> <IDEA DATE>`. The markdown renderer is code-split and loads only when a review is shown. (2026-10-04, milestone 3) |
| Q34 | Encryption details | The PBKDF2 salt is random but **fixed** in `build/kdf.json`, so a remembered key survives the many deploys a day (a per-build salt would force the passphrase after every price run); edit it to force re-entry. Plaintext is padded to size buckets (64 KiB data, 32 KiB images), `data.enc` is gzipped JSON, and image files are HMAC-named with random decoys padding `img/` to a multiple of 16, so dist reveals no names and no exact counts. The header (and an image's own name) is GCM additional data. `SITE_PASSPHRASE` must be at least 16 characters. The quotes cache is stored encrypted, because caches in a public repo can be restored by other workflow runs. (2026-10-04, milestone 4) |
| Q35 | Public logs | Actions logs of a public repo are public, so with `TJ_PUBLIC_LOG=1` (set by `build-deploy.yml`) `fetch-quotes`, `check-dist` and `encrypt` print no counts (open positions, symbols, reviews, images), only outcomes. JSON parse errors, which quote their input, are replaced by a generic message. Locally the counts still print. (2026-10-04, milestone 4) |
| Q36 | Deploy order | The private repos are checked out **after** `npm ci` and `npm test` (the user's list had them first), so dependency install scripts and the test suite never run with private data on disk. Everything after that is as in §7. (2026-10-04, milestone 4) |
| Q37 | Data read access | The deploy reads `trade-history` and `Playbook` with **read-only SSH deploy keys** (secrets `TRADE_HISTORY_DEPLOY_KEY`, `PLAYBOOK_DEPLOY_KEY`) instead of a fine-grained PAT: each key reaches one repo, can't write, doesn't expire, and can be created with `gh` (PATs can't). `DISPATCH_TOKEN` stays a PAT, since `repository_dispatch` needs API access. (2026-10-04, milestone 4) |
| Q38 | Browser tokens | A fine-grained token's permissions apply to **every** repo it selects, so one token with Contents on `trade-history` and Actions on `trade-journal` would also get Contents: write on the public app repo, which deploys the site. "Refresh prices" therefore uses an optional **second** token (Actions: read & write on `trade-journal` only). Both are sealed together under an HKDF subkey of the site key in `localStorage`; Settings warns if the main token reaches `trade-journal`. The data repo is a setting, for testing on a throwaway repo. (2026-10-04, milestone 5) |
| Q39 | Leak guard vs. libraries | *(Superseded by Q46: Ajv is no longer bundled.)* `check-dist` also skips symbols that appear as words in bundled public library code (`VENDOR_DIRS`, now Ajv, whose code generator has short uppercase operator names that match a traded symbol). Ajv loads only with the import / commit chunk. (2026-10-04, milestone 5) |
| Q40 | Commit safety | Commits are computed from `trade-history` read fresh through the API, never from `data.enc`. On a moved `main` the app re-reads and recomputes (up to 3 tries) and commits only if the result matches the approved preview (new fill ids, ETF mappings and trade counts for an import; the changed override entries for an edit); otherwise it shows the new preview. Unchanged files are skipped by git blob id, so an import that adds nothing archives only new CSVs, and an edit already on `main` commits nothing. "Deploying…" resolves when a new `data.enc` was built from that commit or a later one (`history` in the bundle). (2026-10-04, milestone 5) |
| Q41 | Playbook skill | The `playbook-review` skill lists **ideas** from `derived/trades.json` (Python, no Node dependency) and names reviews `<IDEA DATE>-<UNDERLYING>.md`, filling in `**Idea ID:**` from the listing. Grouping stays in the journal; the skill only reads it. Its review matcher mirrors `join.ts` and is checked against a golden file from the journal's synthetic fixtures. The skill never imports trades itself, so imports keep their preview-and-OK step. `sync_review.py` embeds charts for every symbol traded in a pinned idea. (2026-10-04, milestone 6) |
| Q42 | Report stats | Every stat is computed over **units** (scored trades, or ideas in the Idea view) in close order, on the unit's value ($ gross / net, or % return on the cost bought). **Std dev:** sample (n − 1). **SQN:** √n × mean ÷ std dev, n not capped at 100, on $ P&L since no R is recorded. **Probability of random chance:** two-sided p-value of a one-sample t-test that mean P&L is 0 (t = SQN, df = n − 1). **Kelly %:** W − (1 − W) ÷ (avg win ÷ \|avg loss\|), W = wins ÷ (wins + losses). **K-ratio:** Kestner's 2003 form, slope ÷ (standard error × n) of a least-squares line through cumulative P&L at the end of each trading day (no account size, so not log equity); needs 3 days. **Expectancy:** W × avg win + (1 − W) × avg loss, per decisive unit, so it agrees with the win rate; "avg trade" is the plain mean including breakevens. **Streaks:** a breakeven ends a run of wins or losses. **Avg hold:** timed minutes, else whole calendar days for multi-day date-only trades; same-day Schwab trades have no hold and are left out. **Avg per-share:** $ P&L ÷ shares bought. **Avg daily:** total ÷ ET dates with a close. **Drawdown:** from the running peak of cumulative P&L starting at 0 (an opening loss counts), each unit a step so a dip within a day counts; longest = calendar days from the peak until back at it (or to the last close); recovery = trough to back at peak. With no account size, max drawdown % is taken on the summed % returns. Fees and commissions are one figure, since both brokers report them combined. (2026-10-04, milestone 7) |
| Q43 | Public error messages | A data file that fails to parse or validate throws a `DataFileError` carrying the file label and the kind (`invalid JSON` / `schema mismatch`). Node's `JSON.parse` quotes its input and an Ajv instance path starts with the object key (a ticker or fill id), so with `TJ_PUBLIC_LOG=1` the workflow scripts print only "`<script>: <file>: <kind>`" (or the error type), never the message or a stack, and exit non-zero; fixed messages with no data in them (`PublicError`) still print. Locally, and in the browser, the full message is kept. A test runs each entry point against a temp history carrying a canary ticker. (2026-10-04, milestone 8, #1) |
| Q44 | Buy fees on events | Open and add events carry the buy's `fees` (only when non-zero, so $0 fills keep their bytes), because `realizedPnl` already subtracts buy fees while trim / close `realized` holds sell fees only. `positionAt` subtracts them, so a swing gauge mark rebuilt for a past week agrees with Open Positions. Additive and optional in `trades.schema.json`; it reaches trade-history with the next regenerated `derived/trades.json`. Also: a trade's volume is the sum of its event quantities (a sell event already holds oversold shares). (2026-10-04, milestone 8, #4) |
| Q45 | Webull partial fills | **Detect and error only** (owner, 2026-10-04): a Webull fill whose order already has a different stored fill missing from the export is an import error, which blocks the commit; the fix is to remove the stored partial by hand and import the finished export. No order key is stored, so the fills contract (§3.1) is unchanged; the order is recognized by re-hashing the stored fill's id with the incoming `Placed Time` (§4.3). Checked against every real export in Downloads: no false positives. (2026-10-04, milestone 8, #2) |
| Q46 | CSP | The built site has a strict CSP (§8) with no `unsafe-inline` / `unsafe-eval`: the inline cache-reload script is allowed by a SHA-256 hash computed at build time (`build/csp-plugin.ts`), the font is self-hosted (`@fontsource/jetbrains-mono`, Latin, 400/500/700), and the browser's JSON Schema validators are precompiled by Ajv's standalone mode (`build/validators-plugin.ts`, `virtual:tj-validators`) because Ajv otherwise compiles with `new Function`. The CLI still compiles the same schema files at runtime; a test checks both give the same result. The dev server gets no CSP (hot reload needs inline styles). Ajv is no longer bundled, so `check-dist` no longer exempts its code (supersedes Q39's `VENDOR_DIRS`). (2026-10-04, milestone 8, #5) |
| Q47 | Scan coverage | `npm run scan` also checks Schwab account ids (in their `XXX<id>`, masked `...<id>` and quoted forms; a bare number is too common to match) and stored fill ids, and matches 1–2 letter symbols as whole words outside a fixed list of common words (`SHORT_WORDS`, not derived from the data). `check-dist` keeps its quoted-only rule for short symbols, since minified code is full of short identifiers. (2026-10-04, milestone 8, #5) |
| Q48 | Shared Pages origin | No repo of the account other than trade-journal may enable GitHub Pages, because every project site shares `lykam.github.io` with the stored key and token. `build-deploy.yml` checks the public repo list (`has_pages`) before checking out private data and fails the deploy otherwise. (2026-10-04, milestone 8, #5) |
| Q49 | Demo data | The public demo runs on **synthetic** data only (owner decision): real data with renamed tickers would still identify the stocks by price and date and publish real P&L, and the generator is not calibrated from real files. `src/demo/generate.ts` makes about 6 months of fills ending at "now" (ET) from a seeded PRNG (mulberry32) keyed by trading days before the anchor date, so a date always gives the same bundle and a later date shifts it; nothing is dated after now. A Webull-style day account (about 250 trades, timed to the second, partial scale-outs, one trade held overnight) and a Schwab-style swing account (about 50 trades, date-only, adds, trims, small fees, 6 open positions) trade 12 made-up tickers plus two 2x ETFs and an inverse ETF (`src/demo/tickers.ts`); trades and ideas come from the real `buildTrades`. The current week is scripted by searching the outcomes of the trades the gauges read, so Day shows ½ size (¼ if ½ can't be reached) and Swing Full size. Overrides sit on trades older than the baseline window. 9 reviews are built mechanically from the template's sections with fixed placeholder lines and a Category from a fixed list (no narrative); charts are generated SVG candlesticks from the same prices, with entry and exit markers, under the usual `Images/<date>/<TICKER>-daily.png` paths so the real site's image rules don't change. It runs in about 100 ms. (2026-10-04, milestone 10, #8) |
| Q50 | Demo build | One app, two builds: a compile-time flag (`__TJ_DEMO__`, Vite `define`, `--mode demo`) switches the data source and the write features, so the real build has no demo code, data, passphrase or button and the demo build has no vault, token or GitHub code (both checked by building them in a test). The demo keeps the app fully usable: every page, Trade detail with review and charts, Reports, and Import as a browser-only dry run; anything that would write or fetch real data is disabled with one line saying what the real site does. No About page and no narrative (owner decision), only the "DEMO · synthetic data" line. (2026-10-04, milestone 9, #7) |
| Q51 | Demo hosting | Owner decision: the demo lives at `https://lykam.github.io/trade-journal/demo/`, inside the same Pages deploy, with no separate org, repo or host. Same origin is acceptable because only the owner's browser holds the key and token, and the demo build provably contains no code that reads them (§8). It is built after `npm test` and before the private repos are checked out, copied into `dist/demo/` after encryption, and checked as part of the encrypted dist. Pages serves one artifact per repo, so a broken demo fails the whole deploy rather than going out unnoticed. The repo homepage points at the demo. (2026-10-04, milestone 11, #9) |
| Q52 | Public repo | No license (owner decision). README: what the app is, a live demo link, features, screenshots taken from the demo only, how to run it locally, and a pointer to this spec and its security model; no "how it was built" narrative. Every real ticker in the current docs is replaced by the demo's made-up names (NVQX / NVQU 2x / NVQD inverse, MZRT / MZRU, HXQY → 999990.KS as the Korean-listed example, and so on), keeping each example's meaning; history is not rewritten. `SPY` in `build/market-open.ts` stays: it is the broad index ETF the prices workflow asks for the market state, not a holding. `ci.yml` gives the README its badge. (2026-10-04, milestone 12, #10) |
| Q53 | Tradervue import | One-time CLI import of a Tradervue **trades** export (§4.7), owner decisions 2026-10-04. Tradervue wins for **tags** (union of duplicate copies; automatic tags such as `Swing` aren't stored) and **style** (the `Swing` tag means swing, its absence day; overrides only where it differs from the account default). Its **notes** become quick notes as plain text, capped at 500 characters. The broker fills stay the truth for P&L and quantities: discrepancies are listed, never applied. The export has no executions and only one trade predated the broker exports (a position opened before the Schwab export starts), so **no synthetic fills** and no schema change; the owner left that position out for now, to reconcile later. Matching uses the exact second for timed trades, regardless of symbol (Webull renames, Q18), and symbol + dates + shares + P&L for date-only ones. Not in the web app: it runs once, from the CLI, behind the usual dry-run-and-OK step (Q14). (2026-10-04) |
| Q54 | Open trades in tables | UX review (#14): an open trade has no result, so tables never show its booked P&L (often 0.00, or a red buy fee) as if it were one. Trades, the Journal list, the review page and the Idea panel show the mark at the last price in muted text (`open +19.50`; `open —` without a quote); an idea with closed and open trades adds the closed results and the open marks, and still reads as open. Open rows sort after closed ones on P&L in both directions. Buy fees stay in realized P&L (Q44, average-cost basis unchanged), labeled `REALIZED · 0 TRIMS · 0.65 FEES`. Days held are whole ET calendar days everywhere (`daysHeld`). Stops and risk are deferred (§11). (2026-10-04, #14) |
| Q55 | Dashboard top | UX review (#15), owner decisions 2026-10-04. **Needs attention** joins the pinned top blocks as one line under the gauges that opens into the list, hidden when empty, and adds today's unreviewed trades. **Backfill stays** (Q13, Q20): there is no "not enough trades" state, since earlier trades always fill the window; the gauge says so instead (`1 CLOSED THIS WEEK, 4 EARLIER` and a note). **Full-size target:** the fewest extra wins this week that reach Δ ≥ 0 with nothing else changing, each win pushing the oldest backfilled trade out; none at full size, without a baseline or beyond 50. **Imports:** the bundle carries the latest `importedAt` per broker (`imports`; fills keep theirs blank), and the top bar flags one older than the latest closed session (weekdays 16:00 ET, no holidays, like Q21). The 30/60/90 block gets an ALL / DAY / SWING toggle; the week strip hides empty weekend days and says it covers all styles; the Recent 10 strip runs newest first like its list; largest gain / loss are two bars instead of a half-gauge. (2026-10-04, #15) |
| Q56 | One set of numbers | UX review (#16). **Win %** is always wins ÷ (wins + losses): the dashboard donut's legend shows counts only and its center the tile's figure, and the Detailed grid shows Winners / Losers / Breakeven as counts with Win % once. **% mode** (owner decision): totals stay, labeled `SUM OF TRADE %`, with a hover saying it is not an account return; drawdown drops "of peak" in % mode. **Hold** splits by style whenever both are in a grid (Detailed, Compare, Win vs Loss Days). The Trades tile counts open rows apart (`8 OPEN · 296 CLOSED`), so its closed count matches Reports. A calendar week that spans two months is dimmed and names the other month. (2026-10-04, #16) |
| Q57 | Phone layout | UX review (#17), at 390 px. **P&L never leaves the screen:** below 640 px every table hides its middle columns instead of becoming cards (Dashboard open positions: symbol, %, total; OPEN: symbol, days, unrealized %, total; Trades: date without the year, symbol, P&L, 📄; Journal: date, ticker, status, P&L; Recent 10 drops the hold), and the Trades select column goes, since bulk edits are a desktop task. The OPEN timeline is hidden. **Order** stays the desktop one (owner decision), with compact gauges (Q55). The nav is one scrolling line. The week strip shows weekdays only; the calendar uses whole dollars and narrow weekends. (2026-10-04, #17) |
| Q58 | Wording | UX review (#13): the find-and-replace table applied, with owner changes (`UNREALIZED`, not `OPEN P&L`, which would clash with Total open P&L; `DAYS TRADED`; Newer / Older only under a date sort). Rules: no "CUM"; W/L as `6W 5L` (`1BE` when there are breakevens); holds `6m 28s`, `1h 09m`, multi-day `17d`; ISO dates in headers and detail pages, `09-21` in dense tables; one price stamp `PRICES 10-02 16:00`; one ETF badge `2x→MZRT` / `−2x→NVQX`; sentences spell out half / quarter size; footnotes in sentence case. Kept short forms: P&L, AVG, ET, sh, 30D/60D/90D, PF in the Tag Breakdown table, SQN, K-ratio, Kelly %, and the nav and logo. (2026-10-04, #13) |
| Q59 | Compare presets | UX review (#18), owner decision 2026-10-04: a preset resets the fields presets own (style, instrument, broker, date preset and range) on both sides before applying its own, keeping every other filter. Before, DAY VS SWING set STYLE = DAY on the global filter and THIS MONTH VS LAST MONTH then compared day trades only, without saying so. Side names come from `compareLabels` (the fields that differ, then the dates); B − A is shown for the numeric stats (win % in points). (2026-10-04, #18) |
| Q60 | Chart readouts | UX review (#19), within Q22's hand-rolled SVG: every chart shows its top and bottom values on the left edge, first / middle / last dates under it, and a one-line readout of the hovered or tapped point (date and value; P&L and running total on cumulative charts) with a crosshair, instead of slow native tooltips. Daily win % has a legend (green at or above average, gray below) and a minimum bar height so 0% days stay visible; the gauges' 8-week bars put the hovered week in place of their label; breakdown bars read `P&L · count · win %` (win % on desktop only). (2026-10-04, #19) |
| Q61 | Breakdowns | UX review (#20). **Entry time:** 15-minute buckets 09:30–11:00, hourly after, pre-market apart (`entryBucket`, from the unit's `entryMinute`). **Best / worst:** `topBottom` splits only above 2 × 20 groups, and the worst list holds losing groups only, worst first; a shorter list is one list, so winners never sit under "worst". **Small samples:** under 10 units, profit factor, SQN and Kelly are grayed with a hover saying so; ∞ is shown as "—" ("No losses"). **Tag vs Category** stay separate (owner decision), with clearer headings. SQN, K-ratio, Kelly % and Chance it's luck each have a one-line hover. (2026-10-04, #20) |
| Q62 | Trades and Trade detail | UX review (#21). The Date column is always one date (close, or open while open), with a multi-day range moved to Hold. The bulk bar docks at the bottom of the screen under the table. Notes hides when the page has none. Filter bars start collapsed unless something is filtered, with the active filters as chips. Trade detail moves the charts into the left column, links its review with 📄 (the one reviewed marker everywhere, replacing the dashboard's `R` and the detail chip), and steps with `j` / `k`. Native date inputs stay (owner decision): a text field would lose the phone date picker. (2026-10-04, #21) |
| Q63 | Journal and Calendar | UX review (#22). The Journal's REVIEW column folds in the idea status; an OPEN review on a closed idea (`exitMissing`, the same check Needs attention uses) reads EXIT MISSING and sorts first (`journalOrder`). The second IDEA column is gone and the Reviewed filter is hidden there. The review page header gives the idea's date span. The calendar outlines today and the year view gets weekday letters and a legend. (2026-10-04, #22) |
| Q64 | Import and Settings | UX review (#23), owner decision 2026-10-04: a new ETF mapping row is pre-ticked when its guessed underlying is already traded (`preTick`). It stays visible and editable and is written only on Commit, so Q8's explicit mapping holds. Import plumbing (file list, ref) is collapsed; a commit ends with a link back to the dashboard; IMPORT shows as active on its page. Settings states the gauge rules from config (`gaugeRules`) and puts the two JSON views side by side. (2026-10-04, #23) |
| Q65 | Leak guard vs. HTML names | `check-dist` again skips symbols that appear as words in bundled public library code (`VENDOR_DIRS`), now **parse5**, the HTML parser behind `rehype-raw`, which lists every HTML tag and entity name in capitals. A newly traded ticker that is also an HTML tag name failed a deploy on 2026-10-05 as a false positive. Like the app source, library code is public and can hold no data; the guard still checks every other symbol, and `.enc` files are unaffected (Q39, Q46). (2026-10-05) |
| Q66 | Symbol mappings in the app | Owner request 2026-10-05: two ETFs whose broker names didn't look leveraged were never offered at import, so `symbols.json` is now editable from Trade detail and Settings. One commit writes `symbols.json` and a regenerated `derived/trades.json` (`src/core/symbols/mapping.ts`), through the same read-fresh / preview / CONFIRM / retry flow as override edits (Q40), with the changed entries as the fingerprint. Mapping stays an explicit choice (Q8): nothing is mapped without CONFIRM. The demo shows the form with COMMIT disabled, and its GitHub code is not in the demo bundle (Q50). (2026-10-05) |
| Q67 | Trims on the calendar | Owner request 2026-10-06: a trim on a still-open swing should count on the day it was taken. The calendar (month, week totals, year view) and the dashboard week strip now sum P&L **by booked date**: each trim and the close on its own ET day (`bookedByDay` in `core/trades/stats`). Buy fees go with the first sale after them; the close books whatever is left, so a closed trade's days add up to its gross or net P&L exactly. Open trades count their trims; excluded and unmatched trades book nothing. A day's trade and idea counts are the trades and ideas that booked P&L that day. Clicking a day or week opens Trades with `booked=1`, listing trades with a trim or close in the range, so a day and its list still agree. With BOOKED, the Trades P&L column, its sort and the total tile (`NET P&L · BOOKED THESE DAYS`) use what each trade booked in the range: an open trade shows its trims (`+4.46 TRIM`), with the whole trade's figure in the title (owner report 2026-10-06: the day list showed the open mark and closed-only total, so it didn't match the calendar). Q26 still holds for the date filter, the Trades date column and Reports, which score closed trades on their close date. (2026-10-06) || Q10 | Look and feel | Direction **B "Terminal"** (monospace, near-black, amber accent, top nav) with **standard green/red** gain/loss colors (§6.0). |
| Q68 | Account value | Owner request 2026-10-06: see each holding's share of the swing account. `config.json` gets optional `balances`: per account a **start** (date and cash amount; trades opened before it are left out) and **checkpoints** (an actual value from the broker at a close, with the price of each symbol held then). **Cash** = start + every buy and sale since, from the events' prices and the trades' fees, so it is exact to the cent; **value** = cash + open positions at the last quote, or at cost without one (`N AT COST`). Excluded trades still move cash. The latest checkpoint up to today adds a **correction**: its value minus what the trades give for that close at its stored prices. It is recomputed from today's trades, so fills imported after it was entered don't count twice, and it carries forward until the next one; it covers what fills miss (interest, fees, transfers; the owner says this account has none). Dashboard and Open Positions show an account line and **% ACCT** (market value, or cost when unpriced, ÷ account value). Settings → Account value edits it; a commit writes `config.json` and trade-history's `schema/config.schema.json`, never trades. The demo's swing account gets a round starting balance. Code: `core/account`. (2026-10-06) |
| Q69 | Weekdays-only calendar | Owner request 2026-10-06: Saturday and Sunday columns are noise, since nothing is traded then. The month grid and year heatmap show **Mon–Fri** (plus the WEEK column); week totals still cover the whole week. Fallback: if any weekend day in view has trades (a mis-dated fill, say), the full seven-day layout returns for that month or year, so no P&L is ever hidden. The dashboard week strip already hides empty weekends (#15). (2026-10-06) |### Still open
| Q70 | Reviews: swing required, day optional | Owner decision 2026-10-06: every swing trade gets a review; day-trade reviews are optional. Needs attention's "unreviewed trades today" counts **swing trades only**, and its REVIEW › link opens `style=swing&range=today&review=no`, so the line (and the whole block, when nothing else is listed) goes away once the swing trades are reviewed. Nothing on screen says day reviews are optional. (2026-10-06) |
- UX review fixes (#13–#23, Q54–Q64) were checked on the local demo at
  desktop and 390 px width; the owner checks the real site after the merge.
  #24's features are listed in §11, not built.
- Milestones 8–12 (2026-10-04) are tested locally, including the full deploy
  sequence against the real checkouts with public logs. After merge, check
  live: the deploy log, `/trade-journal/demo/` at desktop and phone width, and
  that the real site still unlocks with the remembered key and token after
  visiting the demo in the same browser. Owner settings from #5 (GitHub-owned
  actions only; fork-PR approval for all outside contributors) and the repo
  description, homepage and topics (#10) are set by the owner.
- Public docs use the demo's made-up tickers (Q52); git history before
  2026-10-04 is not rewritten (owner decision).

- Milestone 7 (Reports) was checked live on 2026-10-04 against the real data at desktop and phone width: the Overview, Detailed (month by month), Compare (Stock vs ETF), Tag Breakdown and Idea-view totals match `npm run verify`, and the ↗ trade and streak links land on the right trade and dates. The milestone-5 placeholder tag `test-tag` was removed from trade-history.
- Milestone 5 was checked live on 2026-10-04: token save, two fixture imports and an override edit committed to a throwaway repo (byte-identical to the CLI), "Deploying…" resolving, and one override edit on trade-history.
- Milestone 6 was checked live on 2026-10-04 with a placeholder test review (written from the template with the skill's scripts, then removed): the push dispatched a redeploy, the review linked to its idea by Idea ID in the Journal, Trades and Trade detail at desktop and phone width, and the deploy log was clean. The first real review with the updated skill is still to come.

## 11. Future

- **TradingView charts on Trade detail,** using the free
  `lightweight-charts` library with execution markers. This needs intraday
  bars from a market-data source, which would also unlock MFE/MAE,
  "best exit", and the Market Behavior and Liquidity reports.
- Dashboard **Edit Layout** and manual **New Trade** entry. (The one-time
  import of Tradervue's tags and notes is built: §4.7, Q53.)
- Live browser-side quotes (Finnhub free key, stored encrypted) layered on top
  of the scheduled Action prices, if 15–30 min delay ever proves too slow.
- R-multiples, if a planned stop is recorded per trade. Stops would also give
  the open-position views STOP, RISK $ (`shares × (avg − stop)`) and % TO
  STOP (UX review #14 item 5, #24; owner deferred them, 2026-10-04).
- Short selling and options. `assetType` is reserved, and grouping would need
  signed positions.
- Auto-suggest "worth reviewing" trades.
- **From the UX review (#24, 2026-10-04),** things other journals have, each
  a scope decision for later (owner: none in this round): initial risk / stop
  and R-multiples (above, the trader's top pick); an **account balance**
  (done for the value and % of account, Q68; drawdown and % views against it
  are still open); execution markers on an intraday chart (the TradingView item
  above); MFE / MAE (needs intraday prices); an **entry time column** on
  Trades for day trades; a **daily note / pre-market plan**, perhaps in
  Playbook like reviews; a **"mistakes cost" line** (e.g. a tag's P&L this
  month) on the dashboard; a **daily loss limit** with breached days flagged
  on the calendar; the **current streak** on the dashboard; **saved filter
  views** and **CSV export** of the filtered trades; and a long / short side
  column, if shorts or inverse ETFs ever count as short.
