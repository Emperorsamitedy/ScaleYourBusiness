import { describe, expect, it } from "vitest";
import { barShares, pastTarget } from "./goal-view";

describe("goals, said plainly", () => {
  it("is past the target by the goal's own direction", () => {
    expect(pastTarget(67_853, 50_000, "increase")).toBe(true);
    expect(pastTarget(40_000, 50_000, "increase")).toBe(false);
    expect(pastTarget(0.8, 1, "decrease")).toBe(true);
    expect(pastTarget(1.4, 1, "decrease")).toBe(false);
    expect(pastTarget(null, 1, "increase")).toBeNull();
  });

  it("places now and the path on the bar from the start to the target", () => {
    expect(barShares({ start: 660, target: 750, now: 705, path: 673 })).toEqual({
      now: 0.5,
      past: false,
      path: 13 / 90,
    });
    // Past the target: the bar is full and says so.
    expect(barShares({ start: 660, target: 750, now: 1020, path: 673 })).toMatchObject({
      now: 1,
      past: true,
    });
    // A "lower" goal runs the other way.
    expect(barShares({ start: 4, target: 1, now: 2.5, path: null })).toEqual({
      now: 0.5,
      past: false,
      path: null,
    });
    expect(barShares({ start: null, target: 750, now: 700, path: null })).toBeNull();
    expect(barShares({ start: 750, target: 750, now: 700, path: null })).toBeNull();
  });
});
