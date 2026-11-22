// Plays (SPEC §6.7e, Q84): the owner's playbook of setups. Each play is one
// markdown file in Playbook's Plays/ folder with a name, markets, timeframes,
// entry tactics and a long write-up with images, plus dated updates appended
// one at a time. The file is the play: nothing is generated later.
//
// The same page serves routines (Q88), in Routines/, with when, tools and steps
// in place of markets, timeframes and entry tactics, under a PLAYS | ROUTINES
// switch; and the LIBRARY tab (Q87): other traders' plays and routines, in
// Library/ and Library/Routines/, each credited to them with its source. Each
// of the four reads its wording from a KindUi (UI below).
//
// Everything that talks to GitHub lives in PlaySave, which the demo build
// never renders, so the demo bundle carries no token or GitHub code (Q50).
import { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ClipboardEvent, type DragEvent } from "react";
import { etDate } from "../../core/normalize/util";
import {
  cleanList, creditCounts, filterPlays, isTheirs, marketCounts, sourceParts, parseCommaList, pendingIds, pendingToken, playPath, readPlays, stripPending, updateTitle,
  checkHeader, LIBRARY, LIBRARY_ROUTINES, PLAYS, ROUTINES, type Play, type PlayHeader, type PlayKind, type PlaySection, type PlayWho,
} from "../../core/plays/plays";
import type { PlayChange, PlayCommit } from "../../core/plays/commit";
import { UPLOAD_TYPES } from "../../core/reviews/images";
import type { DataBundle, ReviewFile } from "../../core/types";
import { LazyReview } from "../components/LazyReview";
import { appNow, copyText, registerLocalImage } from "../data";
import { DEMO_COMMIT_NOTE } from "../demo-text";
import { ACTIONS_URL, PLAYBOOK_REPO, useToken, watchDeploy } from "../github";

// ---------------------------------------------------------------------------
// Committed here but not in the deployed data yet: path → markdown, or null when removed.
// Module-level so it survives moving between the list and a play's page.

let pending = new Map<string, string | null>();
const subs = new Set<() => void>();
const setPending = (path: string, markdown: string | null) => {
  pending = new Map(pending).set(path, markdown);
  subs.forEach((f) => f());
};
const usePending = () => useSyncExternalStore((f) => (subs.add(f), () => void subs.delete(f)), () => pending, () => pending);

// ---------------------------------------------------------------------------
// Plays, library or routines: the wording and data for each

export interface KindUi {
  kind: PlayKind;
  /** The nav tab it's under, and which half of that tab's PLAYS | ROUTINES switch. */
  tab: "plays" | "library";
  show: "plays" | "routines";
  /** "PLAYS", "play", "Play". */
  title: string;
  noun: string;
  Noun: string;
  intro: string;
  files: (data: DataBundle) => ReviewFile[] | undefined;
  name: string;
  /** The three header lists: markets / timeframes / entry tactics, or when / tools / steps. */
  a: { label: string; hint: string; placeholder: string };
  b: { label: string; hint: string; placeholder: string };
  list: { label: string; one: string; placeholder: string };
  writeup: string;
  theirsWriteup: string;
  update: string;
}

export const UI: Record<PlayKind["id"], KindUi> = {
  plays: {
    kind: PLAYS,
    tab: "plays",
    show: "plays",
    title: "PLAYS",
    noun: "play",
    Noun: "Play",
    intro: "Your setups: where they work, on what timeframes, how you get in. Other traders' plays go in LIBRARY.",
    files: (d) => d.playbook?.plays,
    name: "Gap and Go",
    a: { label: "MARKETS", hint: "where it works, comma-separated", placeholder: "US small caps, premarket gappers" },
    b: { label: "TIMEFRAMES", hint: "comma-separated", placeholder: "1m, 5m" },
    list: { label: "ENTRY TACTICS", one: "entry tactic", placeholder: "Break of the premarket high on volume" },
    writeup: "The long write-up: what the setup is, why it works, what to look for, when to skip it…",
    theirsWriteup: "",
    update: "What you've learned since: refinements, new examples, when it failed…",
  },
  library: {
    kind: LIBRARY,
    tab: "library",
    show: "plays",
    title: "LIBRARY",
    noun: "play",
    Noun: "Play",
    intro: "Plays learned from other traders, credited to each with where you found it (a video, a book), to study and come back to. Your own plays are in PLAYS.",
    files: (d) => d.playbook?.library,
    name: "Opening range breakout",
    a: { label: "MARKETS", hint: "where it works, comma-separated", placeholder: "US small caps, premarket gappers" },
    b: { label: "TIMEFRAMES", hint: "comma-separated", placeholder: "1m, 5m" },
    list: { label: "ENTRY TACTICS", one: "entry tactic", placeholder: "Break of the opening range high on volume" },
    writeup: "",
    theirsWriteup: "The play as they teach it: the setup, why it works, their entries and exits, what they watch for…",
    update: "More from them, or what you've found trying it: new examples, refinements, when it failed…",
  },
  routines: {
    kind: ROUTINES,
    tab: "plays",
    show: "routines",
    title: "PLAYS",
    noun: "routine",
    Noun: "Routine",
    intro: "Your prep routines: when you do it, what you use, the steps in order. Other traders' routines are in LIBRARY.",
    files: (d) => d.playbook?.routines,
    name: "Weekend prep",
    a: { label: "WHEN", hint: "comma-separated", placeholder: "Weekend, Sunday night" },
    b: { label: "TOOLS", hint: "comma-separated", placeholder: "TradingView, Finviz" },
    list: { label: "STEPS", one: "step", placeholder: "Mark the weekly levels on SPY and QQQ" },
    writeup: "The routine in full: why each step, what you're looking for, how long it takes…",
    theirsWriteup: "",
    update: "What's changed: steps added or dropped, what's working…",
  },
  "library-routines": {
    kind: LIBRARY_ROUTINES,
    tab: "library",
    show: "routines",
    title: "LIBRARY",
    noun: "routine",
    Noun: "Routine",
    intro: "Other traders' routines (weekend prep, premarket…), credited to each with where you found it. Your own routines are under PLAYS.",
    files: (d) => d.playbook?.libraryRoutines,
    name: "Weekend prep",
    a: { label: "WHEN", hint: "comma-separated", placeholder: "Weekend, Sunday night" },
    b: { label: "TOOLS", hint: "comma-separated", placeholder: "TradingView, Finviz" },
    list: { label: "STEPS", one: "step", placeholder: "Mark the weekly levels on SPY and QQQ" },
    writeup: "",
    theirsWriteup: "The routine as they do it: each step, what they look for, why it matters to them…",
    update: "More from them, or what you've found trying it…",
  },
};

const KindContext = createContext<KindUi>(UI.plays);
const useKind = () => useContext(KindContext);

function usePlays(data: DataBundle, k: KindUi): Play[] {
  const p = usePending();
  return useMemo(() => {
    const deployed = k.files(data) ?? [];
    // This folder only: Library/x.md, not Library/Routines/x.md.
    const mine = [...p].filter(([path]) => path.startsWith(k.kind.dir) && !path.slice(k.kind.dir.length).includes("/"));
    const files = deployed.filter((f) => !p.has(f.path)).concat(mine.flatMap(([path, markdown]) => (markdown === null ? [] : [{ path, markdown }])));
    return readPlays(files, k.kind);
  }, [data, p, k]);
}

export const playLink = (slug: string, kind: PlayKind = PLAYS) => `#/${kind.id}/${encodeURIComponent(slug)}`;
const uiOf = (kind: PlayKind) => UI[kind.id];
/** A tab's list, on its PLAYS or ROUTINES half ("#/library?show=routines&by=Jane"). */
export const listLink = (kind: PlayKind, by?: string | null) => {
  const k = uiOf(kind);
  const q = new URLSearchParams();
  if (k.show === "routines") q.set("show", "routines");
  if (by) q.set("by", by);
  const qs = q.toString();
  return `#/${k.tab}${qs ? `?${qs}` : ""}`;
};

// ---------------------------------------------------------------------------
// List

/** `by`: the LIBRARY's person filter, kept in the URL so it carries across PLAYS | ROUTINES. */
export function PlaysPage({ data, kind = "plays", by = null }: { data: DataBundle; kind?: PlayKind["id"]; by?: string | null }) {
  const k = UI[kind];
  return <KindContext.Provider value={k}><PlayList data={data} by={by} /></KindContext.Provider>;
}

function PlayList({ data, by }: { data: DataBundle; by: string | null }) {
  const k = useKind();
  const plays = usePlays(data, k);
  const p = usePending();
  const [q, setQ] = useState("");
  const [market, setMarket] = useState<string | null>(null);
  const [who, setWhoRaw] = useState<PlayWho>(by ? `by:${by}` : "all");
  const [adding, setAdding] = useState(false);
  const credit = k.kind.credit;
  const person = who.startsWith("by:") ? who.slice(3) : null;
  const setWho = (w: PlayWho) => {
    setWhoRaw(w);
    window.history.replaceState(window.history.state, "", listLink(k.kind, w.startsWith("by:") ? w.slice(3) : null));
  };
  const halves = (["plays", "routines"] as const).map((show) => UI[(Object.keys(UI) as PlayKind["id"][]).find((id) => UI[id].tab === k.tab && UI[id].show === show)!]);
  const markets = useMemo(() => marketCounts(plays), [plays]);
  const credits = useMemo(() => creditCounts(plays), [plays]);
  const rows = useMemo(() => filterPlays(plays, q, market, who), [plays, q, market, who]);
  const filtered = Boolean(q.trim() || market || who !== "all");
  const noPlaybook = data.playbook === null;
  const theirs = plays.filter((x) => isTheirs(x.header)).length;
  const whoPill = (w: PlayWho, label: string, n: number) => (
    <button key={w} type="button" className="pill" aria-pressed={who === w} onClick={() => setWho(who === w && w !== "all" ? "all" : w)}>
      {label} <span className="dim">{n}</span>
    </button>
  );

  return (
    <main className="page">
      <header className="page-head">
        <h1>{k.title} <span className="sub">/ {filtered ? `${rows.length} OF ` : ""}{plays.length} {k.noun.toUpperCase()}{plays.length === 1 ? "" : "S"}</span></h1>
        {!adding && <button type="button" className="btn primary" onClick={() => setAdding(true)}>+ {credit === "always" ? "ADD" : "NEW"} {k.noun.toUpperCase()}</button>}
      </header>
      <div className="seg" role="group" aria-label={`${k.title}: plays or routines`}>
        {halves.map((h) => (
          <a key={h.show} className="segl" href={listLink(h.kind, person)} aria-current={h === k ? "true" : undefined}>
            {h.show.toUpperCase()} <span className="dim">{(h.files(data) ?? []).length}</span>
          </a>
        ))}
      </div>
      <div className="dim small">{k.intro} Each one is a markdown file in {PLAYBOOK_REPO.repo}/{k.kind.dir.replace(/\/$/, "")}.</div>

      {adding && (
        <section className="panel play-form-panel" aria-label={`New ${k.noun}`}>
          <div className="panel-head"><h2>{credit === "always" ? `Another trader's ${k.noun}` : `New ${k.noun}`}</h2></div>
          <div className="play-edit">
            <NewPlayForm data={data} plays={plays} onClose={() => setAdding(false)} />
          </div>
        </section>
      )}

      {plays.length > 0 && (
        <section className="panel quotes-filter plays-filter" aria-label={`Filter ${k.noun}s`}>
          <div className="row">
            <input type="search" className="input quotes-search" placeholder={`Search ${k.noun}s…`} value={q} onChange={(e) => setQ(e.target.value)} aria-label={`Search ${k.noun}s`} />
            {filtered && <button type="button" className="btn ghost tiny" onClick={() => { setQ(""); setMarket(null); setWho("all"); }}>CLEAR</button>}
          </div>
          {theirs > 0 && credit !== "never" && (
            <div className="pillgroup" role="group" aria-label={`Whose ${k.noun}s`}>
              {credits.map((c) => whoPill(`by:${c.credit}`, `BY ${c.credit}`, c.n))}
            </div>
          )}
          {markets.length > 0 && (
            <div className="pillgroup" role="group" aria-label={k.a.label}>
              {markets.map((m) => (
                <button key={m.market} type="button" className="pill" aria-pressed={market?.toLowerCase() === m.market.toLowerCase()} onClick={() => setMarket(market?.toLowerCase() === m.market.toLowerCase() ? null : m.market)}>
                  {m.market} <span className="dim">{m.n}</span>
                </button>
              ))}
            </div>
          )}
        </section>
      )}

      <section className="panel">
        {plays.length === 0 ? (
          <div className="empty">
            {noPlaybook ? <>No Playbook checkout, so no {k.noun}s to show. </> : <>No {k.noun}s yet. </>}
            <b>+ NEW {k.noun.toUpperCase()}</b> writes one to <code>{k.kind.dir}</code> in {PLAYBOOK_REPO.repo}.
          </div>
        ) : rows.length === 0 ? (
          <div className="empty">No {k.noun} matches.</div>
        ) : (
          <div className="scroll-x">
            <table className="grid">
              <thead>
                <tr><th>{k.noun.toUpperCase()}</th><th>{k.a.label}</th><th>{k.b.label}</th><th className="num ph-hide">{k.list.label.split(" ").pop()}</th><th className="num ph-hide">UPDATES</th><th>UPDATED</th></tr>
              </thead>
              <tbody>
                {rows.map((x) => (
                  <tr key={x.path} className="clickable" onClick={() => (window.location.hash = playLink(x.slug, k.kind))}>
                    <td>
                      <a className="sym" href={playLink(x.slug, k.kind)}>{x.header.name}</a>
                      {isTheirs(x.header) && <> <span className="chip credit" title={x.header.source ? `Source: ${x.header.source}` : `Someone else's ${k.noun}`}>BY {x.header.credit}</span></>}
                      {p.has(x.path) && <> <span className="chip accent" title="Committed; it shows here for good once the site redeploys">DEPLOYING</span></>}
                    </td>
                    <td className="muted wrap-cell">{x.header.markets.join(", ") || "—"}</td>
                    <td className="muted">{x.header.timeframes.join(" · ") || "—"}</td>
                    <td className="num ph-hide">{x.header.tactics.length}</td>
                    <td className="num ph-hide">{x.sections.filter((s) => s.kind === "update").length}</td>
                    <td className="muted">{x.updated ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}

// ---------------------------------------------------------------------------
// One play

type Mode = { kind: "view" } | { kind: "header" } | { kind: "append" } | { kind: "section"; index: number } | { kind: "remove" };

export function PlayPage({ data, slug, kind = "plays" }: { data: DataBundle; slug: string; kind?: PlayKind["id"] }) {
  return <KindContext.Provider value={UI[kind]}><PlayView data={data} slug={slug} /></KindContext.Provider>;
}

function PlayView({ data, slug }: { data: DataBundle; slug: string }) {
  const k = useKind();
  const plays = usePlays(data, k);
  const p = usePending();
  const play = plays.find((x) => x.slug === slug);
  const [mode, setMode] = useState<Mode>({ kind: "view" });
  const [copied, setCopied] = useState(false);
  const back = <a className="btn" href={listLink(k.kind)}>‹ {k.title}</a>;

  if (!play) {
    const removed = [...p].some(([path, md]) => md === null && path.toLowerCase() === `${k.kind.dir}${slug}.md`.toLowerCase());
    return (
      <main className="page">
        <header className="page-head"><h1>{k.noun.toUpperCase()} <span className="sub">/ {removed ? "REMOVED" : "NOT FOUND"}</span></h1>{back}</header>
        <div className="panel empty">{removed ? `This ${k.noun} was removed. It leaves the site with the next deploy.` : `No ${k.noun} with this name in Playbook.`}</div>
      </main>
    );
  }
  const { header: h } = play;
  const view = mode.kind === "view";
  const done = () => setMode({ kind: "view" });
  const copy = async () => {
    setCopied(await copyText(play.markdown));
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <main className="page">
      <header className="page-head">
        <h1>{h.name} {isTheirs(h) && <span className="chip credit">BY {h.credit}</span>} {p.has(play.path) && <span className="chip accent" title="Committed; it shows here for good once the site redeploys">DEPLOYING</span>}</h1>
        <nav className="row" aria-label={`${k.Noun} actions`}>
          {back}
          <button type="button" className="btn" disabled={!view} onClick={() => setMode({ kind: "header" })}>EDIT HEADER</button>
          <button type="button" className="btn primary" disabled={!view} onClick={() => setMode({ kind: "append" })}>+ ADD UPDATE</button>
        </nav>
      </header>

      <section className="panel" aria-label={`${k.Noun} header`}>
        {mode.kind === "header" ? (
          <div className="play-edit">
            <EditHeaderForm play={play} onClose={done} />
          </div>
        ) : (
          <dl className="play-header">
            {isTheirs(h) && (
              <>
                <dt>CREDIT</dt>
                <dd>{h.credit}</dd>
                <dt>SOURCE</dt>
                <dd className="wrap-cell">{h.source ? <SourceText source={h.source} /> : <span className="dim">—</span>}</dd>
              </>
            )}
            <dt>{k.a.label}</dt>
            <dd>{h.markets.length ? h.markets.map((m) => <span key={m} className="chip">{m}</span>) : <span className="dim">—</span>}</dd>
            <dt>{k.b.label}</dt>
            <dd>{h.timeframes.length ? h.timeframes.map((t) => <span key={t} className="chip">{t}</span>) : <span className="dim">—</span>}</dd>
            <dt>{k.list.label}</dt>
            <dd>{h.tactics.length ? (k.kind.ordered ? <ol className="play-tactics">{h.tactics.map((t) => <li key={t}>{t}</li>)}</ol> : <ul className="play-tactics">{h.tactics.map((t) => <li key={t}>{t}</li>)}</ul>) : <span className="dim">—</span>}</dd>
            <dt>CREATED</dt>
            <dd className="muted">{play.created ?? "—"}{play.updated && play.updated !== play.created ? ` · last update ${play.updated}` : ""}</dd>
          </dl>
        )}
      </section>

      {play.sections.map((s, i) => (
        <section key={`${i}-${s.title}`} className="panel" aria-label={s.title}>
          <div className="panel-head">
            <h2>{s.kind === "update" ? <>Update <span className="muted">· {s.date}</span>{s.label ? <> · {s.label}</> : null}</> : s.title}</h2>
            <span className="grow" />
            {view && <button type="button" className="btn ghost tiny" onClick={() => setMode({ kind: "section", index: i })}>EDIT</button>}
          </div>
          {mode.kind === "section" && mode.index === i ? (
            <div className="play-edit"><EditSectionForm play={play} index={i} section={s} onClose={done} /></div>
          ) : (
            <div className="md-wrap play-body"><LazyReview path={play.path} markdown={s.body} /></div>
          )}
        </section>
      ))}

      {mode.kind === "append" && (
        <section className="panel play-form-panel" aria-label="Add update">
          <div className="panel-head"><h2>New update</h2><span className="dim small">ADDED AT THE END, UNDER TODAY'S DATE</span></div>
          <div className="body"><AppendForm play={play} onClose={done} /></div>
        </section>
      )}

      <div className="row play-foot">
        <span className="dim small">Saved as <code>{play.path}</code> in {PLAYBOOK_REPO.repo}.</span>
        <button type="button" className="btn ghost tiny" onClick={() => void copy()}>{copied ? "COPIED" : "COPY MARKDOWN"}</button>
        <span className="spacer" />
        {mode.kind === "remove" ? (
          <RemoveConfirm play={play} onClose={done} />
        ) : (
          <button type="button" className="btn ghost tiny" disabled={!view} onClick={() => setMode({ kind: "remove" })}>REMOVE {k.noun.toUpperCase()}</button>
        )}
      </div>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Forms

const blankHeader: PlayHeader = { name: "", markets: [], timeframes: [], tactics: [] };

/** A source with its links clickable. */
export function SourceText({ source }: { source: string }) {
  return (
    <>
      {sourceParts(source).map((part, i) =>
        part.url ? <a key={i} href={part.text} target="_blank" rel="noopener noreferrer">{part.text}</a> : <span key={i}>{part.text}</span>,
      )}
    </>
  );
}

function NewPlayForm({ data, plays, onClose }: { data: DataBundle; plays: Play[]; onClose: () => void }) {
  const k = useKind();
  const [header, setHeader] = useState<PlayHeader>(k.kind.credit === "always" ? { ...blankHeader, credit: "", source: "" } : blankHeader);
  const [section, setSection] = useState<SectionDraft>(blankSection);
  const [busy, setBusy] = useState(false);
  const existing = useMemo(() => [...(k.files(data) ?? []).map((f) => f.path), ...plays.map((x) => x.path)], [data, plays, k]);
  const path = header.name.trim() ? playPath(existing, header.name, k.kind) : null;
  const error = checkHeader(header);
  const change: PlayChange | null = error ? null : { kind: "create", header, body: section.body, images: imagesOf(section) };
  return (
    <fieldset className="plain play-form" disabled={busy}>
      <HeaderFields value={header} onChange={setHeader} autoFocus />
      <SectionFields label="WRITE-UP" value={section} onChange={setSection}
        placeholder={header.credit !== undefined ? k.theirsWriteup : k.writeup} />
      <div className="muted small">{path ? <>Saves as <code>{path}</code>{section.images.length ? ` + ${section.images.length} image${section.images.length === 1 ? "" : "s"}` : ""} in {PLAYBOOK_REPO.repo}, in one commit.</> : `Name the ${k.noun} to see where it saves.`}</div>
      <SaveBar change={change} error={error} label={`SAVE ${k.noun.toUpperCase()}`} summary={path ? `Create ${path}` : ""} section={section} onBusy={setBusy} onClose={onClose}
        onDone={(out) => { window.location.hash = playLink(out.path.slice(k.kind.dir.length).replace(/\.md$/i, ""), k.kind); }} />
    </fieldset>
  );
}

function EditHeaderForm({ play, onClose }: { play: Play; onClose: () => void }) {
  const k = useKind();
  const [header, setHeader] = useState<PlayHeader>(k.kind.credit === "always" ? { ...play.header, credit: play.header.credit ?? "" } : play.header);
  const [busy, setBusy] = useState(false);
  const error = checkHeader(header);
  const change: PlayChange | null = error ? null : { kind: "header", path: play.path, header };
  return (
    <fieldset className="plain play-form" disabled={busy}>
      <HeaderFields value={header} onChange={setHeader} />
      <div className="dim small">The file keeps its name (<code>{play.path}</code>) when the {k.noun} is renamed, so image links don't break.</div>
      <SaveBar change={change} error={error} label="SAVE HEADER" summary={`Rewrite the header of ${play.path}; every section stays as it is`} onBusy={setBusy} onClose={onClose} />
    </fieldset>
  );
}

function AppendForm({ play, onClose }: { play: Play; onClose: () => void }) {
  const k = useKind();
  const [section, setSection] = useState<SectionDraft>(blankSection);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const title = updateTitle(etDate(appNow()), label);
  const error = section.body.trim() || section.images.length ? null : "Write something or add an image first.";
  const change: PlayChange | null = error ? null : { kind: "append", path: play.path, title, body: section.body, images: imagesOf(section) };
  return (
    <fieldset className="plain play-form" disabled={busy}>
      <label className="field"><span className="label small">TITLE <span className="dim">(optional)</span></span>
        <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="What this update is about" autoFocus />
      </label>
      <SectionFields label="UPDATE" value={section} onChange={setSection} placeholder={k.update} />
      <div className="muted small">Adds <code>## {title}</code> at the end of <code>{play.path}</code>{section.images.length ? ` with ${section.images.length} image${section.images.length === 1 ? "" : "s"}` : ""}.</div>
      <SaveBar change={change} error={error} label="SAVE UPDATE" summary={`Append “${title}” to ${play.path}`} section={section} onBusy={setBusy} onClose={onClose} />
    </fieldset>
  );
}

function EditSectionForm({ play, index, section: s, onClose }: { play: Play; index: number; section: PlaySection; onClose: () => void }) {
  const [section, setSection] = useState<SectionDraft>({ body: s.body, images: [] });
  const [busy, setBusy] = useState(false);
  const change: PlayChange = { kind: "section", path: play.path, index, title: s.title, body: section.body, images: imagesOf(section) };
  return (
    <fieldset className="plain play-form" disabled={busy}>
      <SectionFields label={s.title.toUpperCase()} value={section} onChange={setSection} autoFocus />
      <SaveBar change={change} error={null} label="SAVE SECTION" summary={`Replace “${s.title}” in ${play.path}`} section={section} onBusy={setBusy} onClose={onClose} />
    </fieldset>
  );
}

function RemoveConfirm({ play, onClose }: { play: Play; onClose: () => void }) {
  const k = useKind();
  const [, setBusy] = useState(false);
  return (
    <div className="play-remove" role="group" aria-label={`Remove ${k.noun}`}>
      <span className="loss small">Remove {play.header.name}? This deletes <code>{play.path}</code> and its images from {PLAYBOOK_REPO.repo} (still in the git history).</span>
      <SaveBar change={{ kind: "delete", path: play.path }} error={null} label="REMOVE" summary={`Delete ${play.path} and ${k.kind.imagesDir}${play.slug}/`} onBusy={setBusy} onClose={onClose}
        onDone={() => { window.location.hash = listLink(k.kind); }} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header fields

function HeaderFields({ value: h, onChange, autoFocus }: { value: PlayHeader; onChange: (h: PlayHeader) => void; autoFocus?: boolean }) {
  const k = useKind();
  return (
    <>
      {k.kind.credit === "always" && (
        <>
          <label className="field"><span className="label small">CREDIT <span className="dim">(whose {k.noun} it is)</span></span>
            <input className="input" value={h.credit ?? ""} onChange={(e) => onChange({ ...h, credit: e.target.value })} placeholder="The trader or channel it's from" maxLength={80} />
          </label>
          <label className="field"><span className="label small">SOURCE <span className="dim">(optional: a link, or a book, course or podcast)</span></span>
            <input className="input" value={h.source ?? ""} onChange={(e) => onChange({ ...h, source: e.target.value })} placeholder="https://www.youtube.com/watch?v=…" />
          </label>
        </>
      )}
      <label className="field"><span className="label small">NAME</span>
        <input className="input" value={h.name} onChange={(e) => onChange({ ...h, name: e.target.value })} placeholder={k.name} autoFocus={autoFocus} maxLength={80} />
      </label>
      <ListField {...k.a} values={h.markets} onChange={(markets) => onChange({ ...h, markets })} />
      <ListField {...k.b} values={h.timeframes} onChange={(timeframes) => onChange({ ...h, timeframes })} />
      <TacticsField values={h.tactics} onChange={(tactics) => onChange({ ...h, tactics })} />
    </>
  );
}

/** Free text, saved as a comma-separated list. The typed text is kept as is, so a trailing comma doesn't vanish mid-typing. */
function ListField({ label, hint, values, onChange, placeholder }: {
  label: string;
  hint?: string;
  values: string[];
  onChange: (v: string[]) => void;
  placeholder: string;
}) {
  const [text, setText] = useState(() => values.join(", "));
  return (
    <label className="field">
      <span className="label small">{label} {hint && <span className="dim">({hint})</span>}</span>
      <input className="input" value={text} placeholder={placeholder} onChange={(e) => { setText(e.target.value); onChange(parseCommaList(e.target.value)); }} />
    </label>
  );
}

function TacticsField({ values, onChange }: { values: string[]; onChange: (v: string[]) => void }) {
  const { list } = useKind();
  const [text, setText] = useState("");
  const add = () => {
    const t = text.replace(/\s+/g, " ").trim();
    if (t) onChange(cleanList([...values, t]));
    setText("");
  };
  return (
    <div className="field">
      <span className="label small">{list.label} <span className="dim">(one per line)</span></span>
      {values.length > 0 && (
        <ol className="tactics-edit">
          {values.map((t, i) => (
            <li key={i} className="row">
              <input className="input grow" value={t} aria-label={`${list.one} ${i + 1}`} onChange={(e) => onChange(values.map((x, j) => (j === i ? e.target.value.replace(/[\r\n]+/g, " ") : x)))} />
              <button type="button" className="btn ghost tiny" disabled={i === 0} onClick={() => onChange(values.map((x, j) => (j === i - 1 ? values[i]! : j === i ? values[i - 1]! : x)))} aria-label="Move up">↑</button>
              <button type="button" className="btn ghost tiny" onClick={() => onChange(values.filter((_, j) => j !== i))} aria-label={`Remove ${list.one} ${i + 1}`}>×</button>
            </li>
          ))}
        </ol>
      )}
      <div className="row">
        <input className="input grow" value={text} placeholder={list.placeholder} aria-label={`New ${list.one}`}
          onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }} />
        <button type="button" className="btn" onClick={add} disabled={!text.trim()}>+ ADD</button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Write-up / update text with images

interface PendingImage {
  id: number;
  type: string;
  bytes: Uint8Array;
  url: string;
}

interface SectionDraft {
  body: string;
  images: PendingImage[];
}

const blankSection: SectionDraft = { body: "", images: [] };
const imagesOf = (s: SectionDraft) => s.images.map(({ id, type, bytes }) => ({ id, type, bytes }));
let nextImageId = 1;
/** Blob URLs handed to registerLocalImage after a commit, which the form must not revoke. */
const keptUrls = new Set<string>();

function SectionFields({ label, value, onChange, placeholder, autoFocus }: {
  label: string;
  value: SectionDraft;
  onChange: (s: SectionDraft) => void;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const area = useRef<HTMLTextAreaElement>(null);
  const [drag, setDrag] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // Ids already used in this text (an earlier session's tokens never collide).
  useEffect(() => {
    const max = Math.max(0, ...pendingIds(value.body));
    if (max >= nextImageId) nextImageId = max + 1;
  }, []);
  const latest = useRef(value);
  latest.current = value;
  useEffect(() => () => latest.current.images.forEach((i) => keptUrls.has(i.url) || URL.revokeObjectURL(i.url)), []);

  const take = async (files: File[]) => {
    const imgs = files.filter((f) => f.type.startsWith("image/"));
    if (!imgs.length) return;
    const bad = imgs.find((f) => !UPLOAD_TYPES[f.type]);
    if (bad) return setProblem(`Not a supported image (${bad.type || "unknown type"}). Use PNG, JPEG, GIF, WebP or BMP.`);
    setProblem(null);
    const made = await Promise.all(imgs.map(async (f): Promise<PendingImage> => ({ id: nextImageId++, type: f.type, bytes: new Uint8Array(await f.arrayBuffer()), url: URL.createObjectURL(f) })));
    const cur = latest.current;
    const el = area.current;
    const at = el && document.activeElement === el ? el.selectionStart : cur.body.length;
    const before = cur.body.slice(0, at);
    const after = cur.body.slice(at);
    const tokens = made.map((m) => pendingToken(m.id)).join("\n\n");
    const lead = before && !before.endsWith("\n\n") ? (before.endsWith("\n") ? "\n" : "\n\n") : "";
    const trail = after && !after.startsWith("\n") ? "\n\n" : "\n";
    onChange({ body: `${before}${lead}${tokens}${trail}${after}`, images: [...cur.images, ...made] });
  };

  const onPaste = (e: ClipboardEvent) => {
    const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith("image/"));
    if (!files.length) return;
    e.preventDefault();
    void take(files);
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDrag(false);
    void take([...e.dataTransfer.files]);
  };
  const remove = (img: PendingImage) => {
    URL.revokeObjectURL(img.url);
    onChange({ body: stripPending(value.body, img.id), images: value.images.filter((i) => i.id !== img.id) });
  };

  return (
    <div className="field">
      <span className="label small">{label}</span>
      <div className={`play-text ${drag ? "drag" : ""}`} onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={onDrop}>
        <textarea
          ref={area}
          className="input"
          rows={12}
          value={value.body}
          onChange={(e) => onChange({ ...value, body: e.target.value })}
          onPaste={onPaste}
          placeholder={placeholder}
          autoFocus={autoFocus}
        />
        <div className="row">
          <span className="dim small">Markdown. Paste a screenshot (Ctrl+V) or drop an image to put it where the cursor is, or</span>
          <label className="btn tiny">
            CHOOSE IMAGE
            <input type="file" accept={Object.keys(UPLOAD_TYPES).join(",")} multiple hidden onChange={(e) => { void take([...(e.target.files ?? [])]); e.target.value = ""; }} />
          </label>
        </div>
      </div>
      {problem && <div className="loss small" role="alert">{problem}</div>}
      {value.images.length > 0 && (
        <div className="play-images">
          {value.images.map((img) => (
            <figure key={img.id} className="play-image">
              <img src={img.url} alt={`image ${img.id}`} />
              <figcaption className="row">
                <code className="small">image {img.id}</code>
                <span className="spacer" />
                <button type="button" className="btn ghost tiny" onClick={() => remove(img)} aria-label={`Remove image ${img.id}`}>REMOVE</button>
              </figcaption>
            </figure>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Saving

function SaveBar({ change, error, label, summary, section, onBusy, onClose, onDone }: {
  change: PlayChange | null;
  error: string | null;
  label: string;
  summary: string;
  /** The images being saved, to show them right away once committed. */
  section?: SectionDraft;
  onBusy: (busy: boolean) => void;
  onClose: () => void;
  onDone?: (out: PlayCommit) => void;
}) {
  if (__TJ_DEMO__) {
    return (
      <div className="row">
        <button type="button" className="btn primary" disabled>{label}…</button>
        <span className="note-line">{DEMO_COMMIT_NOTE}</span>
        <button type="button" className="btn ghost" onClick={onClose}>CANCEL</button>
      </div>
    );
  }
  return <PlaySave change={change} error={error} label={label} summary={summary} section={section} onBusy={onBusy} onClose={onClose} onDone={onDone} />;
}

type Phase = { kind: "edit"; error?: string } | { kind: "confirm" } | { kind: "committing" };

/** Confirm, then commit to Playbook (never rendered in the demo). */
function PlaySave({ change, error, label, summary, section, onBusy, onClose, onDone }: Parameters<typeof SaveBar>[0]) {
  const k = useKind();
  const token = useToken();
  const [phase, setPhaseRaw] = useState<Phase>({ kind: "edit" });
  const setPhase = (p: Phase) => {
    setPhaseRaw(p);
    onBusy(p.kind === "committing");
  };
  if (token.status !== "ok") {
    return (
      <div className="row">
        <span className="dim small">{token.status === "loading" ? "…" : <>To save, add a GitHub token in <a href="#/settings">SETTINGS</a>.</>}</span>
        <button type="button" className="btn ghost" onClick={onClose}>CANCEL</button>
      </div>
    );
  }
  if (token.record.playbook === false) {
    return (
      <div className="row">
        <span className="half small">The saved token can't write to {PLAYBOOK_REPO.repo}. Give it Contents: read and write there, then save it again in <a href="#/settings">SETTINGS</a>.</span>
        <button type="button" className="btn ghost" onClick={onClose}>CANCEL</button>
      </div>
    );
  }
  const record = token.record;

  const commit = async () => {
    if (!change) return;
    setPhase({ kind: "committing" });
    try {
      const [{ commitPlay }, { GitHubClient }] = await Promise.all([import("../../core/plays/commit"), import("../../core/github/client")]);
      const out = await commitPlay(new GitHubClient(record.token), PLAYBOOK_REPO, change, new Date(), 3, k.kind);
      // Show the new images at once; the deployed data won't have them until the redeploy.
      if (section) {
        const ids = new Map(section.images.map((i) => [i.id, i.url] as const));
        "images" in change && change.images.forEach((img, k) => {
          const url = ids.get(img.id);
          const path = out.imagePaths[k];
          if (url && path) {
            // The form unmounts next; this URL must outlive it.
            keptUrls.add(url);
            registerLocalImage(path, url);
          }
        });
      }
      setPending(out.path, out.markdown);
      watchDeploy({ label: change.kind === "delete" ? `${k.Noun} removed` : `${k.Noun} saved`, want: { date: out.date }, link: `${ACTIONS_URL}/workflows/deploy.yml`, commitUrl: out.url });
      onBusy(false);
      onClose();
      onDone?.(out);
    } catch (e) {
      setPhase({ kind: "edit", error: (e as Error).message });
    }
  };

  if (phase.kind === "committing") return <span className="accent small">COMMITTING…</span>;
  if (phase.kind === "confirm") {
    return (
      <div className="commit-review" role="group" aria-label="Commit preview">
        <div><span className="label small">COMMIT PREVIEW</span> to {PLAYBOOK_REPO.owner}/{PLAYBOOK_REPO.repo} main</div>
        <div className="muted">{summary}{change && "images" in change && change.images.length ? ` + ${change.images.length} image${change.images.length === 1 ? "" : "s"}` : ""}.</div>
        <div className="row">
          <button type="button" className="btn primary" onClick={() => void commit()}>CONFIRM COMMIT</button>
          <button type="button" className="btn" onClick={() => setPhase({ kind: "edit" })}>BACK</button>
        </div>
      </div>
    );
  }
  return (
    <>
      <div className="row">
        <button type="button" className={`btn ${change?.kind === "delete" ? "" : "primary"}`} onClick={() => (error || !change ? setPhase({ kind: "edit", error: error ?? "Nothing to save." }) : setPhase({ kind: "confirm" }))}>{label}…</button>
        <button type="button" className="btn ghost" onClick={onClose}>CANCEL</button>
      </div>
      {phase.error && <div className="loss small" role="alert">{phase.error}</div>}
    </>
  );
}
