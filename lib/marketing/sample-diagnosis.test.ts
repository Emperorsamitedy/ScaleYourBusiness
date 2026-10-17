import { describe, expect, it } from "vitest";
import { RECOVERY_RANGE, SAMPLE } from "./sample-diagnosis";

// The sample is fictional, but its arithmetic has to hold: a sales page
// that shows wrong maths about a pretend shop sells nothing.
describe("the sample diagnosis is arithmetic-consistent", () => {
  it("revenue is orders × average order value", () => {
    const aov = SAMPLE.rows.find((r) => r.measure === "Average order value")!.value!;
    expect(SAMPLE.revenue_minor).toBe(Math.round(SAMPLE.orders * aov * 100));
  });

  it("the best seller's margin follows from its price and cost", () => {
    const margin = ((14.9 - 13.11) / 14.9) * 100;
    const row = SAMPLE.rows.find((r) => r.measure.startsWith("Margin · Morning Ritual"))!;
    expect(row.value).toBeCloseTo(margin, 1);
    // F1: €1.79 margin less the €0.70 shipping shortfall
    expect(14.9 - 13.11 - (5.6 - 4.9)).toBeCloseTo(1.09, 2);
  });

  it("the campaign's return is attributed sales over spend", () => {
    const roas = SAMPLE.rows.find((r) => r.measure.startsWith("Return on ad spend"))!;
    expect(roas.value).toBeCloseTo(1517 / 1850, 2);
  });

  it("the return rate is refunds over orders", () => {
    const rr = SAMPLE.rows.find((r) => r.measure === "Return rate")!;
    expect(rr.value).toBeCloseTo((82 / SAMPLE.orders) * 100, 1);
  });

  it("every flag agrees with its value and range", () => {
    for (const r of SAMPLE.rows) {
      if (r.value === null) {
        expect(r.flag).toBe("NOT PROVIDED");
        continue;
      }
      const [lo, hi] = r.range!;
      const past = r.act_at !== null && (r.act_at < lo ? r.value < r.act_at : r.value > r.act_at);
      const expected = past
        ? "ACT NOW"
        : r.value < lo
          ? "BELOW RANGE"
          : r.value > hi
            ? "ABOVE RANGE"
            : "IN RANGE";
      expect(r.flag, r.measure).toBe(expected);
    }
  });

  it("the headline recovery range is the sum of its parts, low ≤ high", () => {
    for (const p of SAMPLE.recovery) expect(p.low_minor).toBeLessThanOrEqual(p.high_minor);
    expect(RECOVERY_RANGE).toEqual({ low_minor: 75_000, high_minor: 177_000 });
  });
});
