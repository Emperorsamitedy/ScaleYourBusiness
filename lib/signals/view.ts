// Outside signals: what a screen is handed. Pure, and safe to import in the
// browser (./holidays is arithmetic over a list in the law).
//
// One shape for both screens that show the signal today: the cash forecast's
// weeks and a stock item's delivery time. It carries the days and the law
// they come from, or says plainly that there is no calendar for the
// business's country, or that the country is not on the fact sheet. It never
// carries a figure, and nothing here changes one.

import type { HolidayKey, PublicHoliday } from "./holidays";
import { holidaysWithin, onAWorkingDay, publicHolidays, shiftDays } from "./holidays";

export interface HolidayDay {
  /** YYYY-MM-DD. */
  date: string;
  key: HolidayKey;
  /** Monday to Friday. A holiday on a weekend closes nothing that was open. */
  working_day: boolean;
}

export interface OutsideView {
  /** The business's country as a code, or null when the fact sheet does not hold it. */
  country: string | null;
  /** The days looked at, both included. */
  from: string;
  to: string;
  holidays:
    | {
        covered: true;
        /** The law the list is in, where it was read, and from which day it answers. */
        source: { country: string; law: string; url: string; in_force_on: string; read_on: string };
        days: HolidayDay[];
      }
    /** No calendar for this country (or no country): nothing is shown as if there were none. */
    | { covered: false };
}

/** The longest stretch a screen may ask about: a year and a day. */
export const OUTSIDE_MAX_DAYS = 366;

/** How many days two days span, both included: 24 to 26 December is three. */
export function daySpan(from: string, to: string): number {
  const ms =
    Date.parse(`${to.slice(0, 10)}T00:00:00Z`) - Date.parse(`${from.slice(0, 10)}T00:00:00Z`);
  return Math.max(1, Math.round(ms / 86_400_000) + 1);
}

/** The signal for one country over `days` days starting on `from` (that day included). */
export function outsideView(country: string | null, from: string, days: number): OutsideView {
  const start = from.slice(0, 10);
  const span = Math.min(OUTSIDE_MAX_DAYS, Math.max(1, Math.ceil(days)));
  const end = shiftDays(start, span - 1);
  const answer = publicHolidays(country, start, end);
  if (!answer.covered) {
    return { country: answer.country, from: start, to: end, holidays: { covered: false } };
  }
  const { calendar } = answer;
  return {
    country: calendar.country,
    from: start,
    to: end,
    holidays: {
      covered: true,
      source: {
        country: calendar.country,
        law: calendar.law,
        url: calendar.url,
        in_force_on: calendar.in_force_on,
        read_on: calendar.read_on,
      },
      days: answer.holidays.map((h) => ({ ...h, working_day: onAWorkingDay(h) })),
    },
  };
}

const asHolidays = (days: readonly HolidayDay[]): PublicHoliday[] =>
  days.map((d) => ({ date: d.date, key: d.key }));

/** The holidays of the view that fall between two days, both included. */
export function holidaysBetween(view: OutsideView | null, from: string, to: string): HolidayDay[] {
  if (!view || !view.holidays.covered) return [];
  return view.holidays.days.filter((d) => d.date >= from.slice(0, 10) && d.date <= to.slice(0, 10));
}

/**
 * The holidays of the view inside a stretch of `days` days from `from`, such
 * as a delivery time counted from today. Only the ones on a working day: a
 * supplier closed on a Saturday anyway loses nothing to a holiday on it.
 */
export function holidaysInStretch(
  view: OutsideView | null,
  from: string,
  days: number,
): HolidayDay[] {
  if (!view || !view.holidays.covered) return [];
  const inside = new Set(
    holidaysWithin(asHolidays(view.holidays.days), from, days).map((h) => h.date),
  );
  return view.holidays.days.filter((d) => inside.has(d.date) && d.working_day);
}
