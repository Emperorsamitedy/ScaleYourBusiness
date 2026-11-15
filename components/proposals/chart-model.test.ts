// The Decisions screen's chart numbers, each with a case that holds and
// a case that doesn't.

import { describe, expect, it } from "vitest";
import { HEALTH, loadLimits, rollbackThresholdMs } from "../../lib/site/health-rule";
import { basisCounts, pct, valueScaleTop, wordChange } from "./chart-model";

describe("the size of a wording change", () => {
  it("counts kept, added and removed words, ignoring the arrow and punctuation", () => {
    const c = wordChange(
      "dipped in our oatmeal speckle glaze. Every one is slightly different.",
      "→ dipped in our oatmeal speckle glaze. Dishwasher and microwave safe. Every one is slightly different.",
    );
    expect(c).toEqual({ before: 11, after: 15, kept: 11, added: 4, removed: 0 });
  });

  it("sees a rewrite as words out and words in", () => {
    const c = wordChange("Free delivery over fifty euros", "Free delivery on every order");
    expect(c).toEqual({ before: 5, after: 5, kept: 2, added: 3, removed: 3 });
  });

  it("draws nothing for a figure, which has no words to count", () => {
    expect(wordChange("€34.00", "€36.72")).toBeNull();
    expect(wordChange("Daily budget €20", "Daily budget €15")).toBeNull();
  });
});

describe("evidence by basis", () => {
  const BASES = ["OBSERVED", "STATED", "ASSUMED"] as const;

  it("counts each basis in the legend's order, keeping zeros for the named bases", () => {
    const lines = [{ basis: "ASSUMED" }, { basis: "OBSERVED" }, { basis: "ASSUMED" }];
    expect(basisCounts(BASES, lines)).toEqual([
      { basis: "OBSERVED", count: 1 },
      { basis: "STATED", count: 0 },
      { basis: "ASSUMED", count: 2 },
    ]);
  });

  it("shows NOT RECORDED only when a line has it", () => {
    expect(basisCounts(BASES, [{ basis: "STATED" }]).map((c) => c.basis)).not.toContain(
      "NOT RECORDED",
    );
    expect(basisCounts(BASES, [{ basis: "NOT RECORDED" }]).at(-1)).toEqual({
      basis: "NOT RECORDED",
      count: 1,
    });
  });
});

describe("the value bars' shared scale", () => {
  it("rounds the biggest high up to a tick", () => {
    expect(valueScaleTop([123_760, 50_000])).toBe(150_000);
  });

  it("has no scale when nothing waiting has a money range", () => {
    expect(valueScaleTop([])).toBeNull();
    expect(valueScaleTop([0])).toBeNull();
  });

  it("holds a position inside the bar", () => {
    expect(pct(50, 200)).toBe(25);
    expect(pct(300, 200)).toBe(100);
    expect(pct(-5, 200)).toBe(0);
    expect(pct(5, 0)).toBe(0);
  });
});

describe("the rollback limit a site change is drawn against", () => {
  it("is baseline plus the floor for a fast page", () => {
    expect(loadLimits(240)).toEqual({ times: 720, plus: 2_240, limit: 2_240 });
    expect(rollbackThresholdMs(240)).toBe(240 + HEALTH.load_floor_ms);
  });

  it("is three times the baseline for a slow page", () => {
    expect(rollbackThresholdMs(1_500)).toBe(4_500);
    expect(rollbackThresholdMs(1_500)).not.toBe(1_500 + HEALTH.load_floor_ms);
  });
});
