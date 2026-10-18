import { describe, expect, it } from "vitest";
import { CHART_DAYS, CHART_EVENTS, CHART_WEEKS, chartDate } from "./sample-chart";

describe("the illustrative revenue chart", () => {
  it("has 90 daily candles and 13 weekly ones", () => {
    expect(CHART_DAYS).toHaveLength(90);
    expect(CHART_WEEKS).toHaveLength(13);
  });

  it("keeps money in integer minor units", () => {
    for (const k of CHART_DAYS) {
      for (const v of [k.open_minor, k.high_minor, k.low_minor, k.close_minor, k.ideal_minor]) {
        expect(Number.isInteger(v)).toBe(true);
      }
    }
  });

  it("draws well-formed candles, each opening at the previous close", () => {
    CHART_DAYS.forEach((k, i) => {
      expect(k.high_minor).toBeGreaterThanOrEqual(Math.max(k.open_minor, k.close_minor));
      expect(k.low_minor).toBeLessThanOrEqual(Math.min(k.open_minor, k.close_minor));
      const prev = CHART_DAYS[i - 1];
      if (prev) expect(k.open_minor).toBe(prev.close_minor);
    });
  });

  it("opens a gap below the no-leak line after the first leak", () => {
    const gap = (from: number, to: number) => {
      const s = CHART_DAYS.slice(from, to);
      return s.reduce((a, k) => a + (k.ideal_minor - k.close_minor), 0) / s.length;
    };
    const first = CHART_EVENTS[0].day;
    expect(gap(first, 90)).toBeGreaterThan(gap(0, first) + 10_000);
  });

  it("is deterministic and prints dates without a locale", () => {
    expect(chartDate(0)).toBe("20 Jul");
    expect(chartDate(89)).toBe("17 Oct");
    expect(CHART_DAYS[0]?.open_minor).toBe(138_000);
  });
});
