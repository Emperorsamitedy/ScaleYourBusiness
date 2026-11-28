// Trading hours, said plainly: the grid cut to open hours, the hours that
// lose money, the first hour against the best, and what came in while closed.

import { describe, expect, it } from "vitest";
import type { WeekdayAnalysis } from "../../lib/hours/trading";
import { weekGrid } from "../../lib/hours/grid";
import { firstHourShares, losingHours, openOnly, takenWhileClosed } from "./hours-view";

function day(
  weekday: WeekdayAnalysis["weekday"],
  verdict: WeekdayAnalysis["verdict"],
  curve: { hour: number; mean_minor: number }[],
  over: Partial<WeekdayAnalysis> = {},
): WeekdayAnalysis {
  return {
    weekday,
    days_measured: 11,
    verdict,
    curve,
    first_hour: null,
    last_hour: null,
    peak: null,
    opening_signal: false,
    closing_signal: null,
    attention_signal: null,
    outside_hours_minor: 0,
    arithmetic: [],
    ...over,
  };
}

const schedule = {
  days: {
    mon: [],
    tue: [],
    wed: [],
    thu: [{ open: "10:00", close: "12:00" }],
    fri: [],
    sat: [{ open: "10:00", close: "12:00" }],
    sun: [{ open: "11:00", close: "12:00" }],
  },
  unstated: [],
};

const weekdays = [
  day("mon", "closed", [{ hour: 6, mean_minor: 1750 }], { outside_hours_minor: 22_000 }),
  day("tue", "closed", [], { outside_hours_minor: 11_000 }),
  day(
    "thu",
    "ok",
    [
      { hour: 10, mean_minor: 11_000 },
      { hour: 11, mean_minor: 2_900 },
    ],
    {
      first_hour: 10,
      peak: { hour: 10, mean_minor: 11_000 },
      opening_signal: true,
      outside_hours_minor: 5_000,
    },
  ),
  day(
    "sat",
    "ok",
    [
      { hour: 10, mean_minor: 15_000 },
      { hour: 11, mean_minor: 20_000 },
    ],
    { first_hour: 10, peak: { hour: 11, mean_minor: 20_000 }, opening_signal: true },
  ),
  day("sun", "ok", [{ hour: 11, mean_minor: 9_000 }], { first_hour: 11 }),
];

describe("trading hours, said plainly", () => {
  const grid = weekGrid({ schedule, weekdays, hourCostMinor: 3_800 });

  it("keeps only the open hours and the days with one, and names the days closed all day", () => {
    const g = openOnly(grid);
    expect(g.hours).toEqual([10, 11]);
    expect(g.rows.map((r) => r.weekday)).toEqual(["thu", "sat", "sun"]);
    // Sunday opens at 11: its 10:00 stays in the grid, as a closed hour.
    expect(g.rows.find((r) => r.weekday === "sun")?.cells.map((c) => c.open)).toEqual([
      false,
      true,
    ]);
    expect(g.closedDays).toEqual(["mon", "tue", "wed", "fri"]);
  });

  it("names the hours that lose money, the worst first", () => {
    expect(losingHours(grid)).toEqual([{ weekday: "thu", hour: 11, short_minor: 900 }]);
    expect(losingHours(weekGrid({ schedule, weekdays, hourCostMinor: 1_000 }))).toEqual([]);
  });

  it("says how much of the best hour the first hour takes, on the days the signal fired", () => {
    expect(firstHourShares(weekdays)).toEqual({ days: ["thu", "sat"], low: 0.75, high: 1 });
    expect(firstHourShares([day("thu", "ok", [])])).toBeNull();
  });

  it("adds up what came in while closed, and the closed day that took most on an average day", () => {
    expect(takenWhileClosed(weekdays)).toEqual({
      total_minor: 38_000,
      perDay: { weekday: "mon", minor: 2_000 },
    });
    expect(takenWhileClosed([day("thu", "ok", [])])).toEqual({ total_minor: 0, perDay: null });
  });
});
