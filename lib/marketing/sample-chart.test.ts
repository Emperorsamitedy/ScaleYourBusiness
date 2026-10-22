import { describe, expect, it } from "vitest";
import { CHART_SERIES, SALON_CHART, SHOP_CHART, chartDate } from "./sample-chart";

describe.each(CHART_SERIES.map((s) => [s.id, s] as const))(
  "the illustrative revenue chart (%s)",
  (_, s) => {
    it("has 90 daily candles and 13 weekly ones", () => {
      expect(s.days).toHaveLength(90);
      expect(s.weeks).toHaveLength(13);
    });

    it("keeps money in integer minor units", () => {
      for (const k of [...s.days, ...s.weeks]) {
        for (const v of [k.open_minor, k.high_minor, k.low_minor, k.close_minor, k.ideal_minor]) {
          expect(Number.isInteger(v)).toBe(true);
        }
      }
      expect(Number.isInteger(s.axis.lo_minor) && Number.isInteger(s.axis.hi_minor)).toBe(true);
    });

    it("draws well-formed candles, each opening at the previous close", () => {
      s.days.forEach((k, i) => {
        expect(k.high_minor).toBeGreaterThanOrEqual(Math.max(k.open_minor, k.close_minor));
        expect(k.low_minor).toBeLessThanOrEqual(Math.min(k.open_minor, k.close_minor));
        expect(k.volume).toBeGreaterThan(0);
        const prev = s.days[i - 1];
        if (prev) expect(k.open_minor).toBe(prev.close_minor);
      });
    });

    it("opens a gap below the no-leak line after the first leak", () => {
      const gap = (from: number, to: number) => {
        const x = s.days.slice(from, to);
        return x.reduce((a, k) => a + (k.ideal_minor - k.close_minor), 0) / x.length;
      };
      const first = s.events[0]!.day;
      expect(gap(first, 90)).toBeGreaterThan(gap(0, first) + 10_000);
    });

    it("marks its leaks in order, inside the 90 days, each with a distinct key", () => {
      const days = s.events.map((e) => e.day);
      expect([...days].sort((a, b) => a - b)).toEqual(days);
      for (const d of days) expect(d).toBeGreaterThan(0);
      for (const d of days) expect(d).toBeLessThan(90);
      expect(new Set(s.events.map((e) => e.key)).size).toBe(s.events.length);
    });

    it("keeps the no-leak line inside its price axis", () => {
      for (const k of s.days) {
        expect(k.ideal_minor).toBeGreaterThan(s.axis.lo_minor);
        expect(k.ideal_minor).toBeLessThan(s.axis.hi_minor);
      }
    });
  },
);

describe("the two series", () => {
  it("are deterministic and print dates without a locale", () => {
    expect(chartDate(0)).toBe("20 Jul");
    expect(chartDate(89)).toBe("17 Oct");
    expect(SHOP_CHART.days[0]?.open_minor).toBe(138_000);
    expect(SALON_CHART.days[0]?.open_minor).toBe(125_000);
  });

  it("draw the salon's candles wholly on its axis", () => {
    for (const k of SALON_CHART.days) {
      expect(k.low_minor).toBeGreaterThanOrEqual(SALON_CHART.axis.lo_minor);
      expect(k.high_minor).toBeLessThanOrEqual(SALON_CHART.axis.hi_minor);
    }
  });
});
