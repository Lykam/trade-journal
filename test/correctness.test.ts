// Small correctness fixes from the 2026-10-04 review (#4). Synthetic data, fake tickers.
import { describe, expect, it } from "vitest";
import { computeGauge, positionAt } from "../src/core/gauge/gauge";
import { exportOrder } from "../src/core/import/plan";
import { buildJournal } from "../src/core/journal/journal";
import { buildRows } from "../src/core/journal/rows";
import { buildTrades, markToMarket } from "../src/core/trades";
import type { Fill } from "../src/core/types";
import { config, noOverrides } from "./helpers";

let n = 0;
function fill(o: Partial<Fill> & Pick<Fill, "side" | "qty" | "price" | "executedAt">): Fill {
  return {
    id: `sw-${String(++n).padStart(12, "0")}`, broker: "schwab", account: "schwab-main", symbol: "SWGQ", assetType: "equity",
    fees: 0, timePrecision: "day", seq: n, source: "synthetic.csv", importedAt: "2025-03-20T00:00:00Z", ...o,
  };
}
const trades = (fills: Fill[]) => buildTrades(fills, { config, symbols: {}, overrides: noOverrides() }).trades;

describe("C3: volume of an unmatched trade", () => {
  it("counts each share bought or sold once: hold 10, sell 15 is 25, not 30", () => {
    const ts = trades([
      fill({ side: "buy", qty: 10, price: 5, executedAt: "2025-03-10T00:00:00-04:00" }),
      fill({ side: "sell", qty: 15, price: 6, executedAt: "2025-03-11T00:00:00-04:00" }),
    ]);
    expect(ts[0]).toMatchObject({ status: "unmatched", unmatchedQty: 5 });
    const derived = { generated: true as const, generator: "test", trades: ts, ideas: buildTrades([], { config, symbols: {}, overrides: noOverrides() }).ideas };
    const j = buildJournal({ derived, symbols: {}, config, playbook: null }, "2025-04-01");
    expect(buildRows(ts, j, "trade")[0]!.volume).toBe(25);
  });
});

describe("C4: buy fees in the swing gauge mark", () => {
  const ts = trades([
    fill({ side: "buy", qty: 4, price: 10, fees: 1.5, executedAt: "2025-03-03T00:00:00-05:00" }),
    fill({ side: "sell", qty: 1, price: 12, fees: 0.25, executedAt: "2025-03-05T00:00:00-05:00" }),
    fill({ side: "sell", qty: 3, price: 13, executedAt: "2025-03-20T00:00:00-04:00" }),
  ]);
  const t = ts[0]!;
  const midWeek = "2025-03-12T12:00:00-04:00";

  it("records the buy fee on the open event and in realized P&L", () => {
    expect(t.events[0]).toMatchObject({ kind: "open", fees: 1.5 });
    expect(t.events[1]).toMatchObject({ kind: "trim", realized: 1.75 });
  });

  it("rebuilds a past position with the buy fee, as Open Positions does", () => {
    // realized so far: trim 2 − 0.25 − buy fee 1.5
    expect(positionAt(t, midWeek)).toEqual({ shares: 3, avgCost: 10, realized: 0.25 });
    const open = { ...t, status: "open" as const, closedAt: null, openQty: 3, events: t.events.slice(0, 2), realizedPnl: 0.25, result: null, netPnl: 0.25 };
    expect(positionAt(open, midWeek)).toEqual({ shares: 3, avgCost: 10, realized: markToMarket(open, 11).realized });
    const g = computeGauge("swing", { trades: [t], config, now: midWeek, quotes: { SWGQ: { price: 11, time: midWeek } } });
    expect(g.items.find((i) => i.trade.id === t.id)).toMatchObject({ unrealized: 3, realized: 0.25, pnl: 3.25 });
  });

  it("leaves events without fees unchanged (no fees key at $0)", () => {
    expect(t.events[2]).not.toHaveProperty("fees");
    const free = trades([fill({ side: "buy", qty: 1, price: 1, executedAt: "2025-03-03T00:00:00-05:00" })]);
    expect(free[0]!.events[0]).not.toHaveProperty("fees");
  });
});

describe("C5: one export order for the Import page and the CLI", () => {
  it("orders by modified time first, so a reset Webull numbering still applies oldest first", () => {
    const files = [
      { name: "Webull_Orders_Records.csv", lastModified: 2_000 },
      { name: "Webull_Orders_Records(3).csv", lastModified: 1_000 },
    ];
    expect(exportOrder(files).map((f) => f.name)).toEqual(["Webull_Orders_Records(3).csv", "Webull_Orders_Records.csv"]);
  });

  it("falls back to the name when times tie or are unknown", () => {
    const files = ["Webull_Orders_Records(2).csv", "Webull_Orders_Records.csv", "Webull_Orders_Records(10).csv"].map((name) => ({ name, lastModified: 5 }));
    expect(exportOrder(files).map((f) => f.name)).toEqual(["Webull_Orders_Records.csv", "Webull_Orders_Records(2).csv", "Webull_Orders_Records(10).csv"]);
    expect(exportOrder([{ name: "b(1).csv" }, { name: "a.csv" }]).map((f) => f.name)).toEqual(["a.csv", "b(1).csv"]);
  });
});
