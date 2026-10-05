// Import (SPEC §4.5A, §6.8): drop Schwab / Webull CSVs, parse them in the browser
// with the same core as `npm run import`, preview against trade-history read
// fresh through the GitHub API, map new ETF symbols, then write one commit.
// Errors block the commit.
import { useEffect, useMemo, useRef, useState } from "react";
import { gitBlobSha } from "../../core/history/files";
import { exportOrder, previewLines, type ImportInput } from "../../core/import/plan";
import { detectBroker } from "../../core/normalize";
import type { DataBundle, SymbolInfo, SymbolsMap } from "../../core/types";
import type { TokenRecord } from "../../core/github/token-store";
import { sampleCsvs } from "../../demo/samples";
import { appNow } from "../data";
import { DEMO_COMMIT_NOTE, DEMO_IMPORT_NOTE } from "../demo-text";
import { ACTIONS_URL, clientFor, feedsSite, useToken, watchDeploy, type TokenState } from "../github";
import type { ImportCommit, RemoteHistory } from "../remote";
import { etfBadge, money, pnlClass } from "../format";

/** Demo build (Q50): the demo history stands in for trade-history; there is no token and no commit. */
const DEMO_TOKEN: TokenState = { status: "ok", record: { repo: "demo/trade-history" } as TokenRecord };

function demoRemote(data: DataBundle): RemoteHistory {
  return {
    state: { repo: { owner: "demo", repo: "trade-history" }, branch: "main", headSha: "demo000", treeSha: "", files: new Map() },
    snap: { config: data.config, symbols: data.symbols, overrides: data.overrides, fills: data.fills, derived: data.derived },
    archived: { paths: new Set(), blobShas: new Set() },
  };
}

/** Demo build: the sample exports, as files to pick and as downloads. */
function DemoSamples({ onPick }: { onPick: (files: File[]) => void }) {
  const files = useMemo(() => sampleCsvs(appNow()).map((s) => new File([s.text], s.name, { type: "text/csv", lastModified: Date.now() })), []);
  const urls = useMemo(() => files.map((f) => URL.createObjectURL(f)), [files]);
  useEffect(() => () => urls.forEach((u) => URL.revokeObjectURL(u)), [urls]);
  return (
    <div className="row">
      <button type="button" className="btn" onClick={() => onPick(files)}>TRY THE SAMPLES</button>
      {files.map((f, i) => (
        <a key={f.name} href={urls[i]} download={f.name} className="small">DOWNLOAD {f.name.startsWith("Webull") ? "WEBULL" : "SCHWAB"} SAMPLE ↓</a>
      ))}
    </div>
  );
}

type Remote = typeof import("../remote");

interface Picked extends ImportInput {
  broker: string | null;
  lastModified: number;
}

interface MapRow {
  on: boolean;
  /** The broker's name for the symbol (kept: a mapped symbol leaves unmappedEtfs). */
  name: string;
  underlying: string;
  leverage: string;
  direction: SymbolInfo["direction"];
  issuer: string;
}

const MAX_BYTES = 20 * 1024 * 1024;

async function readFiles(list: FileList | File[]): Promise<Picked[]> {
  const out: Picked[] = [];
  for (const f of [...list]) {
    if (f.size > MAX_BYTES) throw new Error(`${f.name} is larger than 20 MB; is it a broker export?`);
    const bytes = new Uint8Array(await f.arrayBuffer());
    const head = new TextDecoder().decode(bytes.slice(0, 4096));
    out.push({ name: f.name, bytes, broker: detectBroker(head), lastModified: f.lastModified });
  }
  // A file dialog's order is arbitrary, so sort oldest export first by name (Q18: the first-seen symbol is kept).
  return exportOrder(out);
}

export function ImportPage({ data }: { data: DataBundle }) {
  // A compile-time constant, so the hook order never changes at runtime.
  const token = __TJ_DEMO__ ? DEMO_TOKEN : useToken();
  const [files, setFiles] = useState<Picked[]>([]);
  const [drag, setDrag] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [remoteMod, setRemoteMod] = useState<Remote | null>(null);
  const [remote, setRemote] = useState<RemoteHistory | null>(null);
  const [reading, setReading] = useState(false);
  const [maps, setMaps] = useState<Record<string, MapRow>>({});
  // Set when files are picked (not when the page opens), so each import gets its own time; the preview and the commit share it.
  const [importedAt, setImportedAt] = useState(() => new Date().toISOString().replace(/\.\d{3}Z$/, "Z"));
  const [status, setStatus] = useState<{ kind: "idle" | "committing" | "done"; url?: string; notice?: string }>({ kind: "idle" });
  const input = useRef<HTMLInputElement>(null);

  const record = token.status === "ok" ? token.record : null;

  // Read trade-history fresh whenever new files are picked.
  useEffect(() => {
    if (!record || !files.length) return;
    let live = true;
    setReading(true);
    setError(null);
    (async () => {
      const mod = await import("../remote");
      const r = __TJ_DEMO__ ? demoRemote(data) : await mod.read(clientFor(record).gh, clientFor(record).repo);
      if (!live) return;
      setRemoteMod(mod);
      setRemote(r);
    })()
      .catch((e) => live && setError((e as Error).message))
      .finally(() => live && setReading(false));
    return () => {
      live = false;
    };
  }, [record, files, data]);

  const mappings: SymbolsMap = useMemo(() => {
    const out: SymbolsMap = {};
    for (const [sym, m] of Object.entries(maps)) {
      const lev = Number(m.leverage);
      if (!m.on || !/^[A-Z0-9.^-]{1,15}$/.test(m.underlying) || !(lev > 0)) continue;
      out[sym] = { underlying: m.underlying, type: "leveraged_etf", leverage: lev, direction: m.direction, ...(m.issuer.trim() ? { issuer: m.issuer.trim() } : {}) };
    }
    return out;
  }, [maps]);

  const computed: ImportCommit | { error: string } | null = useMemo(() => {
    if (!remoteMod || !remote || !files.length) return null;
    try {
      return remoteMod.computeImport(remote, files, importedAt, mappings);
    } catch (e) {
      return { error: (e as Error).message };
    }
  }, [remoteMod, remote, files, importedAt, mappings]);

  /** Files whose content differs from main: what the commit will write. */
  const writes = useMemo(
    () =>
      computed && !("error" in computed) && computed.files && remote
        ? computed.files.filter((f) => remote.state.files.get(f.path)?.sha !== gitBlobSha(f.content)).map((f) => f.path)
        : [],
    [computed, remote],
  );

  // Pre-fill each new ETF row from the name-based guess (SPEC §3.4).
  useEffect(() => {
    if (!computed || "error" in computed) return;
    const add: Record<string, MapRow> = {};
    for (const e of computed.plan.result.unmappedEtfs) {
      if (maps[e.symbol]) continue;
      // The guess is pre-filled but never mapped until the row is checked.
      add[e.symbol] = { on: false, name: e.name, underlying: e.guess.underlying ?? "", leverage: String(e.guess.leverage), direction: e.guess.direction, issuer: e.guess.issuer ?? "" };
    }
    if (Object.keys(add).length) setMaps((m) => ({ ...add, ...m }));
  }, [computed, maps]);

  const pick = async (list: FileList | File[] | null) => {
    if (!list || !list.length) return;
    setStatus({ kind: "idle" });
    try {
      const picked = await readFiles(list);
      setImportedAt(new Date().toISOString().replace(/\.\d{3}Z$/, "Z"));
      setFiles(picked);
      setMaps({});
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const move = (i: number, d: -1 | 1) => {
    const next = [...files];
    [next[i], next[i + d]] = [next[i + d]!, next[i]!];
    setStatus({ kind: "idle" });
    setFiles(next);
  };

  if (token.status === "loading") return <main className="page import"><div className="center-msg">LOADING…</div></main>;
  if (!record) {
    return (
      <main className="page import">
        <header className="page-head"><h1>IMPORT</h1></header>
        <div className="panel empty">
          Importing writes to trade-history through the GitHub API. Add a GitHub token in <a href="#/settings">SETTINGS</a> first.
          {token.status === "unreadable" && <div className="half">The saved token can't be opened with this passphrase; save it again.</div>}
        </div>
      </main>
    );
  }

  const plan = computed && !("error" in computed) ? computed.plan : null;
  // The demo has no commit at all (and no GitHub code in its build).
  const commit = __TJ_DEMO__ ? undefined : async () => {
    if (!computed || "error" in computed || !remote || !remoteMod) return;
    setStatus({ kind: "committing" });
    try {
      const { gh } = clientFor(record);
      const out = await remoteMod.commitImport(gh, remote, computed, files, importedAt, mappings);
      setStatus({ kind: "done", url: out.commit?.url });
      if (out.commit) {
        const site = feedsSite(record);
        watchDeploy({
          label: "Import committed",
          want: site ? { sha: out.commit.sha, date: out.commit.date } : { date: out.commit.date },
          link: `${ACTIONS_URL}/workflows/deploy.yml`,
          commitUrl: out.commit.url,
          note: site ? undefined : `Committed to ${record.repo}, which the site doesn't read; the reload shows the same data.`,
        });
      }
    } catch (e) {
      const err = e as Error & { remote?: RemoteHistory };
      if (err.name === "PreviewChangedError" && err.remote) {
        setRemote(err.remote);
        setStatus({ kind: "idle", notice: err.message });
      } else {
        setStatus({ kind: "idle" });
        setError(err.message);
      }
    }
  };

  const blocked = !plan || plan.errors.length > 0 || !computed || "error" in computed;
  return (
    <main className="page import">
      <header className="page-head">
        <h1>IMPORT <span className="sub">/ INTO {record.repo.toUpperCase()}</span></h1>
      </header>
      {__TJ_DEMO__ && (
        <section className="panel" aria-label="Demo">
          <div className="body">
            <p className="muted">{DEMO_IMPORT_NOTE}</p>
            <DemoSamples onPick={(f) => void pick(f)} />
          </div>
        </section>
      )}

      <section
        className={`panel dropzone ${drag ? "drag" : ""}`}
        aria-label="CSV files"
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); void pick(e.dataTransfer.files); }}
      >
        <p title="Webull_Orders_Records*.csv or Trading_*_Transactions_*.csv; ordered by the numbers and dates in their names">
          Drop Webull or Schwab CSV exports here. The oldest is applied first; reorder with ↑ ↓.
        </p>
        <input ref={input} type="file" accept=".csv,text/csv" multiple hidden onChange={(e) => { void pick(e.target.files); e.target.value = ""; }} />
        <button type="button" className="btn primary" onClick={() => input.current?.click()}>CHOOSE FILES</button>
        {files.length > 0 && (
          <ol className="files">
            {files.map((f, i) => (
              <li key={f.name}>
                <span className="dim">{i + 1}.</span>{" "}
                <button type="button" className="btn ghost tiny" disabled={i === 0} aria-label={`Move ${f.name} earlier`} onClick={() => move(i, -1)}>↑</button>
                <button type="button" className="btn ghost tiny" disabled={i === files.length - 1} aria-label={`Move ${f.name} later`} onClick={() => move(i, 1)}>↓</button>{" "}
                <code>{f.name}</code> <span className={f.broker ? "muted" : "loss"}>{f.broker ? f.broker.toUpperCase() : "UNRECOGNIZED HEADER"}</span>{" "}
                <span className="dim">{(f.bytes.length / 1024).toFixed(1)} KB</span>
              </li>
            ))}
          </ol>
        )}
      </section>

      {error && <div className="panel"><div className="body loss">{error}</div></div>}
      {reading && <div className="panel empty">READING {record.repo.toUpperCase()} (fills, overrides, config, symbols)…</div>}
      {computed && "error" in computed && <div className="panel"><div className="body loss">{computed.error}</div></div>}
      {status.notice && <div className="panel"><div className="body half">{status.notice}</div></div>}

      {plan && computed && !("error" in computed) && remote && (
        <>
          <section className="panel" aria-label="Preview">
            <div className="panel-head">
              <h2>Preview</h2>
            </div>
            <div className="body">
              {/* Zero counts stay out of the way, except errors, which always say 0 (#13 row 99). */}
              <div className="counts">
                <span><b className={plan.result.added.length ? "gain" : ""}>+{plan.result.added.length}</b> NEW FILLS</span>
                {plan.diff.added.length > 0 && <span><b>{plan.diff.added.length}</b> NEW TRADE{plan.diff.added.length === 1 ? "" : "S"}</span>}
                {plan.diff.changed.length > 0 && <span><b>{plan.diff.changed.length}</b> CHANGED</span>}
                {plan.diff.removed.length > 0 && <span><b>{plan.diff.removed.length}</b> REMOVED</span>}
                {plan.duplicates > 0 && <span><b>{plan.duplicates}</b> DUPLICATE{plan.duplicates === 1 ? "" : "S"}</span>}
                {plan.skipped > 0 && <span><b>{plan.skipped}</b> ROW{plan.skipped === 1 ? "" : "S"} SKIPPED</span>}
                <span><b className={plan.errors.length ? "loss" : ""}>{plan.errors.length}</b> ERROR{plan.errors.length === 1 ? "" : "S"}</span>
              </div>
              {plan.errors.map((e) => <div key={e} className="loss small">ERROR {e}</div>)}
              {plan.warnings.map((w) => <div key={w} className="half small">WARN {w}</div>)}
              <div className="scroll-x">
                <table className="grid dense">
                  <thead><tr><th>FILE</th><th>BROKER</th><th>ACCOUNT</th><th className="num">ROWS</th><th className="num">FILLS</th><th className="num">NEW</th><th className="num">DUPLICATE</th><th>SKIPPED</th><th className="num">ERRORS</th></tr></thead>
                  <tbody>
                    {plan.result.files.map((f) => (
                      <tr key={f.source}>
                        <td><code>{f.source}</code></td><td>{f.broker ?? "?"}</td><td>{f.account ?? "?"}</td>
                        <td className="num">{f.rows}</td><td className="num">{f.parsed}</td><td className="num">{f.added}</td><td className="num">{f.duplicates}</td>
                        <td className="muted">{Object.entries(f.skipped).map(([k, v]) => `${k} ${v}`).join(", ") || "—"}</td>
                        <td className={`num ${f.errors.length ? "loss" : ""}`}>{f.errors.length}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </section>

          {plan.renames.size > 0 && (
            <section className="panel" aria-label="Ticker changes">
              <div className="panel-head"><h2>Ticker changes · {plan.renames.size}</h2></div>
              <div className="body">
                <p className="muted small">Webull now reports these fills under a new symbol; the original symbol is kept (Q18).</p>
                {[...plan.renames].map(([k, n]) => <div key={k}><code>{k}</code> <span className="dim">({n} fills)</span></div>)}
              </div>
            </section>
          )}

          {Object.keys(maps).length > 0 && (
            <section className="panel" aria-label="ETF symbols to map">
              <div className="panel-head"><h2>New ETF symbols · {Object.keys(maps).length}</h2></div>
              <div className="body">
                <p className="muted small" title="Ticked rows are written to symbols.json in this commit; unticked ones stay unmapped">Guessed from the fund name. Tick to save it, so its trades count toward the underlying.</p>
                <div className="scroll-x">
                  <table className="grid dense">
                    <thead><tr><th>MAP</th><th>SYMBOL</th><th>NAME</th><th>UNDERLYING</th><th>LEVERAGE</th><th>DIRECTION</th><th>ISSUER</th></tr></thead>
                    <tbody>
                      {Object.entries(maps).map(([sym, m]) => {
                        const set = (patch: Partial<MapRow>) => setMaps((all) => ({ ...all, [sym]: { ...m, ...patch } }));
                        return (
                          <tr key={sym}>
                            <td><input type="checkbox" checked={m.on} onChange={(e) => set({ on: e.target.checked })} aria-label={`Map ${sym}`} /></td>
                            <td><b>{sym}</b></td>
                            <td className="muted small">{m.name}</td>
                            <td><input className="input narrow" value={m.underlying} onChange={(e) => set({ underlying: e.target.value.toUpperCase() })} aria-label={`${sym} underlying`} /></td>
                            <td><input className="input tiny" inputMode="decimal" value={m.leverage} onChange={(e) => set({ leverage: e.target.value })} aria-label={`${sym} leverage`} /></td>
                            <td>
                              <select className="input" value={m.direction} onChange={(e) => set({ direction: e.target.value as MapRow["direction"] })} aria-label={`${sym} direction`}>
                                <option value="long">long</option>
                                <option value="inverse">inverse</option>
                              </select>
                            </td>
                            <td><input className="input narrow" value={m.issuer} onChange={(e) => set({ issuer: e.target.value })} aria-label={`${sym} issuer`} /></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </section>
          )}

          <section className="panel" aria-label="New or changed trades">
            <div className="panel-head"><h2>New or changed trades · {plan.diff.added.length + plan.diff.changed.length}</h2></div>
            <div className="scroll-x">
              <table className="grid dense">
                <thead><tr><th>OPENED</th><th>CLOSED</th><th>BROKER</th><th>STYLE</th><th>SYMBOL</th><th>STATUS</th><th className="num">MAX SHARES</th><th className="num">NET</th><th>RESULT</th><th></th></tr></thead>
                <tbody>
                  {[...plan.diff.added, ...plan.diff.changed].slice(-100).map((t) => (
                    <tr key={t.id}>
                      <td>{t.openedAt.slice(0, 10)}</td>
                      <td className="muted">{t.closedAt?.slice(0, 10) ?? "—"}</td>
                      <td>{t.broker}</td>
                      <td>{t.style}</td>
                      <td><b>{t.symbol}</b>{t.instrument === "leveraged_etf" ? <span className="dim"> {etfBadge(t)}</span> : null}</td>
                      <td className={t.status === "unmatched" ? "loss" : t.status === "open" ? "accent" : "muted"}>{t.status === "open" ? `open ${t.openQty}` : t.status === "unmatched" ? `UNMATCHED −${t.unmatchedQty}` : "closed"}</td>
                      <td className="num">{t.maxPosition}</td>
                      <td className={`num ${pnlClass(t.netPnl)}`}>{money(t.netPnl)}</td>
                      <td className="muted">{t.result ?? ""}</td>
                      <td className="dim small">{plan.diff.added.includes(t) ? "NEW" : "CHANGED"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {plan.diff.added.length + plan.diff.changed.length === 0 && <div className="empty">No trades change.</div>}
          </section>

          <section className="panel" aria-label="Commit">
            <div className="panel-head"><h2>Commit</h2></div>
            <div className="body">
              {computed.files && (writes.length ? (
                <details className="writes">
                  <summary className="muted small">Writes {writes.length} file{writes.length === 1 ? "" : "s"} ▸</summary>
                  <div className="muted small">{writes.join(", ")}</div>
                </details>
              ) : <div className="muted small">Writes nothing (all unchanged)</div>)}
              <div className="muted small">Message: <code>{computed.message}</code></div>
              <div className="row">
                <button type="button" className="btn primary" disabled={__TJ_DEMO__ || blocked || status.kind !== "idle" || writes.length === 0} onClick={commit}>
                  {status.kind === "committing" ? "COMMITTING…" : `COMMIT TO ${record.repo.toUpperCase()}`}
                </button>
                {__TJ_DEMO__ && <span className="note-line">{DEMO_COMMIT_NOTE}</span>}
                {plan.errors.length > 0 && <span className="loss small">Errors block the commit. Fix the files and drop them again.</span>}
                {status.kind === "done" && (
                  <span className="gain small">COMMITTED{status.url ? <> · <a href={status.url} target="_blank" rel="noopener noreferrer">VIEW COMMIT ↗</a></> : " (nothing changed)"}</span>
                )}
              </div>
            </div>
          </section>

          <details className="panel">
            <summary className="panel-head" title="The same text as npm run import -- --dry-run, with the commit it was computed against">
              <h2>Full dry-run report ▸</h2><span className="dim small">main @ <code>{remote.state.headSha.slice(0, 7)}</code></span>
            </summary>

            <pre className="json report">{remoteMod ? previewText(plan, record.repo) : ""}</pre>
          </details>
        </>
      )}
    </main>
  );
}

function previewText(plan: ImportCommit["plan"], repo: string): string {
  return previewLines(plan, { title: "IMPORT PREVIEW (nothing written until you commit)", target: repo }).join("\n");
}
