// Outside signals: public holidays. Pure.
//
// The marketing teammate's point (recorded 2026-11-18): nothing in ScaleX
// reads what happens outside the business: holidays, weather, prices. This
// is the first such signal, and the plainest: the days a country's law makes
// public holidays. A supplier does not deliver on them and a bank or a
// payout provider does not move money on them, so they matter to a delivery
// time and to the week a payment lands in.
//
// WORKED OUT BY RULE, NOT FETCHED. A public holiday is set by law: fixed
// dates, and a few that move with Easter. So the calendar here is the law's
// own list and the arithmetic of Easter, with the law named beside it
// (rules 2 and 6: every signal says where it comes from and how it was
// worked out). No request is made, no data set is copied, and nothing has a
// licence to keep (specs/public-holidays-v1.md says which sources were
// turned down for theirs).
//
// ONE COUNTRY, AND SAYING SO. Hungary's list was read on the National
// Legislation Database on 2026-11-21 (the text in force on 2026-11-14). A
// country with no calendar here gets no signal and is told there is none
// (rule 5: a gap is said, never filled with a guess). A calendar is also
// only claimed from the day its text was in force: the list changes (24
// December joined Hungary's), so a day before that is not answered for.
//
// NEVER BLENDED. A holiday is shown beside a forecast, labelled, and changes
// no figure in it. Whether a supplier's "10 days" are calendar days, or how
// a payout provider counts a holiday, is the owner's to know; the signal
// only says the day is there.

const DAY_MS = 86_400_000;

export type HolidayKey =
  | "new_year"
  | "march_15"
  | "good_friday"
  | "easter_monday"
  | "may_1"
  | "whit_monday"
  | "august_20"
  | "october_23"
  | "all_saints"
  | "december_24"
  | "december_25"
  | "december_26";

export interface HolidayCalendar {
  /** ISO 3166-1 alpha-2. */
  country: string;
  /** The law the list is in, as it is cited. */
  law: string;
  /** Where the text was read. */
  url: string;
  /** The day the text read was in force: the calendar answers from this day on. */
  in_force_on: string;
  /** The day it was read. */
  read_on: string;
  /** Month and day, each year. */
  fixed: readonly (readonly [month: number, day: number, key: HolidayKey])[];
  /** Days from Easter Sunday, each year. */
  movable: readonly (readonly [offset: number, key: HolidayKey])[];
}

/**
 * Hungary: the Labour Code (2012. évi I. törvény) 102. § (1), as in force on
 * 2026-11-14: "Munkaszüneti nap: január 1., március 15., nagypéntek,
 * húsvéthétfő, május 1., pünkösdhétfő, augusztus 20., október 23., november
 * 1. és december 24–26." The working days a minister moves by decree each
 * year under 102. § (5) are not public holidays and are not here. Nor are
 * Easter Sunday and Whit Sunday: they are not on the list, and 102. § (4)
 * only applies the rostering rules to them.
 *
 * The page's own footnote says this wording was set by 2026. évi LXXII.
 * törvény 3. §. What that Act changed was not read, which is one more reason
 * the calendar answers only from the day of the text read
 * (specs/public-holidays-v1.md).
 */
const HU: HolidayCalendar = {
  country: "HU",
  law: "2012. évi I. törvény, 102. § (1)",
  url: "https://njt.jog.gov.hu/jogszabaly/2012-1-00-00",
  in_force_on: "2026-11-14",
  read_on: "2026-11-21",
  fixed: [
    [1, 1, "new_year"],
    [3, 15, "march_15"],
    [5, 1, "may_1"],
    [8, 20, "august_20"],
    [10, 23, "october_23"],
    [11, 1, "all_saints"],
    [12, 24, "december_24"],
    [12, 25, "december_25"],
    [12, 26, "december_26"],
  ],
  movable: [
    [-2, "good_friday"],
    [1, "easter_monday"],
    // Whit Sunday is the fiftieth day of Easter, 49 days after Easter Sunday; its Monday is 50.
    [50, "whit_monday"],
  ],
};

export const HOLIDAY_CALENDARS: Readonly<Record<string, HolidayCalendar>> = { HU };

export interface PublicHoliday {
  /** YYYY-MM-DD. */
  date: string;
  key: HolidayKey;
}

const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const dayMs = (day: string): number => Date.parse(`${day.slice(0, 10)}T00:00:00Z`);

/** `day` moved by a number of days, as YYYY-MM-DD. */
export function shiftDays(day: string, by: number): string {
  return iso(dayMs(day) + by * DAY_MS);
}

/**
 * Easter Sunday in the Gregorian calendar (the "anonymous" computus, as in
 * Meeus). Valid for any year the Gregorian calendar holds; tested against
 * the published dates.
 */
export function easterSunday(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return iso(Date.UTC(year, month - 1, day));
}

/** Every public holiday of one calendar year, in order. */
export function holidaysOfYear(calendar: HolidayCalendar, year: number): PublicHoliday[] {
  const easter = easterSunday(year);
  const days: PublicHoliday[] = [
    ...calendar.fixed.map(([month, day, key]) => ({
      date: iso(Date.UTC(year, month - 1, day)),
      key,
    })),
    ...calendar.movable.map(([offset, key]) => ({ date: shiftDays(easter, offset), key })),
  ];
  return days.sort((x, y) => x.date.localeCompare(y.date));
}

export type HolidayAnswer =
  /** The country has a calendar here: its holidays from `from` to `to`, both days included. */
  | {
      covered: true;
      calendar: HolidayCalendar;
      from: string;
      to: string;
      holidays: PublicHoliday[];
    }
  /** No calendar for the country, or none said: nothing is guessed. */
  | { covered: false; country: string | null };

/**
 * The public holidays of a country between two days, both included. The
 * window is cut to start no earlier than the day the law's text was in
 * force: the calendar does not answer for a day before it.
 */
export function publicHolidays(country: string | null, from: string, to: string): HolidayAnswer {
  const code = (country ?? "").trim().toUpperCase();
  const calendar = HOLIDAY_CALENDARS[code];
  if (!calendar) return { covered: false, country: code === "" ? null : code };
  const start = from < calendar.in_force_on ? calendar.in_force_on : from.slice(0, 10);
  const end = to.slice(0, 10);
  const holidays: PublicHoliday[] = [];
  if (start <= end) {
    for (let year = Number(start.slice(0, 4)); year <= Number(end.slice(0, 4)); year++) {
      for (const h of holidaysOfYear(calendar, year)) {
        if (h.date >= start && h.date <= end) holidays.push(h);
      }
    }
  }
  return { covered: true, calendar, from: start, to: end, holidays };
}

/** The holidays that fall in a stretch of `days` days starting on `from` (that day included). */
export function holidaysWithin(
  holidays: readonly PublicHoliday[],
  from: string,
  days: number,
): PublicHoliday[] {
  if (!(days > 0)) return [];
  const last = shiftDays(from, Math.ceil(days) - 1);
  return holidays.filter((h) => h.date >= from.slice(0, 10) && h.date <= last);
}

/** Monday to Friday: a holiday on a weekend closes nothing that was open. */
export function onAWorkingDay(holiday: PublicHoliday): boolean {
  const weekday = new Date(dayMs(holiday.date)).getUTCDay();
  return weekday >= 1 && weekday <= 5;
}
