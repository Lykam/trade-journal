// Add chart screenshots from Trade detail (Q78): paste (Ctrl+V anywhere on the
// page), drop or pick one or more images, choose each one's 1m / 5m / daily and
// date, preview the file name, then commit them to Playbook together. Playbook's
// notify-journal redeploys the site, and each image joins the gallery like any
// other Playbook chart.
import { useEffect, useRef, useState } from "react";
import { UPLOAD_KINDS, UPLOAD_TYPES, UploadError, uploadPath, type UploadKind } from "../../core/reviews/images";
import { DEMO_COMMIT_NOTE } from "../demo-text";
import { commitCharts, type ChartUpload as Upload } from "../../core/reviews/upload";
import { GitHubClient } from "../../core/github/client";
import { ACTIONS_URL, PLAYBOOK_REPO, useToken, watchDeploy } from "../github";

interface Item {
  id: number;
  blob: Blob;
  type: string;
  url: string;
  bytes: Uint8Array;
  kind: UploadKind;
  date: string;
  symbol: string;
}

type Phase =
  | { kind: "idle" }
  | { kind: "committing" }
  | { kind: "error"; message: string }
  | { kind: "done"; paths: string[]; url: string };

const KIND_LABEL: Record<UploadKind, string> = { "1m": "1M", "5m": "5M", daily: "DAILY" };

/** Every image among pasted, dropped or picked items. */
function imagesOf(files: FileList | File[] | null | undefined): File[] {
  return [...(files ?? [])].filter((f) => f.type.startsWith("image/"));
}

/**
 * Two or more boxes can be on screen at once (the journal form's Daily and
 * Intraday charts): a bare "paste anywhere" would land the same image in every
 * one of them. With only one box mounted, paste-anywhere still works exactly
 * as before (Q78); with more than one, a paste goes only to whichever box
 * currently holds DOM focus (clicked into, or a control inside it, e.g.
 * CHOOSE FILE) — the browser guarantees only one element can hold focus at a
 * time, so unlike tracking "last clicked" in a shared variable, this can't
 * drift: there's nothing to go stale.
 */
const mounted = new Set<symbol>();
const onMountChange = new Set<() => void>();
const notifyMountChange = () => onMountChange.forEach((f) => f());

let nextId = 1;

export function ChartUpload({ dates, defaultDate, symbols, defaultKind, existing, deferred, onPicked }: {
  dates: string[];
  defaultDate: string;
  symbols: string[];
  defaultKind: UploadKind;
  /** Playbook image paths in the current data, for the name preview. */
  existing: string[];
  /**
   * The journal form's charts aren't committed on their own: they're held here and
   * handed to the caller (via onPicked) so the whole review — text and charts — commits
   * together on one SAVE. No own commit button, so there's nothing to forget to click.
   * Deferred boxes hold at most one image at a time (one daily, one intraday).
   */
  deferred?: boolean;
  onPicked?: (upload: Upload | null) => void;
}) {
  const [items, setItems] = useState<Item[]>([]);
  const [drag, setDrag] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const busy = phase.kind === "committing";
  const id = useRef(Symbol());
  const box = useRef<HTMLDivElement>(null);
  const [, rerender] = useState(0);

  const take = async (files: File[]) => {
    const images = imagesOf(files);
    if (!images.length || busy) return;
    const bad = images.find((f) => !UPLOAD_TYPES[f.type]);
    if (bad) return setPhase({ kind: "error", message: `Not an image this app stores (${bad.type || "unknown type"}). Use PNG, JPEG, GIF, WebP or BMP.` });
    const made = await Promise.all(images.map(async (f): Promise<Item> => ({
      id: nextId++, blob: f, type: f.type, url: URL.createObjectURL(f), bytes: new Uint8Array(await f.arrayBuffer()),
      kind: defaultKind, date: defaultDate, symbol: symbols[0]!,
    })));
    setItems((prev) => {
      // A deferred box (one daily, one intraday) holds a single image; the old preview's URL goes.
      if (deferred) {
        prev.forEach((p) => URL.revokeObjectURL(p.url));
        return [made.at(-1)!];
      }
      return [...prev, ...made];
    });
    setPhase({ kind: "idle" });
  };

  useEffect(() => {
    if (!deferred) return;
    const it = items[0];
    onPicked?.(it ? { date: it.date, symbol: it.symbol, kind: it.kind, type: it.type, bytes: it.bytes } : null);
  }, [deferred, items]);

  // Register with every other box currently on screen, so paste can tell whether it's alone.
  useEffect(() => {
    mounted.add(id.current);
    notifyMountChange();
    const onChange = () => rerender((n) => n + 1);
    onMountChange.add(onChange);
    return () => {
      mounted.delete(id.current);
      onMountChange.delete(onChange);
      notifyMountChange();
    };
  }, []);
  const solo = mounted.size <= 1;

  // Ctrl+V anywhere on Trade detail, straight after Win+Shift+S (Q78) — unless
  // another box is also on screen, where a paste only lands in the box that
  // currently holds focus. Text pastes are left alone.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const images = imagesOf(e.clipboardData?.files);
      if (!images.length) return;
      if (!solo && !box.current?.contains(document.activeElement)) return;
      e.preventDefault();
      take(images);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  });
  // Every still-picked item's blob URL goes on leaving (removing/clearing/replacing
  // revoke their own URL immediately, so this only ever sees what's left at unmount).
  const itemsRef = useRef(items);
  itemsRef.current = items;
  useEffect(() => () => itemsRef.current.forEach((it) => URL.revokeObjectURL(it.url)), []);

  const update = (itemId: number, patch: Partial<Pick<Item, "kind" | "date" | "symbol">>) =>
    setItems((prev) => prev.map((it) => (it.id === itemId ? { ...it, ...patch } : it)));
  const remove = (itemId: number) => {
    setItems((prev) => {
      const gone = prev.find((it) => it.id === itemId);
      if (gone) URL.revokeObjectURL(gone.url);
      return prev.filter((it) => it.id !== itemId);
    });
    setPhase({ kind: "idle" });
  };
  const clear = () => {
    items.forEach((it) => URL.revokeObjectURL(it.url));
    setItems([]);
    setPhase({ kind: "idle" });
  };

  const previewOf = (it: Item) => {
    try {
      return uploadPath(existing, it.date, it.symbol, it.kind, UPLOAD_TYPES[it.type]!);
    } catch (e) {
      return (e as Error).message;
    }
  };

  return (
    <div
      ref={box}
      tabIndex={-1}
      className={`chart-upload ${drag ? "drag" : ""}`}
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => { e.preventDefault(); setDrag(false); take([...e.dataTransfer.files]); }}
    >
      {items.length === 0 ? (
        <div className="row">
          <span className="label small">ADD CHART</span>
          <span className="muted small">{solo ? "Paste a screenshot (Ctrl+V), drop one or more images here, or" : "Click here, then paste a screenshot (Ctrl+V), drop one or more images here, or"}</span>
          <label className="btn">
            CHOOSE FILE
            <input
              type="file"
              accept={Object.keys(UPLOAD_TYPES).join(",")}
              multiple={!deferred}
              hidden
              onChange={(e) => { take([...(e.target.files ?? [])]); e.target.value = ""; }}
            />
          </label>
        </div>
      ) : (
        <fieldset className="plain upload-form" disabled={busy}>
          {items.map((it, i) => (
            <div key={it.id} className="upload-item">
              <img className="upload-preview" src={it.url} alt="Chart to upload" />
              <div className="upload-fields">
                {items.length > 1 && <span className="dim small">Chart {i + 1} of {items.length}</span>}
                <div className="seg" role="group" aria-label="Timeframe">
                  {UPLOAD_KINDS.map((k) => (
                    <button type="button" key={k} aria-pressed={it.kind === k} onClick={() => update(it.id, { kind: k })}>{KIND_LABEL[k]}</button>
                  ))}
                </div>
                <div className="row">
                  <select className="input" aria-label="Chart date" value={it.date} onChange={(e) => update(it.id, { date: e.target.value })}>
                    {dates.map((d) => <option key={d} value={d}>{d}{d === defaultDate ? " (idea)" : ""}</option>)}
                  </select>
                  {symbols.length > 1 && (
                    <select className="input" aria-label="Chart symbol" value={it.symbol} onChange={(e) => update(it.id, { symbol: e.target.value })}>
                      {symbols.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                  )}
                </div>
                <div className="muted small">
                  {deferred ? <>Saves as <code>{previewOf(it)}</code> with the review, on SAVE REVIEW below</> : <>Saves as <code>{previewOf(it)}</code> in {PLAYBOOK_REPO.repo}</>}
                </div>
                <div className="row">
                  <button type="button" className="btn ghost small" onClick={() => remove(it.id)}>REMOVE</button>
                </div>
              </div>
            </div>
          ))}
          <div className="row">
            {deferred ? null : __TJ_DEMO__ ? (
              <>
                <button type="button" className="btn primary" disabled>COMMIT…</button>
                <span className="note-line">{DEMO_COMMIT_NOTE}</span>
              </>
            ) : (
              <CommitButton
                busy={busy}
                count={items.length}
                upload={async () => items.map((it) => ({ date: it.date, symbol: it.symbol, kind: it.kind, type: it.type, bytes: it.bytes }))}
                onPhase={(next) => {
                  if (next.kind === "done") { items.forEach((it) => URL.revokeObjectURL(it.url)); setItems([]); }
                  setPhase(next);
                }}
              />
            )}
            {!deferred && <button type="button" className="btn" onClick={clear}>DISCARD {items.length > 1 ? "ALL" : ""}</button>}
          </div>
        </fieldset>
      )}
      {phase.kind === "error" && <div className="loss small" role="alert">{phase.message}</div>}
      {phase.kind === "done" && (
        <div className="row" role="status">
          <span className="gain small">COMMITTED {phase.paths.length > 1 ? `${phase.paths.length} CHARTS` : <code>{phase.paths[0]}</code>} · <a href={phase.url} target="_blank" rel="noopener noreferrer">VIEW COMMIT ↗</a></span>
          <span className="dim small">It shows here after the redeploy.</span>
          <button type="button" className="btn ghost" onClick={() => setPhase({ kind: "idle" })}>OK</button>
        </div>
      )}
    </div>
  );
}

/** Real build only: the demo build never renders it, so it has no token or GitHub code (Q50). */
function CommitButton({ busy, count, upload, onPhase }: { busy: boolean; count: number; upload: () => Promise<Upload[]>; onPhase: (p: Phase) => void }) {
  const token = useToken();
  if (token.status !== "ok") {
    return <span className="dim small">{token.status === "loading" ? "…" : <>To commit, add a GitHub token in <a href="#/settings">SETTINGS</a>.</>}</span>;
  }
  const commit = async () => {
    onPhase({ kind: "committing" });
    try {
      const out = await commitCharts(new GitHubClient(token.record.token), PLAYBOOK_REPO, await upload());
      watchDeploy({ label: count > 1 ? `${count} charts committed` : "Chart committed", want: { date: out.date }, link: `${ACTIONS_URL}/workflows/deploy.yml`, commitUrl: out.url });
      onPhase({ kind: "done", paths: out.paths, url: out.url });
    } catch (e) {
      const err = e as Error;
      onPhase({ kind: "error", message: e instanceof UploadError || err.name === "GitHubError" ? err.message : `Upload failed: ${err.message}` });
    }
  };
  return <button type="button" className="btn primary" onClick={commit}>{busy ? "COMMITTING…" : `COMMIT ${count > 1 ? `${count} CHARTS` : ""} TO ${PLAYBOOK_REPO.repo.toUpperCase()}`}</button>;
}
