// Outside signals: public holidays by rule. The arithmetic of Easter against
// published dates, Hungary's list as the law has it, and the two honesties:
// no calendar means no answer, and a calendar answers only from the day its
// text was in force. Pure.

import { describe, expect, it } from "vitest";
import {
  HOLIDAY_CALENDARS,
  easterSunday,
  holidaysOfYear,
  holidaysWithin,
  onAWorkingDay,
  publicHolidays,
  shiftDays,
} from "./holidays";

const HU = HOLIDAY_CALENDARS.HU!;

describe("Easter Sunday, worked out", () => {
  it("agrees with the published dates, early ones and late ones", () => {
    expect(easterSunday(2024)).toBe("2024-03-31");
    expect(easterSunday(2025)).toBe("2025-04-20");
    expect(easterSunday(2026)).toBe("2026-04-05");
    expect(easterSunday(2027)).toBe("2027-03-28");
    expect(easterSunday(2028)).toBe("2028-04-16");
    expect(easterSunday(2030)).toBe("2030-04-21");
    // The earliest it has fallen in living memory, and the latest it can.
    expect(easterSunday(2008)).toBe("2008-03-23");
    expect(easterSunday(2038)).toBe("2038-04-25");
  });
});

describe("Hungary's public holidays, as its Labour Code lists them", () => {
  it("names the law and the day its text was in force", () => {
    expect(HU.law).toContain("102. § (1)");
    expect(new URL(HU.url).hostname).toBe("njt.jog.gov.hu");
    expect(HU.in_force_on).toBe("2026-11-14");
  });

  it("is twelve days in a year, the three around Christmas among them", () => {
    const y = holidaysOfYear(HU, 2027);
    expect(y.map((h) => `${h.date} ${h.key}`)).toEqual([
      "2027-01-01 new_year",
      "2027-03-15 march_15",
      "2027-03-26 good_friday",
      "2027-03-29 easter_monday",
      "2027-05-01 may_1",
      "2027-05-17 whit_monday",
      "2027-08-20 august_20",
      "2027-10-23 october_23",
      "2027-11-01 all_saints",
      "2027-12-24 december_24",
      "2027-12-25 december_25",
      "2027-12-26 december_26",
    ]);
  });

  it("moves the three that hang on Easter with it", () => {
    const y = holidaysOfYear(HU, 2026);
    expect(y.find((h) => h.key === "good_friday")?.date).toBe("2026-04-03");
    expect(y.find((h) => h.key === "easter_monday")?.date).toBe("2026-04-06");
    expect(y.find((h) => h.key === "whit_monday")?.date).toBe("2026-05-25");
  });
});

describe("the holidays between two days", () => {
  it("includes both ends and runs across the new year", () => {
    const out = publicHolidays("HU", "2026-12-24", "2027-01-01");
    expect(out.covered).toBe(true);
    if (!out.covered) return;
    expect(out.holidays.map((h) => h.date)).toEqual([
      "2026-12-24",
      "2026-12-25",
      "2026-12-26",
      "2027-01-01",
    ]);
    expect(out.calendar.country).toBe("HU");
  });

  it("takes the country in any case, and nothing when the window is empty", () => {
    expect(publicHolidays("hu", "2027-03-01", "2027-03-31").covered).toBe(true);
    const none = publicHolidays("HU", "2027-02-01", "2027-02-28");
    expect(none.covered && none.holidays).toEqual([]);
    const backwards = publicHolidays("HU", "2027-03-20", "2027-03-10");
    expect(backwards.covered && backwards.holidays).toEqual([]);
  });

  it("does not answer for a day before the text it read was in force", () => {
    // 23 October and 1 November 2026 fall before 14 November: not claimed either way.
    const out = publicHolidays("HU", "2026-10-01", "2026-12-31");
    expect(out.covered).toBe(true);
    if (!out.covered) return;
    expect(out.from).toBe("2026-11-14");
    expect(out.holidays.map((h) => h.date)).toEqual(["2026-12-24", "2026-12-25", "2026-12-26"]);
  });

  it("has no answer for a country with no calendar, and says which", () => {
    expect(publicHolidays("DE", "2027-01-01", "2027-12-31")).toEqual({
      covered: false,
      country: "DE",
    });
    expect(publicHolidays(null, "2027-01-01", "2027-12-31")).toEqual({
      covered: false,
      country: null,
    });
    expect(publicHolidays("  ", "2027-01-01", "2027-12-31")).toEqual({
      covered: false,
      country: null,
    });
  });
});

describe("a stretch of days, such as a delivery time", () => {
  const year = holidaysOfYear(HU, 2026).concat(holidaysOfYear(HU, 2027));

  it("finds the holidays inside it, the first day counted", () => {
    // Ten days from 18 December: the 18th to the 27th.
    expect(holidaysWithin(year, "2026-12-18", 10).map((h) => h.date)).toEqual([
      "2026-12-24",
      "2026-12-25",
      "2026-12-26",
    ]);
    // Seven days from the 18th end on the 24th: one of the three.
    expect(holidaysWithin(year, "2026-12-18", 7).map((h) => h.date)).toEqual(["2026-12-24"]);
    expect(holidaysWithin(year, "2026-12-18", 6)).toEqual([]);
  });

  it("is empty for no days at all", () => {
    expect(holidaysWithin(year, "2026-12-24", 0)).toEqual([]);
    expect(holidaysWithin(year, "2026-12-24", -3)).toEqual([]);
  });

  it("knows a holiday on a weekend closes nothing that was open", () => {
    // 26 December 2026 is a Saturday; the 24th and 25th are a Thursday and a Friday.
    expect(onAWorkingDay({ date: "2026-12-24", key: "december_24" })).toBe(true);
    expect(onAWorkingDay({ date: "2026-12-25", key: "december_25" })).toBe(true);
    expect(onAWorkingDay({ date: "2026-12-26", key: "december_26" })).toBe(false);
    expect(shiftDays("2026-12-31", 1)).toBe("2027-01-01");
  });
});
