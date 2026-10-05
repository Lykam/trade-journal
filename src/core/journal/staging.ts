// Staged override edits and their commit (SPEC §4.5A, §6.3, §6.4). Pure state
// logic behind useStagedOverrides, so the rules are testable:
// - staging is locked while a commit preview or a commit is in progress, so the
//   preview on screen is always exactly what CONFIRM writes;
// - a commit removes only the actions it wrote; anything still staged stays,
//   replayed on the base overrides;
// - the commit outcome stays visible until the next action is staged or it is
//   dismissed.
import type { Config, Overrides, Trade } from "../types";
import { applyBulkAction, replayStaged, type BulkAction, type StagedAction } from "./overrides";

export interface Staged {
  overrides: Overrides;
  actions: StagedAction[];
}

export interface StagingState {
  staged: Staged | null;
  /** A commit preview or commit is open: staging is refused. */
  locked: boolean;
  /** The last commit's outcome (null url: nothing needed changing). */
  committed: { url: string | null } | null;
}

export type StagingEvent =
  | { kind: "stage"; trades: Trade[]; action: BulkAction }
  | { kind: "lock"; locked: boolean }
  /** The first `count` staged actions were committed. */
  | { kind: "committed"; count: number; url: string | null }
  | { kind: "discard" }
  | { kind: "dismiss" };

export interface StagingContext {
  /** overrides.json as deployed, which staged actions apply to. */
  base: Overrides;
  trades: Trade[];
  config: Config;
}

export const initialStaging: StagingState = { staged: null, locked: false, committed: null };

export function stagingReducer(ctx: StagingContext, s: StagingState, e: StagingEvent): StagingState {
  switch (e.kind) {
    case "stage": {
      if (s.locked || !e.trades.length) return s;
      const current = s.staged?.overrides ?? ctx.base;
      return {
        ...s,
        committed: null,
        staged: {
          overrides: applyBulkAction(current, e.trades, e.action, ctx.config),
          actions: [...(s.staged?.actions ?? []), { tradeIds: e.trades.map((t) => t.id), action: e.action }],
        },
      };
    }
    case "lock":
      return s.locked === e.locked ? s : { ...s, locked: e.locked };
    case "committed": {
      const rest = (s.staged?.actions ?? []).slice(e.count);
      return {
        locked: false,
        committed: { url: e.url },
        staged: rest.length ? { actions: rest, overrides: replayStaged(ctx.base, ctx.trades, rest, ctx.config) } : null,
      };
    }
    case "discard":
      return s.locked ? s : { ...s, staged: null };
    case "dismiss":
      return { ...s, committed: null };
  }
}
