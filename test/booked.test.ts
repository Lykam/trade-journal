// P&L booked on the day it was taken (Q67): trims count on their own day on the
// calendar and the week strip, and a day links to the trades that booked it.
import { describe, expect, it } from "vitest";
import { weekStrip } from "../src/core/dashboard/dashboard";
import { dailyTotals, monthGrid } from "../src/core/journal/calendar-view";
import { emptyFilter, parseView, tradeMatcher, viewToParams, activeFilterLabels, defaultView } from "../src/core/journal/filter";
import { bookedByDay } from "../src/core/trades/stats";
import type { Trade } from "../src/core/types";
import { closeLater, closed, open } from "./factory";

const MON = "2026-10-05T00:00:00-04:00";
const TUE = "2026-10-06T00:00:00-04:00";
const THU = "2026-10-08T00:00:00-04:00";

/** Buy 4 @ 25.21 Monday, trim 1 @ 29.67 Tuesday (+4.46), still holding 3. */
const swing = () =>
  open({
    symbol: "NVQU", openedAt: MON,
    events: [
      { kind: "open", at: MON, qty: 4, price: 25.21 },
      { kind: "trim", at: TUE, qty: 1, price: 29.67, realized: 4.46 },
    ],
  });

const ctx = { today: "2026-10-06", tagsOf: () => [], reviewed: () => false };

describe("bookedByDay", () => {
  it("books a trim on an open trade on the trim's day", () => {
    expect([...bookedByDay(swing(), "net")]).toEqual([["2026-10-06", 4.46]]);
    expect([...bookedByDay(swing(), "gross")]).toEqual([["2026-10-06", 4.46]]);
  });

  it("books the rest on the close, so a closed trade's days add up to its P&L", () => {
    const t = closeLater(swing(), THU, 27.21); // 3 × (27.21 − 25.21) = 6.00
    expect([...bookedByDay(t, "net")]).toEqual([["2026-10-06", 4.46], ["2026-10-08", 6]]);
    expect(t.netPnl).toBe(10.46);
  });

  it("charges buy fees to the first sale after them", () => {
    const base = swing();
    const t: Trade = {
      ...base,
      events: [{ ...base.events[0]!, fees: 0.5 }, { ...base.events[1]!, realized: 4.36 }], // trim paid 0.10
      realizedPnl: 3.86,
    };
    expect(bookedByDay(t, "net").get("2026-10-06")).toBe(3.86);
    expect(bookedByDay(t, "gross").get("2026-10-06")).toBe(4.46);
  });

  it("books nothing for an excluded or unmatched trade, or a buy with no sale", () => {
    expect(bookedByDay({ ...swing(), excluded: true }, "net").size).toBe(0);
    expect(bookedByDay({ ...swing(), status: "unmatched" }, "net").size).toBe(0);
    expect(bookedByDay(open({ openedAt: MON }), "net").size).toBe(0);
  });
});

describe("calendar and week strip", () => {
  const trades = () => [swing(), closed({ symbol: "ZZTA", closedAt: TUE, net: -1 })];

  it("counts the trim on its day, next to that day's closed trades", () => {
    expect(dailyTotals(trades(), "net").get("2026-10-06")).toEqual({ pnl: 3.46, trades: 2, ideas: 2 });
    expect(dailyTotals(trades(), "net").has("2026-10-05")).toBe(false);
    const { total } = monthGrid(trades(), "2026-10", { pnl: "net" });
    expect(total).toEqual({ pnl: 3.46, trades: 2, ideas: 2 });
  });

  it("shows the same day total on the dashboard week strip", () => {
    const tue = weekStrip(trades(), "2026-10-06").find((d) => d.date === "2026-10-06");
    expect(tue).toEqual({ date: "2026-10-06", net: 3.46, trades: 2 });
  });
});

describe("booked date filter", () => {
  it("lists the trades that booked P&L in the range, open ones included", () => {
    const [t, c] = [swing(), closed({ symbol: "ZZTA", closedAt: TUE, net: -1 })];
    const day = { ...emptyFilter(), from: "2026-10-06", to: "2026-10-06" };
    expect([t, c].filter(tradeMatcher(day, ctx))).toEqual([c]); // by trade date, the open swing belongs to Monday
    expect([t, c].filter(tradeMatcher({ ...day, booked: true }, ctx))).toEqual([t, c]);
  });

  it("round-trips through the URL and labels the date chip", () => {
    const v = parseView(new URLSearchParams("date=2026-10-06&booked=1"));
    expect(v.filter).toMatchObject({ from: "2026-10-06", to: "2026-10-06", booked: true });
    expect(viewToParams(v).toString()).toBe("date=2026-10-06&booked=1");
    expect(activeFilterLabels(v.filter, "2026-10-06")).toEqual(["BOOKED 2026-10-06"]);
    // Without dates the switch means nothing and is left out.
    expect(viewToParams({ ...defaultView(), filter: { ...emptyFilter(), booked: true } }).toString()).toBe("");
  });
});
