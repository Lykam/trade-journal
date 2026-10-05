// Logic behind the UX review fixes (issues #13–#23, SPEC Q54+). Synthetic trades, fake tickers only.
import { describe, expect, it } from "vitest";
import { buyFees, daysHeld, openPositions, sortOpenRows } from "../src/core/dashboard/dashboard";
import { defaultView } from "../src/core/journal/filter";
import { buildJournal, groupPnl, type Journal } from "../src/core/journal/journal";
import { buildRows, sortRows } from "../src/core/journal/rows";
import type { QuotesFile, Trade } from "../src/core/types";
import { closed, ideasOf, open } from "./factory";
import { config } from "./helpers";

const q = (price: number, time = "2026-10-02T16:00:00-04:00") => ({ price, time });

function journal(trades: Trade[], quotes: QuotesFile["quotes"] = {}, today = "2026-10-04"): Journal {
  return buildJournal(
    { derived: { generated: true, generator: "test", trades, ideas: ideasOf(trades) }, symbols: {}, config, playbook: null, quotes: { asOf: "2026-10-02T20:00:00Z", quotes } },
    today,
  );
}

describe("#14 open trades and positions", () => {
  it("counts days held in ET calendar days, even late in the evening when UTC is already tomorrow", () => {
    const t = open({ symbol: "SWGA", openedAt: "2026-09-17T00:00:00-04:00" });
    // 22:40 ET on 10-04 is 02:40 UTC on 10-05; rounding milliseconds gave 18.
    expect(daysHeld(t, "2026-10-04T22:40:00-04:00")).toBe(17);
    expect(openPositions([t], {}, "2026-10-04T22:40:00-04:00")[0]!.daysHeld).toBe(17);
  });

  it("reports buy fees apart, so a fee-only realized figure says what it is", () => {
    const t = open({
      symbol: "SWGA", openedAt: "2026-09-17T00:00:00-04:00",
      events: [{ kind: "open", at: "2026-09-17T00:00:00-04:00", qty: 5, price: 10, fees: 0.65 }],
    });
    const withFee = { ...t, realizedPnl: -0.65, netPnl: -0.65 };
    expect(buyFees(withFee)).toBe(0.65);
    expect(openPositions([withFee], { SWGA: q(11) }, "2026-10-02T17:00:00-04:00")[0]).toMatchObject({ realized: -0.65, buyFees: 0.65, trims: [] });
  });

  it("sorts the Open Positions table on any column, unpriced rows last either way", () => {
    const a = open({ symbol: "SWGA", openedAt: "2026-09-10T00:00:00-04:00", qty: 10, price: 10 });
    const b = open({ symbol: "SWGB", openedAt: "2026-09-11T00:00:00-04:00", qty: 10, price: 10 });
    const c = open({ symbol: "SWGC", openedAt: "2026-09-12T00:00:00-04:00", qty: 10, price: 10 });
    const rows = openPositions([a, b, c], { SWGA: q(9), SWGC: q(12) }, "2026-10-02T17:00:00-04:00");
    const order = (key: Parameters<typeof sortOpenRows>[1], dir: 1 | -1) => sortOpenRows(rows, key, dir).map((r) => r.trade.symbol);
    expect(order("total", -1)).toEqual(["SWGC", "SWGA", "SWGB"]);
    expect(order("total", 1)).toEqual(["SWGA", "SWGC", "SWGB"]);
    expect(order("symbol", -1)).toEqual(["SWGC", "SWGB", "SWGA"]);
  });

  it("marks open trades in tables instead of showing 0.00, and says when there is no price", () => {
    const won = closed({ symbol: "SWGA", closedAt: "2026-09-20T16:00:00-04:00", net: 40 });
    const held = { ...open({ symbol: "SWGA", openedAt: "2026-09-25T00:00:00-04:00", qty: 10, price: 10 }), ideaId: won.ideaId };
    const unpriced = open({ symbol: "SWGB", openedAt: "2026-09-25T00:00:00-04:00", qty: 10, price: 10 });
    const j = journal([won, held, unpriced], { SWGA: q(11.95) });
    expect(groupPnl(j, [held], "net")).toEqual({ value: 19.5, open: true });
    // An idea with a closed trade and an open one: realized result plus the open mark, still shown as open.
    expect(groupPnl(j, [won, held], "net")).toEqual({ value: 59.5, open: true });
    expect(groupPnl(j, [unpriced], "net")).toEqual({ value: null, open: true });
    expect(groupPnl(j, [won], "gross")).toEqual({ value: 40, open: false });
  });

  it("sorts open rows after closed ones on P&L, in both directions", () => {
    const loser = closed({ symbol: "ZZTA", closedAt: "2026-09-20T16:00:00-04:00", net: -5 });
    const winner = closed({ symbol: "ZZTB", closedAt: "2026-09-21T16:00:00-04:00", net: 5 });
    const held = open({ symbol: "SWGA", openedAt: "2026-09-25T00:00:00-04:00" });
    const j = journal([loser, winner, held], { SWGA: q(99) });
    const rows = buildRows(j.trades, j, "trade");
    const syms = (dir: "asc" | "desc") => sortRows(rows, { key: "pnl", dir }, defaultView().pnl).map((r) => r.symbol);
    expect(syms("desc")).toEqual(["ZZTB", "ZZTA", "SWGA"]);
    expect(syms("asc")).toEqual(["ZZTA", "ZZTB", "SWGA"]);
  });
});
