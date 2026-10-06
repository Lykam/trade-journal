// Account value and each holding's share of it (Q68). Fake tickers only.
import { describe, expect, it } from "vitest";
import { schemaTexts, validate } from "../cli/lib/history";
import { planBalanceCommit } from "../src/core/account/commit";
import { accountValue, accountValues, balanceError, checkpointGap, heldAtClose, shareOfAccount } from "../src/core/account/value";
import { openPositions } from "../src/core/dashboard/dashboard";
import type { HistorySnapshot } from "../src/core/history/files";
import type { AccountBalance, Quote, Trade } from "../src/core/types";
import { closed, open } from "./factory";
import { config } from "./helpers";

const MON = "2026-10-05T00:00:00-04:00";
const TUE = "2026-10-06T00:00:00-04:00";
const EVENING = "2026-10-06T20:00:00Z";
const q = (price: number): Quote => ({ price, time: EVENING });

/** Buy 10 @ 10 Monday, trim 2 @ 12 Tuesday (+4). 8 left at cost 10. */
const swing = () =>
  open({
    symbol: "NVQU", openedAt: MON,
    events: [
      { kind: "open", at: MON, qty: 10, price: 10 },
      { kind: "trim", at: TUE, qty: 2, price: 12, realized: 4 },
    ],
  });
const start: AccountBalance = { start: { date: "2026-10-01", amount: 500 } };

describe("account value", () => {
  it("is cash from the start plus every buy and sale, and positions at the last price", () => {
    const trades = [swing(), closed({ style: "swing", symbol: "ZZTA", closedAt: MON, net: 3 })];
    const v = accountValue(trades, "schwab-main", start, { NVQU: q(11) }, EVENING);
    // 500 − 100 (buy) + 24 (trim) + 3 (round trip) = 427 cash; 8 × 11 = 88 invested.
    expect(v).toMatchObject({ cash: 427, invested: 88, value: 515, adjustment: 0, atCost: 0, checkpoint: null });
  });

  it("counts an unpriced position at cost and says so", () => {
    const v = accountValue([swing()], "schwab-main", start, {}, EVENING);
    expect(v).toMatchObject({ cash: 424, invested: 80, value: 504, atCost: 1 });
  });

  it("leaves out other accounts and trades opened before the start", () => {
    const early = closed({ style: "swing", symbol: "ZZTB", openedAt: "2026-09-30T00:00:00-04:00", closedAt: MON, net: 50 });
    const day = closed({ style: "day", symbol: "ZZTC", closedAt: MON, net: 7 }); // webull
    expect(accountValue([swing(), early, day], "schwab-main", start, {}, EVENING).cash).toBe(424);
  });

  it("charges buy fees and sale fees to cash", () => {
    const base = swing();
    const t: Trade = { ...base, events: [{ ...base.events[0]!, fees: 1 }, { ...base.events[1]!, realized: 3.5 }], fees: 1.5 };
    expect(accountValue([t], "schwab-main", start, {}, EVENING).cash).toBe(422.5); // 500 − 100 − 1 + 24 − 0.5
  });

  it("adds the latest actual value's correction and keeps it", () => {
    // Monday close: 400 cash + 10 × 10.5 = 505 by the trades; the broker showed 507.
    const b: AccountBalance = { ...start, checkpoints: [{ date: "2026-10-05", value: 507, marks: { NVQU: 10.5 } }] };
    const v = accountValue([swing()], "schwab-main", b, { NVQU: q(11) }, EVENING);
    expect(v.adjustment).toBe(2);
    expect(v).toMatchObject({ cash: 426, value: 514 }); // 424 + 2, then 8 × 11
    // A checkpoint dated after today isn't used yet.
    const later: AccountBalance = { ...start, checkpoints: [{ date: "2026-10-09", value: 900, marks: {} }] };
    expect(accountValue([swing()], "schwab-main", later, {}, EVENING).adjustment).toBe(0);
  });

  it("is not thrown off by fills imported after the actual value was entered", () => {
    const b: AccountBalance = { ...start, checkpoints: [{ date: "2026-10-05", value: 505, marks: { NVQU: 10.5 } }] };
    const before = accountValue([swing()], "schwab-main", b, { NVQU: q(11) }, EVENING).value;
    // Monday's round trip (+3) shows up in a later import: the broker's number already had it.
    const late = closed({ style: "swing", symbol: "ZZTA", closedAt: MON, net: 3 });
    expect(checkpointGap([swing(), late], "schwab-main", b, b.checkpoints![0]!)).toBe(-3);
    expect(accountValue([swing(), late], "schwab-main", b, { NVQU: q(11) }, EVENING).value).toBe(before);
  });

  it("gives each holding's share of its account", () => {
    const trades = [swing()];
    const accounts = accountValues(trades, { ...config, balances: { "schwab-main": start } }, { NVQU: q(11) }, EVENING);
    expect(shareOfAccount(trades[0]!, accounts)).toBeCloseTo(88 / 512, 6);
    const rows = openPositions(trades, { NVQU: q(11) }, EVENING, accounts);
    expect(rows[0]!.acctShare).toBeCloseTo(88 / 512, 6);
    expect(openPositions(trades, {}, EVENING)[0]!.acctShare).toBeNull();
  });

  it("lists what was held at a close, for the actual-value form", () => {
    expect(heldAtClose([swing()], "schwab-main", start, "2026-10-05")).toEqual([{ symbol: "NVQU", shares: 10 }]);
    expect(heldAtClose([swing()], "schwab-main", start, "2026-10-06")).toEqual([{ symbol: "NVQU", shares: 8 }]);
    expect(heldAtClose([swing()], "schwab-main", start, "2026-10-02")).toEqual([]);
  });

  it("checks a balance before it is saved", () => {
    expect(balanceError(start)).toBeNull();
    expect(balanceError({ start: { date: "", amount: 5 } })).toMatch(/Start date/);
    expect(balanceError({ start: { date: "2026-10-01", amount: -1 } })).toMatch(/Starting balance/);
    expect(balanceError({ ...start, checkpoints: [{ date: "2026-09-01", value: 1, marks: {} }] })).toMatch(/before the start/);
    expect(balanceError({ ...start, checkpoints: [{ date: "2026-10-02", value: 1, marks: { NVQU: 0 } }] })).toMatch(/NVQU/);
    const twice = { date: "2026-10-02", value: 1, marks: {} };
    expect(balanceError({ ...start, checkpoints: [twice, twice] })).toMatch(/One actual value per date/);
  });
});

describe("balance commit", () => {
  const snap = (balances?: Record<string, AccountBalance>): HistorySnapshot => ({
    config: balances ? { ...config, balances } : config, symbols: {}, overrides: { trades: {}, openingPositions: [] }, fills: [], derived: null,
  });
  const ctx = { schemas: schemaTexts() };

  it("writes config.json with the balance and trade-history's copy of the schema", () => {
    const plan = planBalanceCommit(snap(), "schwab-main", start, ctx, validate);
    expect(plan.files.map((f) => f.path)).toEqual(["config.json", "schema/config.schema.json"]);
    expect(JSON.parse(plan.files[0]!.content as string).balances).toEqual({ "schwab-main": start });
    expect(plan.message).toBe("Account value: schwab-main start 500.00 on 2026-10-01");
  });

  it("names an added actual value, sorts them by date, and writes nothing when unchanged", () => {
    const cp = (date: string, value: number) => ({ date, value, marks: {} });
    const was: AccountBalance = { ...start, checkpoints: [cp("2026-10-03", 510)] };
    const plan = planBalanceCommit(snap({ "schwab-main": was }), "schwab-main", { ...start, checkpoints: [cp("2026-10-06", 520), cp("2026-10-03", 510)] }, ctx, validate);
    expect(plan.message).toBe("Account value: schwab-main actual 520.00 on 2026-10-06");
    expect(plan.config.balances!["schwab-main"]!.checkpoints!.map((c) => c.date)).toEqual(["2026-10-03", "2026-10-06"]);
    expect(planBalanceCommit(snap({ "schwab-main": was }), "schwab-main", was, ctx, validate).files).toEqual([]);
    const removed = planBalanceCommit(snap({ "schwab-main": was }), "schwab-main", start, ctx, validate);
    expect(removed.message).toBe("Account value: schwab-main remove actual on 2026-10-03");
  });

  it("refuses an unknown account or a bad balance, and can remove an account's entry", () => {
    expect(() => planBalanceCommit(snap(), "nope", start, ctx, validate)).toThrow(/no account "nope"/);
    expect(() => planBalanceCommit(snap(), "schwab-main", { start: { date: "x", amount: 1 } }, ctx, validate)).toThrow(/Start date/);
    const gone = planBalanceCommit(snap({ "schwab-main": start }), "schwab-main", null, ctx, validate);
    expect("balances" in gone.config).toBe(false);
  });
});
