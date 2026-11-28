// The Goals screen's candles and path: a week is Monday to Sunday, a week
// with no measured day is no candle, and the path is progress.ts's
// straight line — absent before the measure was set, flat at the target
// after the deadline.

import { describe, expect, it } from "vitest";
import {
  goalWord,
  onPath,
  pathPer30d,
  weekStart,
  weeklyAverages,
  weeklyCandles,
  weeklyTotals,
} from "./chart-view";

describe("weekStart", () => {
  it("is the Monday on or before the day", () => {
    expect(weekStart("2026-10-12")).toBe("2026-10-12"); // a Monday
    expect(weekStart("2026-10-18")).toBe("2026-10-12"); // the Sunday after
    expect(weekStart("2026-10-19")).not.toBe("2026-10-12");
  });
});

describe("weeklyCandles", () => {
  const values = new Map<string, number>([
    ["2026-10-12", 100],
    ["2026-10-13", 140],
    ["2026-10-14", 90],
    ["2026-10-18", 120],
    // 2026-10-19 .. 25: nothing measured
    ["2026-10-26", 50],
  ]);

  it("opens on the week's first measured day, closes on its last, spans its extremes", () => {
    const [first] = weeklyCandles(values, "2026-10-12", "2026-10-31");
    expect(first).toEqual({
      week: "2026-10-12",
      open: 100,
      high: 140,
      low: 90,
      close: 120,
      days: 4,
    });
  });

  it("leaves out a week with no measured day, and reads only inside from..to", () => {
    const candles = weeklyCandles(values, "2026-10-12", "2026-10-31");
    expect(candles.map((c) => c.week)).toEqual(["2026-10-12", "2026-10-26"]);
    expect(weeklyCandles(values, "2026-10-13", "2026-10-17")[0]?.open).toBe(140);
  });
});

describe("weeklyTotals", () => {
  it("sums each week's measured days", () => {
    const totals = weeklyTotals(
      new Map([
        ["2026-10-12", 3],
        ["2026-10-16", 4],
        ["2026-10-20", 5],
      ]),
      "2026-10-01",
      "2026-10-31",
    );
    expect(totals.get("2026-10-12")).toBe(7);
    expect(totals.get("2026-10-19")).toBe(5);
    expect(totals.has("2026-10-05")).toBe(false);
  });
});

describe("pathPer30d", () => {
  const measure = { set_on: "2026-10-01", deadline: "2026-10-31", target_per_30d: 2000 };
  const baseline = { per_30d: 1000 };

  it("runs straight from the baseline to the target, then holds at the target", () => {
    expect(pathPer30d(measure, baseline, "2026-10-01")).toBe(1000);
    expect(pathPer30d(measure, baseline, "2026-10-16")).toBe(1500);
    expect(pathPer30d(measure, baseline, "2026-10-31")).toBe(2000);
    expect(pathPer30d(measure, baseline, "2026-12-01")).toBe(2000);
  });

  it("has no path before the measure was set, or without a baseline", () => {
    expect(pathPer30d(measure, baseline, "2026-09-30")).toBeNull();
    expect(pathPer30d(measure, null, "2026-10-16")).toBeNull();
  });
});

describe("goalWord and onPath", () => {
  it("names each verdict, and counts only reached or on track as on the path", () => {
    expect(goalWord("lagging")).toBe("behind");
    expect(goalWord("on_track")).toBe("on_path");
    expect(goalWord(null)).toBeNull();
    expect(onPath("achieved")).toBe(true);
    expect(onPath("on_track")).toBe(true);
    expect(onPath("lagging")).toBe(false);
    expect(onPath(undefined)).toBe(false);
  });
});

describe("weeklyAverages", () => {
  it("averages each week over the days measured in it, and skips a week with none", () => {
    const values = new Map([
      ["2026-11-02", 100],
      ["2026-11-03", 300],
      ["2026-11-16", 70],
    ]);
    expect(weeklyAverages(values, "2026-11-02", "2026-11-22")).toEqual([
      { week: "2026-11-02", per_day: 200, days: 2 },
      { week: "2026-11-16", per_day: 70, days: 1 },
    ]);
  });
});
