// Reading and committing trade-history from the browser. Loaded on demand (it
// brings Ajv and the schemas), by the Import page and the Commit buttons.
import { commitPlan, readHistory, type GitHubClient, type RemoteHistory } from "../core/github/client";
import { importFingerprint, importMessage, importWrites, planImport, type ImportInput, type ImportPlan } from "../core/import/plan";
import { planOverrideCommit, type OverrideCommitPlan, type StagedAction } from "../core/journal/overrides";
import { makeValidator, type SchemaTexts } from "../core/schema";
import type { SymbolsMap } from "../core/types";
import config from "../../schema/config.schema.json?raw";
import fills from "../../schema/fills.schema.json?raw";
import overrides from "../../schema/overrides.schema.json?raw";
import symbols from "../../schema/symbols.schema.json?raw";
import trades from "../../schema/trades.schema.json?raw";

export const schemas: SchemaTexts = { config, fills, overrides, symbols, trades };
export const validate = makeValidator(schemas);
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
