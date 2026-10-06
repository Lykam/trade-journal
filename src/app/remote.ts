// Reading and committing trade-history from the browser. Loaded on demand (it
// brings the schemas and their precompiled validators), by the Import page and
// the Commit buttons.
import { commitPlan, readHistory, type GitHubClient, type RemoteHistory } from "../core/github/client";
import { importFingerprint, importMessage, importWrites, planImport, type ImportInput, type ImportPlan } from "../core/import/plan";
import { planOverrideCommit, type OverrideCommitPlan, type StagedAction } from "../core/journal/overrides";
import { validatorFrom, type SchemaTexts } from "../core/schema-names";
import { planSymbolCommit, type SymbolChange, type SymbolCommitPlan } from "../core/symbols/mapping";
import type { SymbolsMap } from "../core/types";
import config from "../../schema/config.schema.json?raw";
import fills from "../../schema/fills.schema.json?raw";
import overrides from "../../schema/overrides.schema.json?raw";
import symbols from "../../schema/symbols.schema.json?raw";
import trades from "../../schema/trades.schema.json?raw";
import * as compiled from "virtual:tj-validators";

export const schemas: SchemaTexts = { config, fills, overrides, symbols, trades };
// Precompiled at build time from the same schema files (no `new Function` under the CSP, Q46).
export const validate = validatorFrom((name) => compiled[name]);
/** The derived/trades.json generator, as the CLI writes it. */
export const GENERATOR = `trade-journal@${__APP_VERSION__}`;

export { readHistory } from "../core/github/client";
export type { RemoteHistory } from "../core/github/client";

export const read = (gh: GitHubClient, repo: Parameters<typeof readHistory>[1]) => readHistory(gh, repo, validate);

// ---------------------------------------------------------------------------
// Import

export interface ImportCommit {
  plan: ImportPlan;
  files: ReturnType<typeof importWrites> | null;
  message: string;
  fingerprint: string;
}

export function computeImport(remote: RemoteHistory, inputs: ImportInput[], importedAt: string, mappings: SymbolsMap): ImportCommit {
  const plan = planImport(inputs, remote.snap, { importedAt, mappings });
  const files = plan.errors.length
    ? null
    : importWrites(plan, { generator: GENERATOR, schemas, archived: remote.archived }, validate);
  return { plan, files, message: importMessage(plan), fingerprint: importFingerprint(plan) };
}

export function commitImport(gh: GitHubClient, remote: RemoteHistory, c: ImportCommit, inputs: ImportInput[], importedAt: string, mappings: SymbolsMap) {
  if (!c.files) throw new Error("The import has errors; fix them before committing.");
  const asPlanned = (x: ImportCommit) => ({ ...x, files: x.files ?? [] });
  return commitPlan(gh, validate, remote, asPlanned(c), (r) => asPlanned(computeImport(r, inputs, importedAt, mappings)));
}

// ---------------------------------------------------------------------------
// Override edits

export const computeOverrides = (remote: RemoteHistory, staged: StagedAction[]): OverrideCommitPlan =>
  planOverrideCommit(remote.snap, staged, { generator: GENERATOR }, validate);

export const commitOverrides = (gh: GitHubClient, remote: RemoteHistory, plan: OverrideCommitPlan, staged: StagedAction[]) =>
  commitPlan(gh, validate, remote, plan, (r) => computeOverrides(r, staged));

// ---------------------------------------------------------------------------
// Symbol mappings (symbols.json)

export const computeSymbols = (remote: RemoteHistory, edits: SymbolChange[]): SymbolCommitPlan =>
  planSymbolCommit(remote.snap, edits, { generator: GENERATOR }, validate);

export const commitSymbols = (gh: GitHubClient, remote: RemoteHistory, plan: SymbolCommitPlan, edits: SymbolChange[]) =>
  commitPlan(gh, validate, remote, plan, (r) => computeSymbols(r, edits));
