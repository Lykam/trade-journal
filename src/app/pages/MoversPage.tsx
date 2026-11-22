// MOVERS (SPEC §6.7f, Q85): a research list of every week's big movers, US stocks
// that moved 50%+ either way on $100M+ average daily dollar volume, priced over $5.
// movers.json is written weekly by `npm run movers -- --publish` (a Windows
// scheduled task) into trade-history, and the deploy bundles it. Each row can
// carry a short note (Q86), saved to trade-history's mover-notes.json.
import { Fragment, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { etDate } from "../../core/normalize/util";
import { filterMovers, moverRows, NO_FILTER, type MoverFilter, type MoverRow } from "../../core/movers/movers";
import { NOTE_MAX, cleanNote, noteKey } from "../../core/movers/notes";
import type { DataBundle, Trade } from "../../core/types";
import { TradingViewChart } from "../components/TradingViewChart";
import { DEMO_COMMIT_NOTE } from "../demo-text";
import { ACTIONS_URL, useToken, watchDeploy } from "../github";

const MINUS = "−";
const PAGE = 150;
const signed = (n: number) => `${n > 0 ? "+" : n < 0 ? MINUS : ""}${Math.abs(n).toFixed(1)}%`;
const dollars = (n: number) => (n >= 1e9 ? `$${(n / 1e9).toFixed(1)}B` : `$${Math.round(n / 1e6)}M`);
const usd = (n: number) => `$${n >= 100 ? n.toFixed(0) : n.toFixed(2)}`;

type Choice<K extends keyof MoverFilter> = { value: MoverFilter[K]; label: string; title?: string };
const DIRS: Choice<"dir">[] = [{ value: "all", label: "ALL" }, { value: "up", label: "UP" }, { value: "down", label: "DOWN" }];
const BASES: Choice<"basis">[] = [
  { value: "all", label: "ALL" },
  { value: "close", label: "HELD ON CLOSE", title: "The Friday close moved 50%+" },
  { value: "intraweek", label: "INTRAWEEK", title: "Only the week's high or low reached 50%: it faded by Friday" },
];
const LIQ: Choice<"liquidity">[] = [
  { value: "all", label: "ALL" },
  { value: "before", label: "LIQUID BEFORE", title: "30-day average dollar volume already over the bar" },
  { value: "move", label: "LIQUID FROM MOVE", title: "Only this week's volume cleared the bar" },
];

function Pills<K extends keyof MoverFilter>({ label, k, choices, f, set }: { label: string; k: K; choices: Choice<K>[]; f: MoverFilter; set: (f: MoverFilter) => void }) {
  return (
    <div className="pillgroup" role="group" aria-label={label}>
      <span className="label small">{label}</span>
      {choices.map((c) => (
        <button key={String(c.value)} type="button" className="pill" title={c.title} aria-pressed={f[k] === c.value} onClick={() => set({ ...f, [k]: c.value })}>
          {c.label}
        </button>
      ))}
    </div>
  );
}

// Notes saved this session (key → text, "" when removed), shown at once and kept across
// navigation until the redeploy brings them in the bundle.
const saved = new Map<string, string>();
const listeners = new Set<() => void>();
let version = 0;
const savedStore = {
  subscribe: (fn: () => void) => (listeners.add(fn), () => void listeners.delete(fn)),
  get: () => version,
};
function setSaved(key: string, text: string) {
  saved.set(key, text);
  version++;
  listeners.forEach((fn) => fn());
}

interface NoteProps {
  k: string;
  initial: string;
  onClose: () => void;
}

/** The demo has no token or GitHub code (Q50): its editor can't save. */
function NoteEditor(p: NoteProps) {
  return __TJ_DEMO__ ? <NoteFields {...p} busy={false} error={null} save={null} status={<span className="note-line small">{DEMO_COMMIT_NOTE}</span>} /> : <LiveNoteEditor {...p} />;
}

function LiveNoteEditor({ k, initial, onClose }: NoteProps) {
  const token = useToken();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (value: string) => {
    if (token.status !== "ok" || busy) return;
    setBusy(true);
    setError(null);
    try {
      const [{ commitMoverNote }, { GitHubClient, parseRepo }] = await Promise.all([import("../../core/movers/notes-commit"), import("../../core/github/client")]);
      const repo = parseRepo(token.record.repo);
      if (!repo) throw new Error("The saved token has no trade-history repo; save it again in SETTINGS.");
      const out = await commitMoverNote(new GitHubClient(token.record.token), repo, k, value);
      setSaved(k, out.file.notes[k]?.text ?? "");
      if (out.date) watchDeploy({ label: value.trim() ? "Note saved" : "Note removed", want: { date: out.date, ...(out.sha ? { sha: out.sha } : {}) }, link: `${ACTIONS_URL}/workflows/deploy.yml`, ...(out.url ? { commitUrl: out.url } : {}) });
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const status =
    token.status === "ok" ? <span className="dim small">Commits to {token.record.repo}.</span>
    : token.status === "loading" ? null
    : <span className="dim small">To save, add a GitHub token in <a href="#/settings">SETTINGS</a>.</span>;
  return <NoteFields k={k} initial={initial} onClose={onClose} busy={busy} error={error} save={token.status === "ok" ? save : null} status={status} />;
}

function NoteFields({ initial, onClose, busy, error, save, status }: NoteProps & { busy: boolean; error: string | null; save: ((text: string) => Promise<void>) | null; status: React.ReactNode }) {
  const [text, setText] = useState(initial);
  const clean = cleanNote(text);
  const canSave = !!save && clean !== initial && !busy;
  return (
    <div className="mover-note-edit">
      <textarea
        className="input"
        rows={2}
        maxLength={NOTE_MAX}
        value={text}
        autoFocus
        placeholder="A short note on this move…"
        aria-label="Note"
        disabled={busy}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            if (canSave) void save(text);
          }
        }}
      />
      <div className="row">
        <span className="dim small">{clean.length}/{NOTE_MAX}</span>
        <button type="button" className="btn primary" disabled={!canSave} onClick={() => save && void save(text)}>{busy ? "SAVING…" : "SAVE"}</button>
        {initial && <button type="button" className="btn" disabled={busy || !save} onClick={() => save && void save("")}>REMOVE</button>}
        <button type="button" className="btn ghost" disabled={busy} onClick={onClose}>CANCEL</button>
        {status}
      </div>
      {error && <div className="loss small" role="alert">{error}</div>}
    </div>
  );
}

/** The narrowest TradingView range preset (counted back from today; the free widget can't anchor to a date) that reaches `oldest`. */
export function chartRange(oldest: string, today: string): string {
  const days = (Date.parse(today) - Date.parse(oldest)) / 86_400_000 + 14;
  return days <= 90 ? "3M" : days <= 180 ? "6M" : days <= 365 ? "12M" : "60M";
}

/** Your trades on the ticker that were open at some point in the mover's week. */
function tradedThatWeek(trades: Trade[], r: MoverRow): Trade | undefined {
  return trades.find((t) => t.underlying === r.ticker && etDate(t.openedAt) <= r.weekEnd && (!t.closedAt || etDate(t.closedAt) >= r.week));
}

/** The filter lives in the hash ("#/movers?q=SLS&dir=up"), so clicking a ticker is a page the back button returns from. */
export function moversFilterOf(params: URLSearchParams): MoverFilter {
  const pick = <T extends string>(v: string | null, ok: readonly T[], d: T): T => (ok.includes(v as T) ? (v as T) : d);
  return {
    q: params.get("q") ?? "",
    dir: pick(params.get("dir"), ["all", "up", "down"], "all"),
    basis: pick(params.get("basis"), ["all", "close", "intraweek"], "all"),
    liquidity: pick(params.get("liq"), ["all", "before", "move"], "all"),
  };
}

export function moversHash(f: MoverFilter): string {
  const p = new URLSearchParams();
  if (f.q) p.set("q", f.q);
  if (f.dir !== "all") p.set("dir", f.dir);
  if (f.basis !== "all") p.set("basis", f.basis);
  if (f.liquidity !== "all") p.set("liq", f.liquidity);
  const qs = p.toString();
  return `#/movers${qs ? `?${qs}` : ""}`;
}

export function MoversPage({ data, params = new URLSearchParams() }: { data: DataBundle; params?: URLSearchParams }) {
  const file = data.movers ?? null;
  const all = useMemo(() => moverRows(file), [file]);
  const fromUrl = useMemo(() => moversFilterOf(params), [params]);
  const [f, setF] = useState<MoverFilter>(fromUrl);
  const [shown, setShown] = useState(PAGE);
  useEffect(() => setF(fromUrl), [fromUrl]);
  /** `push`: a new history entry (a ticker click, CLEAR); otherwise the current entry is updated, so typing doesn't fill the history. */
  const set = (next: MoverFilter, push = false) => {
    setF(next);
    setShown(PAGE);
    const h = moversHash(next);
    if (push) window.location.hash = h;
    else window.history.replaceState(window.history.state, "", h);
  };
  const bar = file?.criteria.dollarVolume;
  const rows = useMemo(() => filterMovers(all, f, bar), [all, f, bar]);
  const filtered = JSON.stringify(f) !== JSON.stringify(NO_FILTER);
  const trades = data.derived.trades;
  useSyncExternalStore(savedStore.subscribe, savedStore.get, savedStore.get);
  const [editing, setEditing] = useState<string | null>(null);
  // A clicked ticker (the search is exactly one ticker's symbol) gets a daily chart under the table.
  const charted = f.q.trim().toUpperCase();
  const chartRows = charted && rows.length && rows.every((r) => r.ticker === charted) ? rows : null;
  const noteOf = (k: string) => (saved.has(k) ? saved.get(k)! : data.moverNotes?.notes[k]?.text ?? "");

  const up = rows.filter((r) => r.dir === "up").length;
  const held = rows.filter((r) => r.basis === "close").length;
  const weeks = new Set(rows.map((r) => r.weekEnd)).size;

  return (
    <main className="page">
      <header className="page-head">
        <h1>MOVERS <span className="sub">/ {filtered ? `${rows.length} OF ` : ""}{all.length} MOVER{all.length === 1 ? "" : "S"}</span></h1>
      </header>
      <div className="dim small">
        US stocks that moved {file?.criteria.move ?? 50}%+ in a week, up or down, on {dollars(bar ?? 100e6)}+ average daily dollar volume (that week or the last 30 days), priced over ${file?.criteria.price ?? 5}.
        {file?.through ? <> Through the week ending {file.through}; updated every Saturday.</> : null}
      </div>

      {all.length > 0 && (
        <>
          <section className="panel statrow" aria-label="Summary">
            <div><div className="label small">MOVERS</div><div className="v">{rows.length}</div><div className="muted small">IN {weeks} WEEK{weeks === 1 ? "" : "S"}</div></div>
            <div><div className="label small">UP / DOWN</div><div className="v"><span className="gain">{up}</span> / <span className="loss">{rows.length - up}</span></div></div>
            <div title="The Friday close moved 50%+, vs. only the week's high or low"><div className="label small">HELD ON CLOSE</div><div className="v">{rows.length ? Math.round((held / rows.length) * 100) : 0}%</div><div className="muted small">{rows.length - held} INTRAWEEK ONLY</div></div>
          </section>

          <section className="panel quotes-filter plays-filter movers-filter" aria-label="Filter movers">
            <div className="row">
              <input type="search" className="input quotes-search" placeholder="Ticker…" value={f.q} onChange={(e) => set({ ...f, q: e.target.value })} aria-label="Search tickers" />
              {filtered && <button type="button" className="btn ghost tiny" onClick={() => set(NO_FILTER, true)}>CLEAR</button>}
            </div>
            <Pills label="DIRECTION" k="dir" choices={DIRS} f={f} set={set} />
            <Pills label="MOVE" k="basis" choices={BASES} f={f} set={set} />
            <Pills label="LIQUIDITY" k="liquidity" choices={LIQ} f={f} set={set} />
          </section>
        </>
      )}

      <section className="panel">
        {all.length === 0 ? (
          <div className="empty">
            No movers yet. <code>npm run movers -- --publish</code> writes <code>movers.json</code> to trade-history; the page fills in after the next deploy.
          </div>
        ) : rows.length === 0 ? (
          <div className="empty">No mover matches.</div>
        ) : (
          <>
            <div className="scroll-x">
              <table className="grid movers-table">
                <thead>
                  <tr>
                    <th>WEEK</th><th>TICKER</th><th className="num">MOVE</th>
                    <th className="num ph-hide" title="The week's high vs the prior week's close">HIGH</th>
                    <th className="num ph-hide" title="The week's low vs the prior week's close">LOW</th>
                    <th className="num ph-hide">PRICE</th>
                    <th className="num" title="Average daily dollar volume this week">$VOL/DAY</th>
                    <th className="num ph-hide" title="Average daily dollar volume, 21 market days ending this week">30D</th>
                    <th className="num ph-hide" title="Average daily range (high − low) / low this week">ADR</th>
                    <th>NOTE</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, shown).map((r, i) => {
                    const t = tradedThatWeek(trades, r);
                    const firstOfWeek = i === 0 || rows[i - 1]!.weekEnd !== r.weekEnd;
                    const k = noteKey(r.weekEnd, r.ticker);
                    const note = noteOf(k);
                    return (
                      <Fragment key={k}>
                      <tr className={firstOfWeek ? "week-first" : ""}>
                        <td className="muted">{firstOfWeek ? r.weekEnd : ""}</td>
                        <td>
                          <button type="button" className="linklike sym" title={`Show every week ${r.ticker} qualified`} onClick={() => set({ ...NO_FILTER, q: r.ticker }, true)}>{r.ticker}</button>
                          {r.repeats > 1 && <> <span className="chip" title={`Qualified in ${r.repeats} weeks`}>×{r.repeats}</span></>}
                          {r.basis === "intraweek" && <> <span className="chip auto" title="Only the week's high or low reached the move; it faded by Friday">INTRAWEEK</span></>}
                          {t && <> <a className="chip etf" href={`#/trade/${encodeURIComponent(t.id)}`} title="You had a trade on it that week">TRADED</a></>}
                        </td>
                        <td className={`num b ${r.chg > 0 ? "gain" : r.chg < 0 ? "loss" : ""}`}>{signed(r.chg)}</td>
                        <td className="num ph-hide gain">{signed(r.hi)}</td>
                        <td className="num ph-hide loss">{signed(r.lo)}</td>
                        <td className="num ph-hide muted">{usd(r.start)} → {usd(r.end)}</td>
                        <td className="num">{dollars(r.dv5)}</td>
                        <td className="num ph-hide muted">{dollars(r.dv30)}</td>
                        <td className="num ph-hide muted">{r.adr.toFixed(1)}%</td>
                        <td className="mover-note-cell">
                          {note ? (
                            <button type="button" className="linklike mover-note" title={`${note}

Click to edit`} onClick={() => setEditing(editing === k ? null : k)}>{note}</button>
                          ) : (
                            <button type="button" className="btn ghost tiny" aria-label={`Add a note on ${r.ticker}`} onClick={() => setEditing(editing === k ? null : k)}>+ NOTE</button>
                          )}
                        </td>
                      </tr>
                      {editing === k && (
                        <tr className="mover-note-row">
                          <td colSpan={10}>
                            <NoteEditor k={k} initial={note} onClose={() => setEditing(null)} />
                          </td>
                        </tr>
                      )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {rows.length > shown && (
              <div className="empty">
                <button type="button" className="btn" onClick={() => setShown(shown + PAGE * 2)}>SHOW MORE ({rows.length - shown} LEFT)</button>
              </div>
            )}
          </>
        )}
      </section>

      {chartRows && !__TJ_DEMO__ && (
        <section className="panel" aria-label={`Daily chart of ${charted}`}>
          <div className="panel-head">
            <h2>Chart · {charted}</h2>
            <span className="dim small">TRADINGVIEW · DAILY · MOVES: {chartRows.map((r) => `WEEK OF ${r.week}`).join(" · ")}</span>
          </div>
          <TradingViewChart symbol={charted} range={chartRange(chartRows.at(-1)!.week, etDate(new Date().toISOString()))} interval="D" height={460} />
          <div className="dim small chart-foot">A stock that has since delisted or changed ticker may not load here.</div>
        </section>
      )}
    </main>
  );
}
