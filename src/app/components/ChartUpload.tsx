// Add a chart screenshot from Trade detail (Q78): paste (Ctrl+V anywhere on the
// page), drop or pick an image, choose 1m / 5m / daily and the date, preview the
// file name, then commit it to Playbook. Playbook's notify-journal redeploys
// the site, and the image joins the gallery like any other Playbook chart.
import { useEffect, useRef, useState } from "react";
import { UPLOAD_KINDS, UPLOAD_TYPES, UploadError, uploadPath, type UploadKind } from "../../core/reviews/images";
import { DEMO_COMMIT_NOTE } from "../demo-text";
import { commitChart, type ChartUpload as Upload } from "../../core/reviews/upload";
import { GitHubClient } from "../../core/github/client";
import { ACTIONS_URL, PLAYBOOK_REPO, useToken, watchDeploy } from "../github";

interface Picked {
  blob: Blob;
  type: string;
  url: string;
}

type Phase =
  | { kind: "idle" }
  | { kind: "committing" }
  | { kind: "error"; message: string }
  | { kind: "done"; path: string; url: string };

const KIND_LABEL: Record<UploadKind, string> = { "1m": "1M", "5m": "5M", daily: "DAILY" };

/** The first image among pasted or dropped items, or null. */
function imageOf(files: FileList | null | undefined): File | null {
  return [...(files ?? [])].find((f) => f.type.startsWith("image/")) ?? null;
}

/**
 * Two or more boxes can be on screen at once (the journal form's Daily and
 * Intraday charts): a bare "paste anywhere" would land the same image in every
 * one of them. With only one box mounted, paste-anywhere still works exactly
 * as before (Q78); with more than one, a paste goes only to the box last
 * clicked into.
 */
const mounted = new Set<symbol>();
let focusedId: symbol | null = null;
const onMountChange = new Set<() => void>();
const notifyMountChange = () => onMountChange.forEach((f) => f());

export function ChartUpload({ dates, defaultDate, symbols, defaultKind, existing }: {
  dates: string[];
  defaultDate: string;
  symbols: string[];
  defaultKind: UploadKind;
  /** Playbook image paths in the current data, for the name preview. */
  existing: string[];
}) {
  const [picked, setPicked] = useState<Picked | null>(null);
  const [kind, setKind] = useState<UploadKind>(defaultKind);
  const [date, setDate] = useState(defaultDate);
  const [symbol, setSymbol] = useState(symbols[0]!);
  const [drag, setDrag] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const busy = phase.kind === "committing";
  const id = useRef(Symbol());
  const [, rerender] = useState(0);

  const take = (f: Blob | null) => {
    if (!f || busy) return;
    if (!UPLOAD_TYPES[f.type]) return setPhase({ kind: "error", message: `Not an image this app stores (${f.type || "unknown type"}). Use PNG, JPEG, GIF, WebP or BMP.` });
    setPicked({ blob: f, type: f.type, url: URL.createObjectURL(f) });
    setPhase({ kind: "idle" });
  };

  // Register with every other box currently on screen, so paste can tell whether it's alone.
  useEffect(() => {
    mounted.add(id.current);
    notifyMountChange();
    const onChange = () => rerender((n) => n + 1);
    onMountChange.add(onChange);
    return () => {
      mounted.delete(id.current);
      onMountChange.delete(onChange);
      if (focusedId === id.current) focusedId = null;
      notifyMountChange();
    };
  }, []);
  const solo = mounted.size <= 1;

  // Ctrl+V anywhere on Trade detail, straight after Win+Shift+S (Q78) — unless
  // another box is also on screen, where only the last-clicked box claims it.
  // Text pastes are left alone.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const f = imageOf(e.clipboardData?.files);
      if (!f) return;
      if (!solo && focusedId !== id.current) return;
      e.preventDefault();
      take(f);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  });
  // The old preview's blob URL goes when a new image replaces it, or on leaving.
  useEffect(() => () => void (picked && URL.revokeObjectURL(picked.url)), [picked]);

  const clear = () => {
    setPicked(null);
    setPhase({ kind: "idle" });
  };

  let preview: string;
  try {
    preview = picked ? uploadPath(existing, date, symbol, kind, UPLOAD_TYPES[picked.type]!) : "";
  } catch (e) {
    preview = (e as Error).message;
  }

  return (
    <div
      className={`chart-upload ${drag ? "drag" : ""}`}
      onMouseDown={() => { focusedId = id.current; }}
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => { e.preventDefault(); setDrag(false); take(imageOf(e.dataTransfer.files)); }}
    >
      {!picked ? (
        <div className="row">
          <span className="label small">ADD CHART</span>
          <span className="muted small">{solo ? "Paste a screenshot (Ctrl+V), drop an image here, or" : "Click here, then paste a screenshot (Ctrl+V), drop an image here, or"}</span>
          <label className="btn">
            CHOOSE FILE
            <input type="file" accept={Object.keys(UPLOAD_TYPES).join(",")} hidden onChange={(e) => { take(imageOf(e.target.files)); e.target.value = ""; }} />
          </label>
        </div>
      ) : (
        <fieldset className="plain upload-form" disabled={busy}>
          <img className="upload-preview" src={picked.url} alt="Chart to upload" />
          <div className="upload-fields">
            <div className="seg" role="group" aria-label="Timeframe">
              {UPLOAD_KINDS.map((k) => (
                <button type="button" key={k} aria-pressed={kind === k} onClick={() => setKind(k)}>{KIND_LABEL[k]}</button>
              ))}
            </div>
            <div className="row">
              <select className="input" aria-label="Chart date" value={date} onChange={(e) => setDate(e.target.value)}>
                {dates.map((d) => <option key={d} value={d}>{d}{d === defaultDate ? " (idea)" : ""}</option>)}
              </select>
              {symbols.length > 1 && (
                <select className="input" aria-label="Chart symbol" value={symbol} onChange={(e) => setSymbol(e.target.value)}>
                  {symbols.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              )}
            </div>
            <div className="muted small">Saves as <code>{preview}</code> in {PLAYBOOK_REPO.repo}</div>
            <div className="row">
              {__TJ_DEMO__ ? (
                <>
                  <button type="button" className="btn primary" disabled>COMMIT…</button>
                  <span className="note-line">{DEMO_COMMIT_NOTE}</span>
                </>
              ) : (
                <CommitButton
                  busy={busy}
                  upload={async () => ({ date, symbol, kind, type: picked.type, bytes: new Uint8Array(await picked.blob.arrayBuffer()) })}
                  onPhase={(next) => {
                    if (next.kind === "done") setPicked(null);
                    setPhase(next);
                  }}
                />
              )}
              <button type="button" className="btn" onClick={clear}>DISCARD</button>
            </div>
          </div>
        </fieldset>
      )}
      {phase.kind === "error" && <div className="loss small" role="alert">{phase.message}</div>}
      {phase.kind === "done" && (
        <div className="row" role="status">
          <span className="gain small">COMMITTED <code>{phase.path}</code> · <a href={phase.url} target="_blank" rel="noopener noreferrer">VIEW COMMIT ↗</a></span>
          <span className="dim small">It shows here after the redeploy.</span>
          <button type="button" className="btn ghost" onClick={() => setPhase({ kind: "idle" })}>OK</button>
        </div>
      )}
    </div>
  );
}

/** Real build only: the demo build never renders it, so it has no token or GitHub code (Q50). */
function CommitButton({ busy, upload, onPhase }: { busy: boolean; upload: () => Promise<Upload>; onPhase: (p: Phase) => void }) {
  const token = useToken();
  if (token.status !== "ok") {
    return <span className="dim small">{token.status === "loading" ? "…" : <>To commit, add a GitHub token in <a href="#/settings">SETTINGS</a>.</>}</span>;
  }
  const commit = async () => {
    onPhase({ kind: "committing" });
    try {
      const out = await commitChart(new GitHubClient(token.record.token), PLAYBOOK_REPO, await upload());
      watchDeploy({ label: "Chart committed", want: { date: out.date }, link: `${ACTIONS_URL}/workflows/deploy.yml`, commitUrl: out.url });
      onPhase({ kind: "done", path: out.path, url: out.url });
    } catch (e) {
      const err = e as Error;
      onPhase({ kind: "error", message: e instanceof UploadError || err.name === "GitHubError" ? err.message : `Upload failed: ${err.message}` });
    }
  };
  return <button type="button" className="btn primary" onClick={commit}>{busy ? "COMMITTING…" : `COMMIT TO ${PLAYBOOK_REPO.repo.toUpperCase()}`}</button>;
}
