// The stock sentences' words and figures — L-4b of TASKS-LANGUAGES.md.
//
// Every sentence lib/stock builds from data (a reason, a warning, the
// arithmetic, the sources line, an option's label) takes `w: Words`, the
// "stockWords" catalogue in English by default, as its last parameter. The
// /api/stock handler passes the request's own words; everything that is
// stored or logged (proposals, the decision log, the watch log, forecast
// claims) is built with the default and stays English (rules 4 and 7).
//
// The figures go into a message as strings, formatted here in the
// reader's language. In English each helper prints exactly what the code
// printed before L-4b ("1234", "14.9", "2026-11-02", "2 Nov", "€2,802.80").

import { format, money } from "../core/money";
import { dayMonth, dayMonthYear } from "../i18n/format";
import type { AppLocale } from "../i18n/locales";
import { intlTag } from "../i18n/locales";
import type { Words } from "../i18n/request-words";
import { englishTr } from "../i18n/tr";
import { times } from "../seasons/forecast";
import { moneyExact, num } from "../../components/sheet/num";

export type { Words };

/** The catalogue namespace of every stock sentence built from data. */
export const STOCK_WORDS = "stockWords";

/** English: the default every sentence builder takes. */
export function englishStock(): Words {
  return { tr: englishTr(STOCK_WORDS), locale: "en" };
}

/** A whole number: "1234" in English, as the sentences always printed it; grouped elsewhere. */
export function int(n: number, locale: AppLocale): string {
  return locale === "en" ? String(n) : num(n, 0, locale);
}

/** One decimal, "14.9". */
export function dec1(x: number, locale: AppLocale): string {
  const r = Math.round(x * 10) / 10;
  return locale === "en" ? r.toFixed(1) : num(r, 1, locale);
}

/** Two decimals, "1.45". */
export function dec2(x: number, locale: AppLocale): string {
  return locale === "en" ? x.toFixed(2) : num(x, 2, locale);
}

/** A day the sentences name, in the reader's own date ("29 Sep 2026"). */
export function isoDay(day: string, locale: AppLocale): string {
  return dayMonthYear(day, locale);
}

/** "2 Nov" — a short date, in UTC (the series' own dates). */
export function shortDay(day: string, locale: AppLocale): string {
  if (locale !== "en") return dayMonth(day, locale);
  return new Date(`${day}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

/** Money at its currency's full decimals: "€2,802.80" (rule 1: the business's currency, never converted). */
export function exactMoney(minor: number, currency: string, locale: AppLocale): string {
  return locale === "en" ? format(money(minor, currency)) : moneyExact(minor, currency, locale);
}

/** A share as a whole percent: 0.25 → "25%". */
export function pct(share: number, locale: AppLocale): string {
  const whole = Math.round(share * 100);
  return wholePct(whole, locale);
}

/** A whole percent: 12 → "12%". */
export function wholePct(whole: number, locale: AppLocale): string {
  if (locale === "en") return `${whole}%`;
  return new Intl.NumberFormat(intlTag(locale), {
    style: "percent",
    maximumFractionDigits: 0,
  }).format(whole / 100);
}

/** A multiple, "1.4×". */
export function timesIn(x: number, locale: AppLocale): string {
  return locale === "en" ? times(x) : `${num(Math.round(x * 10) / 10, 1, locale)}×`;
}

/** "A or B or C" in English, as it always read; the language's own "or" list elsewhere. */
export function orList(names: readonly string[], locale: AppLocale): string {
  if (locale === "en") return names.join(" or ");
  return new Intl.ListFormat(intlTag(locale), { type: "disjunction" }).format(names);
}

/** A day count for a "{count, plural, one {{days} day} other {{days} days}}" message. */
export function dayCount(n: number, locale: AppLocale): { count: number; days: string } {
  return { count: n, days: int(n, locale) };
}
