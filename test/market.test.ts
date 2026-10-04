import { describe, expect, it } from "vitest";
import { marketWindow, shouldPrice } from "../src/core/market";

const at = (s: string) => new Date(s).toISOString();

describe("marketWindow", () => {
  it("splits a weekday into regular, post-close and closed, in ET across DST", () => {
    expect(marketWindow(at("2025-03-14T09:29:00-04:00"))).toBe("closed");
    expect(marketWindow(at("2025-03-14T09:30:00-04:00"))).toBe("regular");
    expect(marketWindow(at("2025-03-14T15:59:00-04:00"))).toBe("regular");
    expect(marketWindow(at("2025-03-14T16:20:00-04:00"))).toBe("post-close");
    expect(marketWindow(at("2025-03-14T17:00:00-04:00"))).toBe("closed");
    expect(marketWindow(at("2025-01-15T14:45:00Z"))).toBe("regular"); // 09:45 EST
    expect(marketWindow(at("2025-01-15T21:20:00Z"))).toBe("post-close"); // 16:20 EST
  });

  it("is closed at weekends", () => {
    expect(marketWindow(at("2025-03-15T11:00:00-04:00"))).toBe("closed");
    expect(marketWindow(at("2025-03-16T11:00:00-04:00"))).toBe("closed");
  });
});

describe("shouldPrice", () => {
  const open = at("2025-03-14T11:00:00-04:00");
  const close = at("2025-03-14T16:20:00-04:00");

  it("regular runs need the clock and Yahoo's REGULAR state", () => {
    expect(shouldPrice("regular", open, { state: "REGULAR", lastTradeIso: open }).run).toBe(true);
    expect(shouldPrice("regular", open, { state: "CLOSED", lastTradeIso: null }).run).toBe(false);
    expect(shouldPrice("regular", close, { state: "REGULAR", lastTradeIso: open }).run).toBe(false);
  });

  it("the post-close run needs a session today", () => {
    expect(shouldPrice("post-close", close, { state: "POST", lastTradeIso: at("2025-03-14T16:00:00-04:00") }).run).toBe(true);
    expect(shouldPrice("post-close", close, { state: "CLOSED", lastTradeIso: at("2025-03-13T16:00:00-04:00") }).run).toBe(false);
    // The other UTC slot of the post-close cron lands at 15:20 or 17:20 ET and is skipped.
    expect(shouldPrice("post-close", at("2025-03-14T17:20:00-04:00"), null).run).toBe(false);
  });

  it("runs on the clock alone when the market status lookup fails", () => {
    expect(shouldPrice("regular", open, null)).toEqual({ run: true, why: "market status unknown; running on the clock" });
  });
});
