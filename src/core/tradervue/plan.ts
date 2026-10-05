// One-time Tradervue import, start to finish, without I/O (SPEC §4.7): match
// the export's trades to the journal's, turn Tradervue's tags, style tag and
// notes into overrides.json entries (Tradervue wins), regroup, and list the
// files to write. Fills are never touched: a trades export has no executions,
// and the broker fills stay the source of truth for prices and quantities.
import { computeGauges, type Baseline } from "../gauge/gauge";
import { archiveWrites, derivedWrite, jsonText, schemaWrites, type FileWrite, type HistorySnapshot } from "../history/files";
import { diffTrades, money, pct, summaryTable, table, tradeRows } from "../import/report";
import { tidy } from "../journal/overrides";
import { AUTO_TAGS } from "../journal/tags";
import { cents, etDate } from "../normalize/util";
import type { SchemaTexts, Validate } from "../schema-names";
import { buildTrades } from "../trades";
import type { Idea, Overrides, Style, Trade, TradeOverride } from "../types";
import { matchTradervue, type TvMatchResult } from "./match";
import { parseTradervue, truncateNote, type TvParseResult, type TvTrade } from "./parse";

export interface TradervueOptions {
  importedAt: string;
  /** The Tradervue tag that marks a swing trade; a matched trade without it is a day trade. */
  styleTag?: string;
  /** Quick notes longer than this are cut at a word boundary. */
  noteMax?: number;
}

export const DEFAULT_STYLE_TAG = "Swing";
export const DEFAULT_NOTE_MAX = 500;

export interface Discrepancies {
  /** Gross P&L equal once rounded to the cent (Tradervue keeps more decimals). */
  rounding: number;
  /** Date-only trades whose P&L differs but whose day's total agrees: the same lots paired in another order. */
  pairedDifferently: TvPairRef[];
  pnlDiffers: TvPairRef[];
  execCount: TvPairRef[];
  /** Matched trades with more than one Tradervue copy, and how many of those copies disagree on tags. */
  duplicateTrades: number;
  duplicateRows: number;
  duplicateTagConflicts: number;
}

export interface TvPairRef {
  tv: TvTrade;
  trade: Trade;
}

export interface TradervuePlan {
  input: { name: string; bytes: Uint8Array };
  today: string;
  parse: TvParseResult;
  match: TvMatchResult;
  styleTag: string;
  noteMax: number;
  before: { trades: Trade[]; ideas: Idea[] };
  trades: Trade[];
  ideas: Idea[];
  overrides: Overrides;
  diff: ReturnType<typeof diffTrades>;
  /** Trades whose tags or note change (not in `diff`, which tracks status, P&L, style and idea). */
  annotated: number;
  styleChanges: Array<{ before: Trade; after: Trade }>;
  tagsAdded: Map<string, number>;
  tagsRemoved: Array<{ trade: Trade; tag: string }>;
  notes: { set: number; replaced: number; cut: Array<{ trade: Trade; from: number; to: number }> };
  ideasRegrouped: { before: Idea[]; after: Idea[] };
  discrepancies: Discrepancies;
  baselines: Record<Style, { before: Baseline; after: Baseline }>;
  errors: string[];
}

const lower = (s: string) => s.toLowerCase();

function unionTags(rows: TvTrade[]): string[] {
  const out: string[] = [];
  for (const t of rows.flatMap((r) => r.tags)) if (!out.some((x) => lower(x) === lower(t))) out.push(t);
  return out;
}

function discrepancies(m: TvMatchResult): Discrepancies {
  const primary = m.pairs.filter((p) => !p.duplicate);
  const d: Discrepancies = {
    rounding: 0, pairedDifferently: [], pnlDiffers: [], execCount: [],
    duplicateTrades: 0, duplicateRows: 0, duplicateTagConflicts: 0,
  };
  const groupKey = (t: Trade) => `${t.account}|${t.symbol}|${etDate(t.openedAt)}|${t.closedAt ? etDate(t.closedAt) : ""}`;
  const groups = new Map<string, { tv: number; journal: number }>();
  for (const p of primary) {
    const g = groups.get(groupKey(p.trade)) ?? { tv: 0, journal: 0 };
    g.tv += cents(p.tv.grossPnl);
    g.journal += p.trade.grossPnl;
    groups.set(groupKey(p.trade), g);
  }
  for (const p of primary) {
    if (p.tv.execCount !== p.trade.fillIds.length) d.execCount.push(p);
    if (p.tv.closedAt === null || p.trade.status !== "closed") continue; // P&L so far isn't comparable while open
    const diff = Math.abs(cents(p.tv.grossPnl) - p.trade.grossPnl);
    if (diff <= 0.011) {
      if (p.tv.grossPnl !== p.trade.grossPnl) d.rounding++;
    } else {
      const g = groups.get(groupKey(p.trade))!;
      const sameDay = p.tv.dateOnly && Math.abs(g.tv - g.journal) <= 0.011 * 2;
      (sameDay ? d.pairedDifferently : d.pnlDiffers).push(p);
    }
  }
  for (const rows of m.byTrade.values()) {
    if (rows.length < 2) continue;
    d.duplicateTrades++;
    d.duplicateRows += rows.length - 1;
    if (new Set(rows.map((r) => r.tags.map(lower).sort().join(","))).size > 1) d.duplicateTagConflicts++;
  }
  return d;
}

const ideaKey = (i: Idea) => `${i.id}:${i.style}:${i.tradeIds.join(",")}`;

export function planTradervue(
  input: { name: string; bytes: Uint8Array },
  snap: HistorySnapshot,
  opts: TradervueOptions,
): TradervuePlan {
  const styleTag = opts.styleTag ?? DEFAULT_STYLE_TAG;
  const noteMax = opts.noteMax ?? DEFAULT_NOTE_MAX;
  const parse = parseTradervue(new TextDecoder("utf-8").decode(input.bytes));
  const before = buildTrades(snap.fills, snap);
  const match = matchTradervue(parse.trades, before.trades, snap.fills);
  const byId = new Map(before.trades.map((t) => [t.id, t]));
  const auto = new Set<string>(AUTO_TAGS.map(lower));

  const entries: Record<string, TradeOverride> = { ...snap.overrides.trades };
  const tagsAdded = new Map<string, number>();
  const tagsRemoved: TradervuePlan["tagsRemoved"] = [];
  const notes: TradervuePlan["notes"] = { set: 0, replaced: 0, cut: [] };
  for (const [id, rows] of match.byTrade) {
    const t = byId.get(id)!;
    const tags = unionTags(rows);
    const manual = tags.filter((x) => !auto.has(lower(x)));
    const style: Style = tags.some((x) => lower(x) === lower(styleTag)) ? "swing" : "day";
    const full = [...new Set(rows.map((r) => r.note).filter(Boolean))].join(" · ");
    const note = truncateNote(full, noteMax);
    const cur = entries[id] ?? {};
    for (const x of manual) if (!t.tags.some((y) => lower(y) === lower(x))) tagsAdded.set(x, (tagsAdded.get(x) ?? 0) + 1);
    for (const x of t.tags) if (!manual.some((y) => lower(y) === lower(x))) tagsRemoved.push({ trade: t, tag: x });
    if (note) {
      if (!cur.note) notes.set++;
      else if (cur.note !== note) notes.replaced++;
      if (note !== full) notes.cut.push({ trade: t, from: full.length, to: note.length });
    }
    // Tradervue wins for tags and style; an existing journal note stays when Tradervue has none.
    const next = tidy({ ...cur, tags: manual, style, note: note || cur.note }, t, snap.config);
    if (next) entries[id] = next;
    else delete entries[id];
  }
  const overrides: Overrides = { trades: Object.fromEntries(Object.entries(entries).sort(([a], [b]) => a.localeCompare(b))), openingPositions: snap.overrides.openingPositions };
  const after = buildTrades(snap.fills, { ...snap, overrides });

  const annKey = (t: Trade) => JSON.stringify([t.tags, t.note ?? ""]);
  const prevAnn = new Map(before.trades.map((t) => [t.id, annKey(t)]));
  const styleChanges = after.trades.filter((t) => byId.get(t.id) && byId.get(t.id)!.style !== t.style).map((t) => ({ before: byId.get(t.id)!, after: t }));
  const beforeIdeas = new Set(before.ideas.map(ideaKey));
  const afterIdeas = new Set(after.ideas.map(ideaKey));

  const now = opts.importedAt;
  const gBefore = computeGauges({ trades: before.trades, config: snap.config, now });
  const gAfter = computeGauges({ trades: after.trades, config: snap.config, now });

  return {
    input,
    today: etDate(opts.importedAt),
    parse,
    match,
    styleTag,
    noteMax,
    before,
    trades: after.trades,
    ideas: after.ideas,
    overrides,
    diff: diffTrades(snap.derived, after.trades),
    annotated: after.trades.filter((t) => prevAnn.get(t.id) !== annKey(t)).length,
    styleChanges,
    tagsAdded,
    tagsRemoved,
    notes,
    ideasRegrouped: {
      before: before.ideas.filter((i) => !afterIdeas.has(ideaKey(i))),
      after: after.ideas.filter((i) => !beforeIdeas.has(ideaKey(i))),
    },
    discrepancies: discrepancies(match),
    baselines: {
      day: { before: gBefore.day.baseline, after: gAfter.day.baseline },
      swing: { before: gBefore.swing.baseline, after: gAfter.swing.baseline },
    },
    errors: parse.errors,
  };
}

const tvRow = (r: TvTrade) =>
  [`row ${r.row}`, r.symbol, r.openedAt.slice(0, r.dateOnly ? 10 : 19), "→", r.closedAt ? r.closedAt.slice(0, r.dateOnly ? 10 : 19) : "open",
    r.shares === null ? `${r.volume} vol` : `${r.shares} sh`, money(r.grossPnl), r.tags.join(",")];
const ideaRows = (ideas: Idea[]) =>
  table([["DATE", "UNDERLYING", "STYLE", "TRADES", "NET"], ...ideas.map((i) => [i.date, i.underlying, i.style, i.tradeIds.length, money(i.netPnl)])], ["l", "l", "l", "r", "r"]);
const baselineCell = (b: Baseline) => `${b.wins}/${b.losses}/${b.breakevens}  ${pct(b.winRate)}`;

/** The dry-run preview, in the order the import is reviewed. Local terminal only: it prints real trades. */
export function tradervuePreview(p: TradervuePlan, opts: { title: string; target: string; limit?: number }): string[] {
  const out: string[] = [];
  const limit = opts.limit ?? 40;
  const list = <T>(items: T[], rows: (xs: T[]) => string) =>
    items.length ? rows(items.slice(0, limit)) + (items.length > limit ? `\n  … ${items.length - limit} more (--limit N)` : "") : "  none";
  const { match: m, parse, discrepancies: d } = p;
  const tv = parse.trades;
  const tagCounts = new Map<string, number>();
  for (const t of tv.flatMap((r) => r.tags)) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);

  out.push(opts.title, `trade-history: ${opts.target}`, `export: ${p.input.name}\n`);
  out.push(`EXPORT: ${tv.length} trades (${tv.filter((r) => r.closedAt).length} closed, ${tv.filter((r) => !r.closedAt).length} open), ${tv.filter((r) => r.dateOnly).length} date-only, ${tv.filter((r) => !r.dateOnly).length} timed`);
  out.push(`  dates ${m.range ? `${m.range.from} → ${m.range.to}` : "—"} · ${new Set(tv.map((r) => r.symbol)).size} symbols · ${tv.filter((r) => r.note).length} notes`);
  out.push(`  tags: ${[...tagCounts].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(", ") || "none"}`);
  for (const [k, n] of Object.entries(parse.skipped)) out.push(`  skipped ${k}: ${n}`);
  for (const e of p.errors.slice(0, 20)) out.push(`  ERROR ${e}`);

  out.push("\nFILLS ADDED: 0 — a trades export has no executions; broker fills are not changed");

  const primary = m.pairs.filter((x) => !x.duplicate).length;
  out.push(`\nMATCHING: ${primary} journal trades matched by ${m.pairs.length} Tradervue rows (${d.duplicateRows} duplicate copies of ${d.duplicateTrades} trades)`);
  out.push(`  ticker changes (journal → Tradervue, matched by time): ${m.renames.size ? [...m.renames].map(([k, n]) => `${k} (${n})`).join(", ") : "none"}`);
  out.push(`\nUNMATCHED TRADERVUE TRADES (${m.unmatchedTv.length})`);
  out.push(list(m.unmatchedTv, (xs) => table(xs.map((x) => [...tvRow(x.tv), `[${x.reason}]`]))));
  out.push(`\nJOURNAL TRADES IN THE EXPORT'S DATES WITH NO TRADERVUE TRADE (${m.unmatchedJournal.length})`);
  out.push(list(m.unmatchedJournal.map((x) => x.trade), tradeRows));
  if (m.unmatchedJournal.length) {
    const reasons = [...new Set(m.unmatchedJournal.map((x) => x.reason))];
    out.push(`  by reason: ${reasons.map((r) => `${r} ${m.unmatchedJournal.filter((x) => x.reason === r).length}`).join(", ")}`);
  }
  out.push(`  journal trades after the export's last date (not expected in it): ${m.afterRange.length}`);

  out.push(`\nTRADES: ${p.diff.added.length} new, ${p.diff.changed.length} changed, ${p.diff.removed.length} removed (style / idea) · ${p.annotated} get new tags or a note · ${p.trades.length} trades in ${p.ideas.length} ideas (was ${p.before.ideas.length})`);

  out.push(`\nSTYLE CHANGES (${p.styleChanges.length}) — matched trade with Tradervue tag "${p.styleTag}" → swing, without → day`);
  out.push(list(p.styleChanges.map((x) => x.after), tradeRows));

  out.push(`\nIDEAS REGROUPED: ${p.ideasRegrouped.before.length} ideas replaced by ${p.ideasRegrouped.after.length}`);
  if (p.ideasRegrouped.before.length) out.push("  before:", list(p.ideasRegrouped.before, ideaRows), "  after:", list(p.ideasRegrouped.after, ideaRows));

  out.push(`\nTAGS ADDED (manual tags in overrides.json; "${p.styleTag}" and other automatic tags are not stored)`);
  out.push(p.tagsAdded.size ? [...p.tagsAdded].sort((a, b) => b[1] - a[1]).map(([k, n]) => `  ${k}: ${n} trades`).join("\n") : "  none");
  out.push(`\nJOURNAL TAGS THAT WOULD BE REMOVED (${p.tagsRemoved.length}) — decide before writing`);
  out.push(list(p.tagsRemoved, (xs) => table(xs.map((x) => [x.trade.symbol, etDate(x.trade.openedAt), x.trade.account, x.tag]))));

  out.push(`\nNOTES: ${p.notes.set} set, ${p.notes.replaced} replaced, ${p.notes.cut.length} cut to ${p.noteMax} characters`);
  if (p.notes.cut.length) out.push(table(p.notes.cut.map((x) => [x.trade.symbol, etDate(x.trade.openedAt), `${x.from} → ${x.to}`])));

  out.push("\nDISCREPANCIES (matched trades; broker fills are not changed)");
  out.push(`  gross P&L equal after rounding to the cent: ${d.rounding}`);
  out.push(`  same-day lots paired differently (day total agrees): ${d.pairedDifferently.length}`);
  out.push(list(d.pairedDifferently, (xs) => table(xs.map((x) => [...tvRow(x.tv), "journal", money(x.trade.grossPnl)]))));
  out.push(`  gross P&L differs (closed trades): ${d.pnlDiffers.length}`);
  out.push(list(d.pnlDiffers, (xs) => table(xs.map((x) => [...tvRow(x.tv), "journal", money(x.trade.grossPnl)]))));
  out.push(`  execution count differs: ${d.execCount.length}`);
  out.push(list(d.execCount, (xs) => table(xs.map((x) => [...tvRow(x.tv), `TV ${x.tv.execCount} execs`, `journal ${x.trade.fillIds.length} fills`]))));
  out.push(`  quantity: compared as part of matching (see unmatched above)`);
  out.push(`  fees: not compared (the export has gross P&L only)`);
  out.push(`  Tradervue duplicate copies: ${d.duplicateRows} rows on ${d.duplicateTrades} trades, ${d.duplicateTagConflicts} with different tags (tags are combined)`);

  out.push("\nGAUGE 90-DAY BASELINES (closed trades, W/L/BE  win %)");
  out.push(table([
    ["", "WINDOW", "BEFORE", "AFTER"],
    ...(["day", "swing"] as const).map((s) => [s, `${p.baselines[s].after.from} → ${p.baselines[s].after.to}`, baselineCell(p.baselines[s].before), baselineCell(p.baselines[s].after)]),
  ]));

  out.push("\nSUMMARY BEFORE");
  out.push(summaryTable(p.before.trades));
  out.push("\nSUMMARY AFTER");
  out.push(summaryTable(p.trades));
  return out;
}

/** overrides.json, a regenerated derived/trades.json, the schema copies and the archived export. */
export function tradervueWrites(
  p: TradervuePlan,
  ctx: { generator: string; schemas: SchemaTexts; archived: { paths: Set<string>; blobShas: Set<string> } },
  validate: Validate,
): FileWrite[] {
  if (p.errors.length) throw new Error("the Tradervue export has errors; nothing can be written");
  validate("overrides", p.overrides, "overrides.json");
  return [
    { path: "overrides.json", content: jsonText(p.overrides) },
    derivedWrite({ generated: true, generator: ctx.generator, trades: p.trades, ideas: p.ideas }, validate),
    ...schemaWrites(ctx.schemas),
    ...archiveWrites([p.input], p.today, ctx.archived),
  ];
}

/** Commit message: counts only, no symbols, tags or notes. */
export function tradervueMessage(p: TradervuePlan): string {
  const tagged = [...p.match.byTrade.keys()].filter((id) => p.overrides.trades[id]?.tags?.length).length;
  return `Import Tradervue ${p.today}: tags on ${tagged} trades, ${p.styleChanges.length} style changes, ${p.notes.set + p.notes.replaced} notes`;
}
