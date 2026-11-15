// The v2 landing page's illustrative store: every figure the page prints
// is either typed once in landing-v2.ts or worked out from those, and
// the sums the page shows have to hold.

import { describe, expect, it } from "vitest";
import {
  V2,
  adLost_minor,
  adMonthly_minor,
  adReturnPerEuro_minor,
  adSplitPct,
  chartSeries,
  checkRange,
  firmRowsSorted,
  mugAfter_minor,
  scanLeaks,
  scanTotal,
} from "./landing-v2";

const isMinor = (n: number) => Number.isInteger(n) && n >= 0;

describe("the ad campaign's loss, as the page works it out", () => {
  it("is the spend minus what came back, then a month's worth to the whole euro", () => {
    expect(adLost_minor()).toBe(8_874);
    // 88.74 × 30 ÷ 14 = 190.157… → €190
    expect(adMonthly_minor()).toBe(19_000);
    expect(adMonthly_minor() % 100).toBe(0);
  });

  it("returns 79 cents for every euro, and the split bar sums to the whole spend", () => {
    expect(adReturnPerEuro_minor()).toBe(79);
    const { back, lost } = adSplitPct();
    expect(back + lost).toBeCloseTo(100, 10);
    expect(lost).toBeGreaterThan(0);
  });

  it("would not call a campaign that pays back a leak (the check itself)", () => {
    // A campaign is a leak only while less comes back than was spent.
    expect(V2.ad.back_minor).toBeLessThan(V2.ad.spent_minor);
    expect(V2.ad.back_minor).not.toBeGreaterThanOrEqual(V2.ad.spent_minor);
  });
});

describe("the price rise", () => {
  it("is the mug's price plus eight percent, to the cent", () => {
    expect(mugAfter_minor()).toBe(3_672);
    expect(mugAfter_minor()).toBeGreaterThan(V2.mug.now_minor);
  });
});

describe("the diagnosis scan", () => {
  it("finds five leaks in scan order, two of them without a price", () => {
    const leaks = scanLeaks();
    expect(leaks.map((l) => l.key)).toEqual(["breakage", "ads", "pricing", "bowl", "repeat"]);
    expect(leaks.map((l) => l.at)).toEqual([...leaks.map((l) => l.at)].sort((a, b) => a - b));
    expect(leaks.filter((l) => l.low_minor === null).length).toBe(2);
    for (const l of leaks) {
      if (l.low_minor === null || l.high_minor === null) continue;
      expect(isMinor(l.low_minor) && isMinor(l.high_minor)).toBe(true);
      expect(l.low_minor).toBeLessThanOrEqual(l.high_minor);
    }
  });

  it("totals only what it has found so far", () => {
    expect(scanTotal(0)).toEqual({ found: 0, unpriced: 0, low_minor: 0, high_minor: 0 });
    expect(scanTotal(0.2)).toEqual({ found: 1, unpriced: 1, low_minor: 0, high_minor: 0 });
    expect(scanTotal(0.35)).toEqual({
      found: 2,
      unpriced: 1,
      low_minor: 19_000,
      high_minor: 19_000,
    });
    // 190 + 134 + 461 = 785; 190 + 1,238 + 895 = 2,323
    expect(scanTotal(1)).toEqual({ found: 5, unpriced: 2, low_minor: 78_500, high_minor: 232_300 });
  });

  it("never counts an unpriced leak as money", () => {
    const all = scanTotal(1);
    const priced = scanLeaks().filter((l) => l.high_minor !== null);
    expect(all.high_minor).toBe(priced.reduce((s, l) => s + (l.high_minor ?? 0), 0));
    expect(all.found - all.unpriced).toBe(priced.length);
  });
});

describe("the sixty-day chart", () => {
  const s = chartSeries();

  it("has one candle a day, in whole euros, the same on every load", () => {
    expect(s.length).toBe(V2.chartDays);
    expect(chartSeries()).toEqual(s);
    for (const c of s) {
      for (const v of [c.open_minor, c.high_minor, c.low_minor, c.close_minor, c.slipped_minor]) {
        expect(isMinor(v) && v % 100 === 0).toBe(true);
      }
    }
  });

  it("keeps every candle's high above and low below its open and close", () => {
    for (const c of s) {
      expect(c.high_minor).toBeGreaterThanOrEqual(Math.max(c.open_minor, c.close_minor));
      expect(c.low_minor).toBeLessThanOrEqual(Math.min(c.open_minor, c.close_minor));
      expect(c.slipped_minor).toBeGreaterThan(c.close_minor);
    }
  });

  it("opens each day where the day before closed", () => {
    for (let i = 1; i < s.length; i++) expect(s[i]?.open_minor).toBe(s[i - 1]?.close_minor);
  });
});

describe("the free-check demo's rule of thumb", () => {
  it("gives the page's opening figure for an online shop", () => {
    expect(checkRange("shop", V2.check.start_minor)).toEqual({
      low_minor: 50_000,
      high_minor: 125_000,
    });
  });

  it("rounds each end to ten euros and keeps low under high for every kind", () => {
    for (const kind of ["shop", "salon", "cafe"] as const) {
      for (const sales of [V2.check.min_minor, 3_300_000, V2.check.max_minor]) {
        const r = checkRange(kind, sales);
        expect(r.low_minor % 1_000).toBe(0);
        expect(r.high_minor % 1_000).toBe(0);
        expect(r.low_minor).toBeLessThan(r.high_minor);
      }
    }
  });
});

describe("the client book", () => {
  it("sorts by money leaking, most first, without touching the stored order", () => {
    const sorted = firmRowsSorted();
    expect(sorted.map((r) => r.key)).toEqual(["ceramics", "salon", "cafe", "bike"]);
    expect(V2.firm.rows.map((r) => r.key)).toEqual(["bike", "ceramics", "salon", "cafe"]);
    expect(V2.firm.rows.length).toBeLessThan(V2.firm.clients);
  });
});
