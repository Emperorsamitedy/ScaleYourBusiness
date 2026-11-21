// Outside signals: what a screen is handed. The days and the law for a
// country that has a calendar, a plain "none here" for one that does not,
// and the two windows a screen asks about: a week, and a delivery time. Pure.

import { describe, expect, it } from "vitest";
import { OUTSIDE_MAX_DAYS, daySpan, holidaysBetween, holidaysInStretch, outsideView } from "./view";

describe("the signal for a country over a stretch of days", () => {
  it("carries the days, whether each is a working day, and the law they come from", () => {
    // Thirteen weeks from Monday 23 November 2026: to Sunday 21 February 2027.
    const view = outsideView("HU", "2026-11-23", 91);
    expect(view).toMatchObject({ country: "HU", from: "2026-11-23", to: "2027-02-21" });
    expect(view.holidays.covered).toBe(true);
    if (!view.holidays.covered) return;
    expect(view.holidays.days).toEqual([
      { date: "2026-12-24", key: "december_24", working_day: true },
      { date: "2026-12-25", key: "december_25", working_day: true },
      { date: "2026-12-26", key: "december_26", working_day: false },
      { date: "2027-01-01", key: "new_year", working_day: true },
    ]);
    expect(view.holidays.source).toMatchObject({
      country: "HU",
      in_force_on: "2026-11-14",
      read_on: "2026-11-21",
    });
    expect(view.holidays.source.law).toContain("102. § (1)");
  });

  it("says there is no calendar for a country it has none for, and guesses nothing", () => {
    expect(outsideView("DE", "2026-11-23", 91)).toEqual({
      country: "DE",
      from: "2026-11-23",
      to: "2027-02-21",
      holidays: { covered: false },
    });
  });

  it("says nothing about a country nobody named", () => {
    expect(outsideView(null, "2026-11-23", 7)).toEqual({
      country: null,
      from: "2026-11-23",
      to: "2026-11-29",
      holidays: { covered: false },
    });
  });

  it("looks at one day at least and a year and a day at most", () => {
    expect(outsideView("HU", "2026-12-24", 0)).toMatchObject({
      from: "2026-12-24",
      to: "2026-12-24",
    });
    const long = outsideView("HU", "2026-12-01", 5000);
    expect(daySpan(long.from, long.to)).toBe(OUTSIDE_MAX_DAYS);
  });

  it("counts both ends of a span", () => {
    expect(daySpan("2026-12-24", "2026-12-26")).toBe(3);
    expect(daySpan("2026-12-24", "2026-12-24")).toBe(1);
    expect(daySpan("2026-11-23", "2027-02-21")).toBe(91);
  });
});

describe("the two windows a screen asks about", () => {
  const view = outsideView("HU", "2026-11-23", 91);

  it("a week of the forecast: every holiday in it, a Saturday's too", () => {
    expect(holidaysBetween(view, "2026-12-21", "2026-12-27").map((d) => d.date)).toEqual([
      "2026-12-24",
      "2026-12-25",
      "2026-12-26",
    ]);
    expect(holidaysBetween(view, "2026-12-28", "2027-01-03").map((d) => d.date)).toEqual([
      "2027-01-01",
    ]);
    expect(holidaysBetween(view, "2026-11-23", "2026-11-29")).toEqual([]);
  });

  it("a delivery time from today: only the holidays on a working day", () => {
    // Ten days from Friday 18 December reach Sunday the 27th: the 24th and 25th count, Saturday the 26th does not.
    expect(holidaysInStretch(view, "2026-12-18", 10).map((d) => d.date)).toEqual([
      "2026-12-24",
      "2026-12-25",
    ]);
    expect(holidaysInStretch(view, "2026-12-18", 6)).toEqual([]);
    expect(holidaysInStretch(view, "2026-12-18", 0)).toEqual([]);
  });

  it("has nothing to say without a calendar, or without a view at all", () => {
    const none = outsideView("DE", "2026-11-23", 91);
    expect(holidaysBetween(none, "2026-12-21", "2026-12-27")).toEqual([]);
    expect(holidaysInStretch(none, "2026-12-18", 10)).toEqual([]);
    expect(holidaysBetween(null, "2026-12-21", "2026-12-27")).toEqual([]);
    expect(holidaysInStretch(null, "2026-12-18", 10)).toEqual([]);
  });
});
