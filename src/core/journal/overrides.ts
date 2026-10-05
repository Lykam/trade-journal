// Bulk actions on overrides.json (SPEC §6.3): Add tag / Remove tag / Set style /
// Exclude, plus Add tags and the quick note on Trade detail (§6.4). Pure: they
// return a new Overrides object. planOverrideCommit replays staged actions on
// the current trade-history and lists the files one commit writes.
import { derivedWrite, jsonText, type FileWrite, type HistorySnapshot } from "../history/files";
import type { Validate } from "../schema-names";
import { buildTrades } from "../trades/grouping";
import type { Config, DerivedTrades, Fill, Overrides, SymbolsMap, Trade, TradeOverride } from "../types";

export type BulkAction =
  | { kind: "addTag"; tag: string }
  | { kind: "removeTag"; tag: string }
  | { kind: "setStyle"; style: Trade["style"] }
  | { kind: "exclude"; exclude: boolean }
  | { kind: "setNote"; note: string };

const sameTag = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Drop empty fields so an entry that matches the defaults disappears instead of lingering as {}. */
export function tidy(ov: TradeOverride, t: Trade, config: Config): TradeOverride | null {
  const out: TradeOverride = {};
  if (ov.style && ov.style !== config.styleByAccount[t.account]) out.style = ov.style;
  if (ov.exclude) out.exclude = true;
  if (ov.tags?.length) out.tags = ov.tags;
  if (ov.note?.trim()) out.note = ov.note.trim();
  if (ov.ideaId) out.ideaId = ov.ideaId;
  return Object.keys(out).length ? out : null;
}

/** Apply one bulk action to the selected trades. Trades keep their other override fields. */
export function applyBulkAction(overrides: Overrides, selected: Trade[], action: BulkAction, config: Config): Overrides {
  const trades = { ...overrides.trades };
  for (const t of selected) {
    const cur: TradeOverride = { ...(trades[t.id] ?? {}) };
    const tags = cur.tags ?? t.tags;
    switch (action.kind) {
      case "addTag": {
        const tag = action.tag.trim();
        if (tag && !tags.some((x) => sameTag(x, tag))) cur.tags = [...tags, tag];
        break;
      }
      case "removeTag":
        cur.tags = tags.filter((x) => !sameTag(x, action.tag));
        break;
      case "setStyle":
        cur.style = action.style;
        break;
      case "exclude":
        cur.exclude = action.exclude;
        break;
      case "setNote":
        cur.note = action.note;
        break;
    }
    const next = tidy(cur, t, config);
    if (next) trades[t.id] = next;
    else delete trades[t.id];
  }
  return { ...overrides, trades };
}

/** Trade ids whose override entry differs between two overrides files. */
export function changedOverrideIds(before: Overrides, after: Overrides): string[] {
  const ids = new Set([...Object.keys(before.trades), ...Object.keys(after.trades)]);
  return [...ids].filter((id) => JSON.stringify(before.trades[id] ?? null) !== JSON.stringify(after.trades[id] ?? null)).sort();
}

export interface OverridePreview {
  /** Override entries that change. */
  entries: number;
  /** Derived trades whose style, tags, note or exclusion change. */
  trades: number;
  /** Ideas that appear or disappear (a style change can regroup ideas). */
  ideasBefore: number;
  ideasAfter: number;
  ideasChanged: number;
}

/** Re-derive trades with the new overrides, exactly as the importer will, and count what changes. */
export function previewOverrides(
  fills: Fill[],
  ctx: { config: Config; symbols: SymbolsMap },
  before: Overrides,
  after: Overrides,
): OverridePreview {
  const a = buildTrades(fills, { ...ctx, overrides: before });
  const b = buildTrades(fills, { ...ctx, overrides: after });
  const key = (t: Trade) => JSON.stringify([t.style, t.tags, t.note ?? "", t.excluded, t.ideaId]);
  const prev = new Map(a.trades.map((t) => [t.id, key(t)]));
  const ideaKey = (i: { id: string; tradeIds: string[] }) => `${i.id}:${i.tradeIds.join(",")}`;
  const aIdeas = new Set(a.ideas.map(ideaKey));
  const bIdeas = new Set(b.ideas.map(ideaKey));
  return {
    entries: changedOverrideIds(before, after).length,
    trades: b.trades.filter((t) => prev.get(t.id) !== key(t)).length,
    ideasBefore: a.ideas.length,
    ideasAfter: b.ideas.length,
    ideasChanged: [...bIdeas].filter((k) => !aIdeas.has(k)).length + [...aIdeas].filter((k) => !bIdeas.has(k)).length,
  };
}

export function describeAction(a: BulkAction): string {
  switch (a.kind) {
    case "addTag": return `+tag "${a.tag}"`;
    case "removeTag": return `−tag "${a.tag}"`;
    case "setStyle": return `style → ${a.style}`;
    case "exclude": return a.exclude ? "exclude" : "include";
    case "setNote": return "note";
  }
}

/** One staged edit: an action and the ids of the trades it applies to. */
export interface StagedAction {
  tradeIds: string[];
  action: BulkAction;
}

export const describeStaged = (s: StagedAction) => `${describeAction(s.action)} on ${s.tradeIds.length} trade${s.tradeIds.length === 1 ? "" : "s"}`;

export class MissingTradesError extends Error {
  override name = "MissingTradesError";
  constructor(readonly ids: string[]) {
    super(`${ids.length} staged trade${ids.length === 1 ? " no longer exists" : "s no longer exist"} in trade-history; discard and stage again`);
  }
}

/** Replay staged actions, in order, on an overrides file. Trades are looked up in `trades` by id. */
export function replayStaged(overrides: Overrides, trades: Trade[], staged: StagedAction[], config: Config): Overrides {
  const byId = new Map(trades.map((t) => [t.id, t]));
  const missing = [...new Set(staged.flatMap((s) => s.tradeIds))].filter((id) => !byId.has(id));
  if (missing.length) throw new MissingTradesError(missing);
  return staged.reduce((ov, s) => applyBulkAction(ov, s.tradeIds.map((id) => byId.get(id)!), s.action, config), overrides);
}

export interface OverrideCommitPlan {
  overrides: Overrides;
  derived: DerivedTrades;
  preview: OverridePreview;
  /** Changed overrides.json entries: id → new entry (null when removed). */
  changes: Record<string, TradeOverride | null>;
  files: FileWrite[];
  message: string;
  /** Equal for two plans that write the same override changes (the user approved these). */
  fingerprint: string;
}

/**
 * The commit for a group of staged actions, computed against the current
 * trade-history (not the deployed bundle): overrides.json plus a regenerated
 * derived/trades.json.
 */
export function planOverrideCommit(
  snap: HistorySnapshot,
  staged: StagedAction[],
  ctx: { generator: string },
  validate: Validate,
): OverrideCommitPlan {
  const before = buildTrades(snap.fills, snap);
  const overrides = replayStaged(snap.overrides, before.trades, staged, snap.config);
  validate("overrides", overrides, "overrides.json");
  const after = buildTrades(snap.fills, { ...snap, overrides });
  const derived: DerivedTrades = { generated: true, generator: ctx.generator, trades: after.trades, ideas: after.ideas };
  const changes = Object.fromEntries(changedOverrideIds(snap.overrides, overrides).map((id) => [id, overrides.trades[id] ?? null]));
  const n = Object.keys(changes).length;
  return {
    overrides,
    derived,
    preview: previewOverrides(snap.fills, snap, snap.overrides, overrides),
    changes,
    files: [{ path: "overrides.json", content: jsonText(overrides) }, derivedWrite(derived, validate)],
    message: `Edit overrides: ${staged.map(describeStaged).join("; ")} (${n} entr${n === 1 ? "y" : "ies"})`,
    fingerprint: JSON.stringify(changes),
  };
}
