// I-54.3 — the grader. Pure: each rule with a case that passes and one that
// doesn't. Only measured rows grade, and "can't tell" is never "inside".

import { describe, expect, it } from "vitest";
import type { ClaimRow, DayValue, StockCount } from "./grade";
import { GRADE, gradeSeasonWeek, gradeStockOut, isDue } from "./grade";

const stockClaim: ClaimRow = {
  kind: "stock_out",
  unit: "date",
  subject: "Blue Mug",
  subject_ref: {
    connection_id: "c",
    product_ref: "mug",
    source: "Shopify",
    on_hand: 12,
    as_of: "2026-10-27",
  },
  metric: "stock.on_hand",
  window_start: "2026-10-27",
  window_end: "2026-11-02",
  low_date: "2026-10-31",
  high_date: "2026-11-02",
  low_minor: null,
  high_minor: null,
  currency: null,
  low_num: null,
  high_num: null,
};

const counts = (...xs: [string, number][]): StockCount[] =>
  xs.map(([date, on_hand], i) => ({ id: `s${i}`, date, on_hand }));

const LATER = "2026-11-10";

describe("when a claim is due", () => {
  it("is due once its window closed at least a day ago", () => {
    expect(isDue("2026-11-02", "2026-11-04")).toBe(true);
  });
  it("isn't due the day after it closed", () => {
    expect(isDue("2026-11-02", "2026-11-03")).toBe(false);
  });
});

describe("a stock-out claim", () => {
  it("is inside when the first zero count falls in the days I gave", () => {
    const g = gradeStockOut(stockClaim, counts(["2026-10-30", 3], ["2026-10-31", 0]), LATER);
    expect(g).toMatchObject({ verdict: "inside", actual_date: "2026-10-31" });
    expect(g!.actual_source).toEqual({ table: "metric_observations", ids: ["s0", "s1"] });
    expect(g!.actual_note).toMatch(
      /inside the days I gave: 3 left on 30 Oct 2026, none on 31 Oct 2026/,
    );
  });

  it("is below when it ran out before the earliest day, with how far off in days", () => {
    const g = gradeStockOut(stockClaim, counts(["2026-10-28", 4], ["2026-10-29", 0]), LATER);
    expect(g!.verdict).toBe("below");
    expect(g!.actual_note).toMatch(
      /at least 2 days before the earliest day I gave \(31 Oct 2026\)/,
    );
  });

  it("is above when stock is still there on the latest day or after", () => {
    const on = gradeStockOut(stockClaim, counts(["2026-11-02", 2]), LATER);
    expect(on).toMatchObject({ verdict: "above", actual_num: "2", actual_date: "2026-11-02" });
    const after = gradeStockOut(stockClaim, counts(["2026-11-01", 4], ["2026-11-05", 1]), LATER);
    expect(after!.verdict).toBe("above");
    expect(after!.actual_note).toMatch(/3 days after the latest day I gave/);
  });

  it("can't tell when a delivery came in: the forecast didn't claim one", () => {
    const g = gradeStockOut(stockClaim, counts(["2026-10-29", 6], ["2026-10-30", 40]), LATER);
    expect(g).toMatchObject({ verdict: "cant_tell" });
    expect(g!.actual_note).toMatch(/More came in: 6 on hand on 29 Oct 2026, 40 on 30 Oct 2026/);
  });

  it("can't tell when the counts straddle an end of the range", () => {
    const g = gradeStockOut(stockClaim, counts(["2026-10-29", 5], ["2026-11-01", 0]), LATER);
    expect(g!.verdict).toBe("cant_tell");
  });

  it("waits for counts that aren't in yet, then can't tell", () => {
    expect(gradeStockOut(stockClaim, [], "2026-11-04")).toBeNull();
    const late = gradeStockOut(stockClaim, [], "2026-11-16");
    expect(late).toMatchObject({ verdict: "cant_tell", actual_source: null });
    expect(GRADE.patience_days).toBe(14);
  });

  it("reads only counts after the day it started from", () => {
    const g = gradeStockOut(stockClaim, counts(["2026-10-27", 0], ["2026-10-20", 0]), "2026-11-04");
    expect(g).toBeNull();
  });
});

const weekClaim: ClaimRow = {
  kind: "season_week",
  unit: "money",
  subject: "revenue",
  subject_ref: { connection_id: "c", metric: "revenue.daily", currency: "EUR", source: "Shopify" },
  metric: "revenue.daily",
  window_start: "2026-11-02",
  window_end: "2026-11-08",
  low_minor: 370_000,
  high_minor: 450_000,
  currency: "EUR",
  low_num: null,
  high_num: null,
  low_date: null,
  high_date: null,
};

const week = (perDay: number, skip: number[] = []): DayValue[] =>
  Array.from({ length: 7 }, (_, i) => i)
    .filter((i) => !skip.includes(i))
    .map((i) => ({ id: `d${i}`, date: `2026-11-0${2 + i}`, value: perDay }));

describe("a season week", () => {
  it("is inside when the week's measured total is in the range", () => {
    const g = gradeSeasonWeek(weekClaim, week(60_000), LATER);
    expect(g).toMatchObject({ verdict: "inside", actual_minor: 420_000 });
    expect(g!.actual_note).toBe("It came to €4,200, measured by Shopify: inside the range.");
    expect(g!.actual_source!.ids).toHaveLength(7);
  });

  it("is above or below, with how far off in money", () => {
    const over = gradeSeasonWeek(weekClaim, week(70_000), LATER);
    expect(over!.verdict).toBe("above");
    expect(over!.actual_note).toMatch(
      /€4,900, measured by Shopify: €400 over the top of the range/,
    );
    const under = gradeSeasonWeek(weekClaim, week(50_000), LATER);
    expect(under!.verdict).toBe("below");
    expect(under!.actual_note).toMatch(/€200 under the bottom of the range/);
  });

  it("says cents when whole euros would say nothing", () => {
    const g = gradeSeasonWeek({ ...weekClaim, high_minor: 419_990 }, week(60_000), LATER);
    expect(g!.actual_note).toMatch(/€0\.10 over the top/);
  });

  it("waits for a missing day, then can't tell — a gap is never a zero", () => {
    expect(gradeSeasonWeek(weekClaim, week(60_000, [3]), "2026-11-10")).toBeNull();
    const g = gradeSeasonWeek(weekClaim, week(60_000, [3]), "2026-11-30");
    expect(g).toMatchObject({ verdict: "cant_tell", actual_minor: null });
    expect(g!.actual_note).toMatch(/1 day of the week wasn't measured/);
  });

  it("grades a count series in its own units", () => {
    const counted: ClaimRow = {
      ...weekClaim,
      unit: "count",
      subject: "orders",
      low_minor: null,
      high_minor: null,
      currency: null,
      low_num: "60.0",
      high_num: "80.0",
    };
    expect(gradeSeasonWeek(counted, week(10), LATER)).toMatchObject({
      verdict: "inside",
      actual_num: "70",
    });
    expect(gradeSeasonWeek(counted, week(13), LATER)!.actual_note).toMatch(
      /91 orders, measured by Shopify: 11 orders over the top/,
    );
  });
});
