// Outside signals in words: what a reader is told about a public holiday
// beside a week of the cash forecast and beside a delivery time. English is
// pinned word for word; another language is checked for its own words (the
// day itself is the language's own way of writing a day, left to Intl). And
// the words keep up with the calendars: every country that has one has its
// law named, and every holiday in one has a name, in all seven languages.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { trFor } from "../../lib/i18n/server-tr";
import { LOCALES } from "../../lib/i18n/locales";
import { HOLIDAY_CALENDARS } from "../../lib/signals/holidays";
import type { HolidayDay } from "../../lib/signals/view";
import { outsideView } from "../../lib/signals/view";
import {
  cashHolidaySummary,
  holidaySource,
  holidayWords,
  leadHolidayLine,
  leadHolidayShort,
  regionName,
  weekHolidayLine,
} from "./holiday-words";

const EVE: HolidayDay = { date: "2026-12-24", key: "december_24", working_day: true };
const CHRISTMAS: HolidayDay = { date: "2026-12-25", key: "december_25", working_day: true };
const SECOND: HolidayDay = { date: "2026-12-26", key: "december_26", working_day: false };
const NEW_YEAR: HolidayDay = { date: "2027-01-01", key: "new_year", working_day: true };

// Thirteen weeks from Monday 23 November 2026, as the cash forecast asks.
const WEEKS = outsideView("HU", "2026-11-23", 91);

describe("a public holiday in English", () => {
  it("names the day and what it is", () => {
    expect(holidayWords(EVE)).toBe("Thu 24 Dec (Christmas Eve)");
    expect(holidayWords(NEW_YEAR)).toBe("Fri 1 Jan (New Year's Day)");
  });

  it("beside a week: one, or several as a list", () => {
    expect(weekHolidayLine([])).toBeNull();
    expect(weekHolidayLine([NEW_YEAR])).toBe("Public holiday: Fri 1 Jan (New Year's Day)");
    expect(weekHolidayLine([EVE, CHRISTMAS, SECOND])).toBe(
      "Public holidays: Thu 24 Dec (Christmas Eve), Fri 25 Dec (Christmas Day) and Sat 26 Dec (Second day of Christmas)",
    );
  });

  it("under the weeks: how many and which, or that there are none", () => {
    expect(cashHolidaySummary(WEEKS, "Hungary")).toBe(
      "4 public holidays in these weeks: Thu 24 Dec (Christmas Eve), Fri 25 Dec (Christmas Day), Sat 26 Dec (Second day of Christmas) and Fri 1 Jan (New Year's Day).",
    );
    expect(cashHolidaySummary(outsideView("HU", "2026-11-23", 7), "Hungary")).toBe(
      "No public holiday falls in these weeks.",
    );
    expect(cashHolidaySummary(outsideView("HU", "2026-12-28", 7), "Hungary")).toBe(
      "1 public holiday in these weeks: Fri 1 Jan (New Year's Day).",
    );
  });

  it("says a country has no calendar here, and says nothing of a country nobody named", () => {
    const germany = outsideView("DE", "2026-11-23", 91);
    expect(cashHolidaySummary(germany, regionName("DE"))).toBe(
      "ScaleX has no public holiday calendar for Germany yet, so none is shown.",
    );
    // No name to hand: the code stands in, never a blank.
    expect(cashHolidaySummary(germany, null)).toBe(
      "ScaleX has no public holiday calendar for DE yet, so none is shown.",
    );
    expect(cashHolidaySummary(outsideView(null, "2026-11-23", 91), null)).toBeNull();
    expect(cashHolidaySummary(null, null)).toBeNull();
  });

  it("beside a delivery time: in full, and in a few words for a table", () => {
    expect(leadHolidayLine([])).toBeNull();
    expect(leadHolidayShort([])).toBeNull();
    expect(leadHolidayLine([EVE, CHRISTMAS])).toBe(
      "2 public holidays fall inside this delivery time: Thu 24 Dec (Christmas Eve) and Fri 25 Dec (Christmas Day). Not counted in it.",
    );
    expect(leadHolidayLine([NEW_YEAR])).toBe(
      "1 public holiday falls inside this delivery time: Fri 1 Jan (New Year's Day). Not counted in it.",
    );
    expect(leadHolidayShort([EVE, CHRISTMAS])).toBe("2 public holidays inside");
    expect(leadHolidayShort([NEW_YEAR])).toBe("1 public holiday inside");
  });

  it("says where the days come from: the law as cited, and the day its text was in force, with the year", () => {
    expect(holidaySource(WEEKS)).toBe(
      "Public holidays: Hungary's Labour Code (2012. évi I. törvény, 102. § (1)), as in force on 14 Nov 2026.",
    );
    expect(holidaySource(outsideView("DE", "2026-11-23", 91))).toBeNull();
    expect(holidaySource(null)).toBeNull();
  });

  it("never states a figure of the forecast or of the stock: only days and names", () => {
    const said = [
      cashHolidaySummary(WEEKS, "Hungary"),
      weekHolidayLine([EVE, CHRISTMAS, SECOND]),
      leadHolidayLine([EVE, CHRISTMAS]),
      holidaySource(WEEKS),
    ].join(" ");
    expect(said).not.toMatch(/[€$£]|\bHUF\b|\bFt\b|%/);
  });
});

describe("the same in the reader's language", () => {
  const hu = trFor("hu-HU", "signals");

  it("uses the language's own words and its own name for the country", () => {
    expect(regionName("HU", "hu-HU")).toBe("Magyarország");
    expect(regionName("DE", "hu-HU")).toBe("Németország");
    const week = weekHolidayLine([NEW_YEAR], hu, "hu-HU") ?? "";
    expect(week.startsWith("Munkaszüneti nap: ")).toBe(true);
    expect(week).toContain("(újév)");
    expect(week).not.toContain("New Year");
    const several = weekHolidayLine([EVE, CHRISTMAS], hu, "hu-HU") ?? "";
    expect(several.startsWith("Munkaszüneti napok: ")).toBe(true);
    expect(several).toContain("(szenteste)");
    expect(several).toContain(" és ");
    expect(
      cashHolidaySummary(outsideView("DE", "2026-11-23", 91), "Németország", hu, "hu-HU"),
    ).toBe(
      "A ScaleX-nek még nincs munkaszünetinap-naptára ehhez az országhoz: Németország, ezért egyet sem mutat.",
    );
  });

  it("keeps the law's own citation inside the reader's words", () => {
    const source = holidaySource(WEEKS, hu, "hu-HU") ?? "";
    expect(source).toContain("a magyar munka törvénykönyve (2012. évi I. törvény, 102. § (1))");
    expect(source).toContain("2026");
  });

  it("falls back to the code for a region Intl cannot name", () => {
    expect(regionName("not a code")).toBe("not a code");
  });
});

describe("the words keep up with the calendars", () => {
  const catalogue = (locale: string) =>
    JSON.parse(readFileSync(path.join(process.cwd(), "messages", `${locale}.json`), "utf8")) as {
      signals: { law: Record<string, string>; holiday: Record<string, string> };
    };

  it("names the law of every country that has a calendar, in every language", () => {
    for (const locale of LOCALES) {
      const { law } = catalogue(locale).signals;
      for (const code of Object.keys(HOLIDAY_CALENDARS)) {
        expect(law[code], `${locale} signals.law.${code}`).toBeTruthy();
        // The citation is the law's own, set inside the words: never retyped per language.
        expect(law[code], `${locale} signals.law.${code}`).toContain("{law}");
      }
    }
  });

  it("names every holiday a calendar holds, in every language", () => {
    const keys = new Set<string>();
    for (const calendar of Object.values(HOLIDAY_CALENDARS)) {
      for (const [, , key] of calendar.fixed) keys.add(key);
      for (const [, key] of calendar.movable) keys.add(key);
    }
    expect(keys.size).toBeGreaterThan(0);
    for (const locale of LOCALES) {
      const { holiday } = catalogue(locale).signals;
      for (const key of keys) expect(holiday[key], `${locale} signals.holiday.${key}`).toBeTruthy();
    }
  });
});
