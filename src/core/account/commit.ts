// Editing an account's balance from Settings (Q68): the starting balance and the
// actual values entered from the broker live under `balances` in config.json.
// One commit writes config.json (and trade-history's copy of its schema); trades
// don't change, so derived/trades.json is left alone.
import { jsonText, type FileWrite, type HistorySnapshot } from "../history/files";
import type { SchemaTexts, Validate } from "../schema-names";
import type { AccountBalance, Config } from "../types";
import { balanceError } from "./value";

export interface BalanceCommitPlan {
  config: Config;
  /** The account's entry before and after (null = none). */
  before: AccountBalance | null;
  after: AccountBalance | null;
  files: FileWrite[];
  message: string;
  /** Equal for two plans that write the same balance (what the user approved, Q40). */
  fingerprint: string;
}

/** Checkpoints in date order, so the file reads top to bottom. */
const tidy = (b: AccountBalance): AccountBalance => ({
  start: { date: b.start.date, amount: b.start.amount },
  ...(b.checkpoints?.length
    ? { checkpoints: [...b.checkpoints].sort((x, y) => x.date.localeCompare(y.date)).map((c) => ({ date: c.date, value: c.value, marks: c.marks })) }
    : {}),
});

function describe(account: string, before: AccountBalance | null, after: AccountBalance | null): string {
  if (!after) return `Account value: remove ${account}`;
  const parts: string[] = [];
  if (!before || before.start.date !== after.start.date || before.start.amount !== after.start.amount) {
    parts.push(`start ${after.start.amount.toFixed(2)} on ${after.start.date}`);
  }
  const was = new Map((before?.checkpoints ?? []).map((c) => [c.date, JSON.stringify(c)]));
  const now = new Map((after.checkpoints ?? []).map((c) => [c.date, c]));
  for (const [d, c] of now) if (was.get(d) !== JSON.stringify(c)) parts.push(`actual ${c.value.toFixed(2)} on ${d}`);
  for (const d of was.keys()) if (!now.has(d)) parts.push(`remove actual on ${d}`);
  return `Account value: ${account} ${parts.join("; ") || "no change"}`;
}

/** The commit for one account's new balance (null removes it), against the current trade-history. */
export function planBalanceCommit(
  snap: HistorySnapshot,
  account: string,
  next: AccountBalance | null,
  ctx: { schemas: SchemaTexts },
  validate: Validate,
): BalanceCommitPlan {
  if (!snap.config.accounts.includes(account)) throw new Error(`config.json has no account "${account}".`);
  const after = next && tidy(next);
  if (after) {
    const err = balanceError(after);
    if (err) throw new Error(err);
  }
  const before = snap.config.balances?.[account] ?? null;
  const balances = { ...snap.config.balances };
  if (after) balances[account] = after;
  else delete balances[account];
  const { balances: _, ...rest } = snap.config;
  const config: Config = Object.keys(balances).length ? { ...rest, balances } : rest;
  validate("config", config, "config.json");
  const changed = JSON.stringify(before) !== JSON.stringify(after);
  return {
    config, before, after,
    files: changed
      ? [{ path: "config.json", content: jsonText(config) }, { path: "schema/config.schema.json", content: ctx.schemas.config }]
      : [],
    message: describe(account, before, after),
    fingerprint: JSON.stringify([account, after]),
  };
}
