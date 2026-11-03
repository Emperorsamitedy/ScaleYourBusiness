// The sentences lib/simulate builds from the numbers, in the reader's
// language — L-4b of TASKS-LANGUAGES.md. Every builder takes a `SimText`
// (a translator over the "simulateWords" catalogue and the locale its
// figures go out in) as its last, optional parameter, English by default,
// so every existing caller still says exactly what it said before.
//
// The screens run the arithmetic in the browser and pass their own
// translator; the routes pass the request's (lib/i18n/request-words). What
// is stored — a proposal's simulated scenario, the decision log — is built
// with the English default, never these words (rules 4 and 7).
//
// Client-safe: no server import here, since model.ts runs on either side.

import { num } from "../../components/sheet/num";
import { dayMonthYear } from "../i18n/format";
import type { AppLocale } from "../i18n/locales";
import { intlTag } from "../i18n/locales";
import type { Tr } from "../i18n/tr";
import { englishTr } from "../i18n/tr";

/** The catalogue namespace the simulator's sentences live in. */
export const SIM_WORDS = "simulateWords";

/** A translator over "simulateWords", and the locale the figures go out in. */
export interface SimText {
  tr: Tr;
  locale: AppLocale;
}

/** English: the default every sentence builder here takes. */
export function englishSimText(): SimText {
  return { tr: englishTr(SIM_WORDS), locale: "en" };
}

/** A translator scoped to one section of the catalogue ("model", "pricing" …). */
export function section(w: SimText, prefix: string): Tr {
  return (key, values) => w.tr(`${prefix}.${key}`, values);
}

/** A whole count the code printed bare ("3", "1000"): bare in English, the language's own elsewhere. */
export function int(n: number, locale: AppLocale): string {
  return locale === "en" ? String(n) : num(n, 0, locale);
}

/** A day the code printed as ISO: ISO in English, as before; the language's own date elsewhere. */
export function isoDay(day: string, locale: AppLocale): string {
  return locale === "en" || !/^\d{4}-\d{2}-\d{2}/.test(day) ? day : dayMonthYear(day, locale);
}

/** A whole percent from a whole number of points: "20%"; in another language, its own. */
export function wholePct(points: number, locale: AppLocale): string {
  if (locale === "en") return `${points}%`;
  return new Intl.NumberFormat(intlTag(locale), {
    style: "percent",
    maximumFractionDigits: 0,
  }).format(points / 100);
}

/** Percentage points at one decimal: 42.5 → "42.5%"; in another language, its own. */
export function pointsPct(points: number, locale: AppLocale): string {
  if (locale === "en") return `${num(points, 1)}%`;
  return new Intl.NumberFormat(intlTag(locale), {
    style: "percent",
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(points / 100);
}

/** A short list joined the language's way: English "EUR and HUF" exactly as before. */
export function andList(items: readonly string[], locale: AppLocale): string {
  if (locale === "en") return items.join(" and ");
  return new Intl.ListFormat(intlTag(locale), { type: "conjunction" }).format(items);
}
