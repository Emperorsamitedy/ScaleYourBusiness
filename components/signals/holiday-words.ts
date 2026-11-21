// Outside signals in words: a public holiday as a reader meets it, for the
// two screens that show one beside a figure (the cash forecast's weeks, a
// stock item's delivery time). Pure.
//
// The words are the "signals" catalogue through a translator, English by
// default; the day is written the way the reader's language writes days.
// A line always names the day and the holiday, so nobody has to know that
// 23 October is one.

import { dayMonthYear } from "../../lib/i18n/format";
import type { AppLocale } from "../../lib/i18n/locales";
import { intlTag } from "../../lib/i18n/locales";
import type { Tr } from "../../lib/i18n/tr";
import { englishTr } from "../../lib/i18n/tr";
import type { HolidayDay, OutsideView } from "../../lib/signals/view";
import { dayLabel } from "../../lib/summary/week";

const EN = (): Tr => englishTr("signals");

/** "A, B and C" as the reader's language joins a list. */
function andList(parts: readonly string[], locale: AppLocale): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return new Intl.ListFormat(intlTag(locale), { type: "conjunction" }).format(parts);
}

/** A country's name in the reader's language, from its code ("HU" reads "Hungary"). */
export function regionName(code: string, locale: AppLocale = "en"): string {
  try {
    return new Intl.DisplayNames(intlTag(locale), { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}

/**
 * A calendar day with its weekday, "Thu 24 Dec". dayLabel reads an instant,
 * and takes the "-24" that ends a bare day for a timezone offset: so the day
 * is handed over as its own midnight in UTC.
 */
function weekdayLabel(day: string, locale: AppLocale): string {
  return dayLabel(`${day.slice(0, 10)}T00:00:00Z`, locale);
}

/** "Thu 24 Dec (Christmas Eve)": the day, then what it is. */
export function holidayWords(day: HolidayDay, tr: Tr = EN(), locale: AppLocale = "en"): string {
  return tr("day", { day: weekdayLabel(day.date, locale), name: tr(`holiday.${day.key}`) });
}

/** Several of them as one list. */
export function holidaysList(
  days: readonly HolidayDay[],
  tr: Tr = EN(),
  locale: AppLocale = "en",
): string {
  return andList(
    days.map((d) => holidayWords(d, tr, locale)),
    locale,
  );
}

/** The line beside one week of the cash forecast; null when the week has none. */
export function weekHolidayLine(
  days: readonly HolidayDay[],
  tr: Tr = EN(),
  locale: AppLocale = "en",
): string | null {
  if (days.length === 0) return null;
  return tr("cash.week", { count: days.length, days: holidaysList(days, tr, locale) });
}

/**
 * The line under the cash forecast's weeks: how many public holidays the
 * weeks hold and which, or that there are none, or that this country has no
 * calendar here yet. Null when the business's country is not on the fact
 * sheet: nothing is said about a country nobody named.
 */
export function cashHolidaySummary(
  view: OutsideView | null,
  countryName: string | null,
  tr: Tr = EN(),
  locale: AppLocale = "en",
): string | null {
  if (!view) return null;
  if (!view.holidays.covered) {
    return view.country === null ? null : tr("uncovered", { country: countryName ?? view.country });
  }
  const days = view.holidays.days;
  return days.length === 0
    ? tr("cash.none")
    : tr("cash.summary", { count: days.length, days: holidaysList(days, tr, locale) });
}

/** The line beside a delivery time that has public holidays inside it; null when it has none. */
export function leadHolidayLine(
  days: readonly HolidayDay[],
  tr: Tr = EN(),
  locale: AppLocale = "en",
): string | null {
  if (days.length === 0) return null;
  return tr("stock.inLead", { count: days.length, days: holidaysList(days, tr, locale) });
}

/** The same in a few words, for a table's cell; the whole line is its title. */
export function leadHolidayShort(days: readonly HolidayDay[], tr: Tr = EN()): string | null {
  return days.length === 0 ? null : tr("stock.short", { count: days.length });
}

/** Where the days come from: the law, and the day its text was in force. */
export function holidaySource(
  view: OutsideView | null,
  tr: Tr = EN(),
  locale: AppLocale = "en",
): string | null {
  if (!view || !view.holidays.covered) return null;
  const s = view.holidays.source;
  // The law in the reader's words, with its own citation inside them. Every country
  // that has a calendar has this line: holiday-words.test.ts holds the two together.
  // The day carries its year: a text in force "on 14 Nov" says nothing a year on.
  return tr("source", {
    law: tr(`law.${s.country}`, { law: s.law }),
    day: dayMonthYear(s.in_force_on, locale),
  });
}
