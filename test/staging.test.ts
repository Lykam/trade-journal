// Staged override edits and their commit (#3): the preview on screen is always
// what CONFIRM writes, and a commit drops only the actions it wrote.
import { describe, expect, it } from "vitest";
import { initialStaging, stagingReducer, type StagingEvent, type StagingState } from "../src/core/journal/staging";
import { closed } from "./factory";
import { config, noOverrides } from "./helpers";

const a = closed({ closedAt: "2025-03-10T10:00:00-04:00", net: 5 });
const b = closed({ closedAt: "2025-03-11T10:00:00-04:00", net: -3 });
const ctx = { base: noOverrides(), trades: [a, b], config };
const run = (events: StagingEvent[], from: StagingState = initialStaging) => events.reduce((s, e) => stagingReducer(ctx, s, e), from);
const addTag: StagingEvent = { kind: "stage", trades: [a], action: { kind: "addTag", tag: "x-tag" } };
const setSwing: StagingEvent = { kind: "stage", trades: [b], action: { kind: "setStyle", style: "swing" } };

describe("staging reducer", () => {
  it("stages actions and applies them to the overrides", () => {
    const s = run([addTag, setSwing]);
    expect(s.staged?.actions).toHaveLength(2);
    expect(s.staged?.overrides.trades[a.id]?.tags).toEqual(["x-tag"]);
    expect(s.staged?.overrides.trades[b.id]?.style).toBe("swing");
  });

  it("refuses new actions and discards while a commit preview is open", () => {
    const s = run([addTag, { kind: "lock", locked: true }, setSwing, { kind: "discard" }]);
    expect(s.staged?.actions).toHaveLength(1);
    expect(s.staged?.overrides.trades[b.id]).toBeUndefined();
    expect(run([{ kind: "lock", locked: false }, setSwing], s).staged?.actions).toHaveLength(2);
  });

  it("drops only the committed actions, keeps the rest staged, and shows the outcome", () => {
    // Stage, open the preview (lock), commit the one action shown.
    let s = run([addTag, { kind: "lock", locked: true }, { kind: "committed", count: 1, url: "https://example.test/c/1" }]);
    expect(s).toEqual({ staged: null, locked: false, committed: { url: "https://example.test/c/1" } });
    // Two staged, a commit of the first: the second stays, replayed on the base without the first.
    s = run([addTag, setSwing, { kind: "committed", count: 1, url: null }]);
    expect(s.staged?.actions.map((x) => x.action.kind)).toEqual(["setStyle"]);
    expect(s.staged?.overrides.trades[a.id]).toBeUndefined();
    expect(s.staged?.overrides.trades[b.id]?.style).toBe("swing");
    expect(s.committed).toEqual({ url: null });
  });

  it("keeps the commit outcome until the next action or a dismiss", () => {
    const done = run([addTag, { kind: "committed", count: 1, url: "u" }]);
    expect(run([{ kind: "dismiss" }], done).committed).toBeNull();
    const next = run([setSwing], done);
    expect(next.committed).toBeNull();
    expect(next.staged?.actions).toHaveLength(1);
  });
});
