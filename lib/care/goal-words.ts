// The words of measurable goals — L-4b of TASKS-LANGUAGES.md. The weekly
// check's arithmetic and a baseline's "why not yet" are "goalsWords"
// messages; the figures in them are formatted here in the reader's locale
// with the goal's own currency (rule 1, never converted). English keeps
// exactly what the check always wrote: ISO dates, unformatted counts, and
// money through lib/core/money's `format`.
//
// What the weekly check stores in the watch log stays English (rule 7):
// lib/care/progress builds that with the default here, and /api/care words
// the same check again for the screen from the figures it stored.

import { num } from "../../components/sheet/num";
import { format, money } from "../core/money";
import { dayMonthYear } from "../i18n/format";
import { intlTag } from "../i18n/locales";
import type { Words } from "../i18n/request-words";
import { englishTr } from "../i18n/tr";

/** The namespace of the goal sentences lib/care builds. */
export const GOAL_WORDS = "goalsWords";

/** English over GOAL_WORDS: the default every sentence here takes. */
export const goalEnglish = (): Words => ({ tr: englishTr(GOAL_WORDS), locale: "en" });

/** A goal's metric in words ("goalsWords.metric.<metric>"): revenue, orders, website visits. */
export const metricWords = (metric: string, w: Words): string => w.tr(`metric.${metric}`);

/** A per-30-days level: money in the goal's currency, or a whole count. */
export function levelText(perThirtyDays: number, currency: string | null, w: Words): string {
  const n = Math.round(perThirtyDays);
  if (currency !== null)
    return format(money(n, currency), w.locale === "en" ? "en" : intlTag(w.locale));
  return w.locale === "en" ? String(n) : num(n, 0, w.locale);
}

/** A count: English as the check wrote it (no grouping); the language's own elsewhere. */
export const countText = (n: number, w: Words): string =>
  w.locale === "en" ? String(n) : num(n, 0, w.locale);

/** A calendar day: English ISO, as the check wrote it; the language's own date elsewhere. */
export const dayText = (iso: string, w: Words): string =>
  w.locale === "en" ? iso : dayMonthYear(iso, w.locale);

const percentFormats = new Map<string, Intl.NumberFormat>();
/** A share as a percent to one decimal at most: English "40.5%" as the check wrote it. */
export function shareText(share: number, w: Words): string {
  if (w.locale === "en") return `${Math.round(share * 1000) / 10}%`;
  let f = percentFormats.get(w.locale);
  if (!f) {
    f = new Intl.NumberFormat(intlTag(w.locale), { style: "percent", maximumFractionDigits: 1 });
    percentFormats.set(w.locale, f);
  }
  return f.format(Math.round(share * 1000) / 1000);
}

/** Codes joined: English "EUR and HUF" as before; the language's own list elsewhere. */
export function andList(items: readonly string[], w: Words): string {
  if (w.locale === "en") return items.join(" and ");
  return new Intl.ListFormat(intlTag(w.locale), { type: "conjunction" }).format(items);
}
