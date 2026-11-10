// Figures and dates in the reader's language — L-1, rule 3 of
// TASKS-LANGUAGES.md: every number, amount and date is formatted through
// Intl, never typed into a translation. Pure and safe in the browser.
//
// English keeps the hand-written formatters' own output, so these are
// called only for the other languages (components/sheet/num.ts and the
// date helpers branch on the locale). Dates are calendar days in UTC, as
// they are everywhere in the app. Money arrives already in major units
// from integer minor units at its currency's exponent (rule 1); the
// currency is always named, and never converted.

import { currencyRow, formatMoney, moneyDigits } from "../core/currency-table";
import type { AppLocale } from "./locales";
import { intlTag } from "./locales";

const numberFormats = new Map<string, Intl.NumberFormat>();
const dateFormats = new Map<string, Intl.DateTimeFormat>();

function numberFormat(key: string, locale: AppLocale, options: Intl.NumberFormatOptions) {
  let f = numberFormats.get(key);
  if (!f) {
    f = new Intl.NumberFormat(intlTag(locale), options);
    numberFormats.set(key, f);
  }
  return f;
}

function dateFormat(key: string, locale: AppLocale, options: Intl.DateTimeFormatOptions) {
  let f = dateFormats.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(intlTag(locale), { ...options, timeZone: "UTC" });
    dateFormats.set(key, f);
  }
  return f;
}

/** A plain number at fixed decimals, grouped the way the language groups it. */
export function intlNumber(n: number, decimals: number, locale: AppLocale): string {
  return numberFormat(`n|${locale}|${decimals}`, locale, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(n);
}

/** An amount in major units with its currency, the way the language writes money. */
export function intlMoney(
  major: number,
  currency: string,
  decimals: number,
  locale: AppLocale,
): string {
  return numberFormat(`m|${locale}|${currency}|${decimals}`, locale, {
    style: "currency",
    currency,
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(major);
}

const dayOf = (day: string) => new Date(`${day.slice(0, 10)}T00:00:00Z`);

// English months as the report has always printed them: three letters,
// "Sep" too (en-GB's Intl writes "Sept", which then sits beside "Sep").
const EN_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** "6 Nov" in the language: a day and a short month ("6. Nov.", "11月6日"). Not a day: as given. */
export function dayMonth(day: string, locale: AppLocale): string {
  const d = dayOf(day);
  // Intl throws on an invalid date; every language leaves it as written, as English does.
  if (Number.isNaN(d.getTime())) return day;
  if (locale === "en") return `${d.getUTCDate()} ${EN_MONTHS[d.getUTCMonth()]}`;
  return dateFormat(`dm|${locale}`, locale, { day: "numeric", month: "short" }).format(d);
}

/** "6 Nov 2026" in the language. Not a day: as given. */
export function dayMonthYear(day: string, locale: AppLocale): string {
  const d = dayOf(day);
  if (Number.isNaN(d.getTime())) return day;
  if (locale === "en") return `${dayMonth(day, locale)} ${d.getUTCFullYear()}`;
  return dateFormat(`dmy|${locale}`, locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(d);
}

/** "November 2026" in the language. Not a day: as given. */
export function monthYear(day: string, locale: AppLocale): string {
  const d = dayOf(day);
  if (Number.isNaN(d.getTime())) return day;
  return dateFormat(`my|${locale}`, locale, { month: "long", year: "numeric" }).format(d);
}

/**
 * Money for a reader — the multi-market spec §A.2, hard rules 1 and 3. The
 * one way an amount becomes words on any surface: rounding and decimals
 * from the currency table (HUF: whole forints), and the presentation the
 * table names — the currency's own ("35 413 Ft" whoever reads it) or the
 * reader's language for currencies written many ways (EUR). Intl is handed
 * the exact decimal string, never a divided float. `whole` rounds to whole
 * major units, for headline figures.
 */
export function presentMoney(
  m: { amount_minor: number; currency: string },
  locale: AppLocale,
  opts: { whole?: boolean } = {},
): string {
  const row = currencyRow(m.currency);
  if (row.presentation === "home" || locale === "en") return formatMoney(m, opts);
  const d = moneyDigits(m, opts);
  const exact = `${d.negative ? "-" : ""}${d.whole}${d.fraction ? `.${d.fraction}` : ""}`;
  const f = numberFormat(`pm|${locale}|${m.currency}|${d.decimals}`, locale, {
    style: "currency",
    currency: m.currency,
    minimumFractionDigits: d.decimals,
    maximumFractionDigits: d.decimals,
  });
  // A decimal string is formatted exactly (ECMA-402 2023); no float in between.
  return f.format(exact as unknown as number);
}

/** A plain amount of money's major units for a reader, without its symbol: "35 413", "1,234.56". */
export function presentAmount(
  m: { amount_minor: number; currency: string },
  locale: AppLocale,
  opts: { whole?: boolean } = {},
): string {
  const d = moneyDigits(m, opts);
  const exact = `${d.negative ? "-" : ""}${d.whole}${d.fraction ? `.${d.fraction}` : ""}`;
  const row = currencyRow(m.currency);
  if (row.presentation === "home") {
    const grouped = d.whole.replace(/\B(?=(\d{3})+(?!\d))/g, row.thousands_sep);
    return `${d.negative ? "−" : ""}${grouped}${d.fraction ? row.decimal_sep + d.fraction : ""}`;
  }
  return numberFormat(`pa|${locale}|${d.decimals}`, locale, {
    minimumFractionDigits: d.decimals,
    maximumFractionDigits: d.decimals,
  }).format(exact as unknown as number);
}
