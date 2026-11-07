// The charts' sentences in the reader's language — L-4b of
// TASKS-LANGUAGES.md. lib/charts builds its sentences from data (the
// headline, the summary, the formulas, the reasons, the event labels);
// their words are the "chartsWords" catalogue, and every figure and date
// in them is formatted here in the reader's locale, never typed into a
// message. English is the default everywhere, and what it prints is
// exactly what the code printed before.
//
// Pure and safe in the browser: the market chart's summary and table are
// built on the client, from the candles it buckets.

import type { Words } from "../i18n/request-words";
import type { AppLocale } from "../i18n/locales";
import { intlTag } from "../i18n/locales";
import { dayMonthYear } from "../i18n/format";
import { englishTr } from "../i18n/tr";
import { num } from "../../components/sheet/num";

export type { Words };

/** The catalogue namespace of the charts' sentences. */
export const CHARTS_WORDS = "chartsWords";

/** English over "chartsWords": the default every sentence builder in lib/charts takes. */
export function englishChartWords(): Words {
  return { tr: englishTr(CHARTS_WORDS), locale: "en" };
}

/** A calendar day inside a sentence, in the language's own date ("5 Oct 2026"). */
export function sentenceDay(day: string, locale: AppLocale): string {
  return dayMonthYear(day, locale);
}

/** A whole percentage: "41%" in English, the language's own ("41 %") elsewhere. */
export function percentText(pct: number, locale: AppLocale): string {
  if (locale === "en") return `${pct}%`;
  return new Intl.NumberFormat(intlTag(locale), {
    style: "percent",
    maximumFractionDigits: 0,
  }).format(pct / 100);
}

/** A constant from the code (RUN_DAYS, MAD_K) inside a sentence: as the code wrote it in English. */
export function constText(n: number, locale: AppLocale): string {
  if (locale === "en") return String(n);
  return num(n, Number.isInteger(n) ? 0 : 1, locale);
}

/** The price series' code in a sentence's select: "revenue", "bookingRevenue", or "other" (the noun is passed). */
export function priceCode(metric: string | undefined): string {
  return metric === "revenue.daily"
    ? "revenue"
    : metric === "booking_revenue.daily"
      ? "bookingRevenue"
      : "other";
}

/** A sentence's first letter capitalised the way the reader's language does it (Chinese has no case). */
export function capitalFirst(s: string, locale: AppLocale): string {
  return locale === "en"
    ? s.charAt(0).toUpperCase() + s.slice(1)
    : s.charAt(0).toLocaleUpperCase(intlTag(locale)) + s.slice(1);
}
