// Global filter bar (SPEC §6.0). All state lives in the URL hash, so every view
// can be bookmarked; each control just navigates to the updated URL.
import { useEffect, useId, useState } from "react";
import {
  activeFilterCount, dateRange, emptyFilter, PRESET_LABELS, PRESET_SHORT, PRESETS, queryOf, viewToParams, type Flag, type TradeFilter, type ViewState,
} from "../../core/journal/filter";
import type { Journal } from "../../core/journal/journal";
import type { TradeResult } from "../../core/types";

const FLAG_LABEL: Record<Flag, string> = {
  overnight: "Day trades held overnight", unmatched: "Unmatched sells", open: "Open positions", excluded: "Excluded trades",
};

/** The URL for a view on a page, with extra page-specific params (e.g. the calendar month). */
export function viewHref(base: string, v: ViewState, extra?: Record<string, string>): string {
  const p = viewToParams(v);
  for (const [k, val] of Object.entries(extra ?? {})) p.set(k, val);
  return `${base}${queryOf(p)}`;
}

interface SegOption<T> {
  value: T;
  label: string;
}

function Seg<T extends string | null>({ label, value, options, onChange }: { label: string; value: T; options: SegOption<T>[]; onChange: (v: T) => void }) {
  return (
    <div className="fgroup">
      <span className="flabel">{label}</span>
      <div className="seg" role="group" aria-label={label}>
        {options.map((o) => (
          <button key={String(o.value)} type="button" aria-pressed={value === o.value} onClick={() => onChange(o.value)}>{o.label}</button>
        ))}
      </div>
    </div>
  );
}

const RESULTS: Array<{ value: TradeResult; label: string; cls: string }> = [
  { value: "win", label: "WIN", cls: "gain" },
  { value: "loss", label: "LOSS", cls: "loss" },
  { value: "breakeven", label: "BREAKEVEN", cls: "flat" },
];

export function FilterBar({
  view, journal, base, extra, count = true, dates = true, pnl = true, controls, hrefFor, title = "FILTERS",
}: {
  view: ViewState;
  journal: Journal;
  base: string;
  extra?: Record<string, string>;
  /** Show the Count by Trade / Idea toggle. */
  count?: boolean;
  /** Show the date controls (the calendar picks its dates with month arrows instead). */
  dates?: boolean;
  /** Show the Gross / Net toggle. */
  pnl?: boolean;
  /** Page-specific toggles beside Gross / Net and Count. */
  controls?: React.ReactNode;
  /** Where a change navigates; defaults to `base` with the view and `extra`. */
  hrefFor?: (v: ViewState) => string;
  title?: string;
}) {
  const uid = useId();
  const f = view.filter;
  const [open, setOpen] = useState(() => typeof window === "undefined" || window.matchMedia("(min-width: 760px)").matches);
  const [symbol, setSymbol] = useState(f.symbols.join(", "));
  const symbolsKey = f.symbols.join(", ");
  useEffect(() => {
    setSymbol(symbolsKey);
  }, [symbolsKey]);

  const go = (next: Partial<ViewState>) => {
    const v = { ...view, ...next, page: 1 };
    window.location.hash = hrefFor ? hrefFor(v) : viewHref(base, v, extra);
  };
  const set = (patch: Partial<TradeFilter>) => go({ filter: { ...f, ...patch } });
  const commitSymbol = () => {
    const symbols = symbol.split(/[\s,]+/).map((s) => s.trim().toUpperCase()).filter(Boolean);
    if (symbols.join(",") !== f.symbols.join(",")) set({ symbols });
  };
  const active = activeFilterCount(dates ? f : { ...f, preset: null, from: null, to: null });
  const range = dateRange(f, journal.today, journal.startsOn);
  const toggleTag = (tag: string) => set({ tags: f.tags.includes(tag) ? f.tags.filter((t) => t !== tag) : [...f.tags, tag] });
  const toggleResult = (r: TradeResult) => set({ results: f.results.includes(r) ? f.results.filter((x) => x !== r) : [...f.results, r] });

  return (
    <section className="panel filterbar" aria-label="Filters">
      <div className="fhead">
        <button type="button" className="btn ghost" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? "▾" : "▸"} {title}{active ? <span className="accent">&nbsp;· {active} ACTIVE</span> : null}
        </button>
        {active > 0 && <button type="button" className="btn ghost" onClick={() => go({ filter: emptyFilter() })}>CLEAR</button>}
        <span className="grow" />
        {pnl && <Seg label="P&L" value={view.pnl} options={[{ value: "net", label: "NET" }, { value: "gross", label: "GROSS" }]} onChange={(p) => go({ pnl: p })} />}
        {count && (
          <Seg label="COUNT BY" value={view.count} options={[{ value: "trade", label: "TRADE" }, { value: "idea", label: "IDEA" }]} onChange={(c) => go({ count: c })} />
        )}
        {controls}
      </div>
      {f.flag && (
        <div className="fflag">
          <span className="chip accent">FLAG</span> {FLAG_LABEL[f.flag]}
          <button type="button" className="btn ghost small" onClick={() => set({ flag: null })} aria-label="Remove flag filter">✕</button>
        </div>
      )}
      {open && (
        <div className="fbody">
          <div className="fgroup">
            <label className="flabel" htmlFor={`${uid}-symbol`}>SYMBOL</label>
            <input
              id={`${uid}-symbol`} className="input sym-input" value={symbol} placeholder="TICKER, …" spellCheck={false} autoCapitalize="characters"
              onChange={(e) => setSymbol(e.target.value)} onBlur={commitSymbol}
              onKeyDown={(e) => e.key === "Enter" && commitSymbol()}
            />
          </div>
          {dates && <div className="fgroup">
            <span className="flabel">DATE</span>
            <div className="seg wrap" role="group" aria-label="Date presets">
              <button type="button" aria-pressed={!f.preset && !f.from && !f.to} onClick={() => set({ preset: null, from: null, to: null })}>ALL</button>
              {PRESETS.map((p) => (
                <button key={p} type="button" aria-pressed={f.preset === p} onClick={() => set({ preset: p, from: null, to: null })}>
                  <span className="ph-hide">{PRESET_LABELS[p]}</span><span className="ph-only-inline">{PRESET_SHORT[p]}</span>
                </button>
              ))}
            </div>
            <span className="dates">
              <input type="date" className="input" aria-label="From" value={range.from ?? ""} onChange={(e) => set({ preset: null, from: e.target.value || null, to: range.to })} />
              <span className="muted">–</span>
              <input type="date" className="input" aria-label="To" value={range.to ?? ""} onChange={(e) => set({ preset: null, from: range.from, to: e.target.value || null })} />
            </span>
          </div>}
          <Seg label="STYLE" value={f.style} options={[{ value: null, label: "ALL" }, { value: "day", label: "DAY" }, { value: "swing", label: "SWING" }]} onChange={(style) => set({ style })} />
          <Seg label="INSTRUMENT" value={f.instrument} options={[{ value: null, label: "ALL" }, { value: "stock", label: "STOCK" }, { value: "leveraged_etf", label: "ETF" }]} onChange={(instrument) => set({ instrument })} />
          <Seg label="BROKER" value={f.broker} options={[{ value: null, label: "ALL" }, { value: "schwab", label: "SCHWAB" }, { value: "webull", label: "WEBULL" }]} onChange={(broker) => set({ broker })} />
          <Seg label="DURATION" value={f.duration} options={[{ value: null, label: "ALL" }, { value: "intraday", label: "INTRADAY" }, { value: "multiday", label: "MULTI-DAY" }]} onChange={(duration) => set({ duration })} />
          <div className="fgroup">
            <span className="flabel">RESULT</span>
            <div className="seg" role="group" aria-label="Result">
              {RESULTS.map((r) => (
                <button key={r.value} type="button" aria-pressed={f.results.includes(r.value)} onClick={() => toggleResult(r.value)}>
                  <span className={f.results.includes(r.value) ? "" : r.cls}>{r.label}</span>
                </button>
              ))}
            </div>
          </div>
          <Seg label="REVIEWED" value={f.review}
 options={[{ value: null, label: "ALL" }, { value: "yes", label: "YES" }, { value: "no", label: "NO" }]} onChange={(review) => set({ review })} />
          <div className="fgroup">
            <span className="flabel">TAGS</span>
            <details className="dropdown">
              <summary className="btn">{f.tags.length ? f.tags.join(", ") : "ANY"} ▾</summary>
              <div className="menu" role="group" aria-label="Tags">
                {journal.allTags.length === 0 && <div className="muted">No tags yet</div>}
                {journal.allTags.map((t) => (
                  <label key={t} className="check">
                    <input type="checkbox" checked={f.tags.includes(t)} onChange={() => toggleTag(t)} /> {t}
                  </label>
                ))}
              </div>
            </details>
            {f.tags.length > 1 && (
              <div className="seg" role="group" aria-label="Tag match">
                <button type="button" aria-pressed={f.tagMode === "any"} onClick={() => set({ tagMode: "any" })}>ANY</button>
                <button type="button" aria-pressed={f.tagMode === "all"} onClick={() => set({ tagMode: "all" })}>ALL</button>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

