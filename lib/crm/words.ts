// The customers screen's server-built sentences, one source — L-4c of
// TASKS-LANGUAGES.md. What lib/crm (and the campaign readback in
// lib/trust/email-readback) builds from data comes from the
// "customersWords" catalogue: English by default (messages/en.json), so
// English is exactly what the code said before L-4, and the request's
// language at presentation (lib/crm/localize.ts). Stored proposals keep the
// English they were written with.

import { intlNumber } from "../i18n/format";
import type { AppLocale } from "../i18n/locales";
import { intlTag } from "../i18n/locales";
import type { Tr } from "../i18n/tr";
import { englishTr } from "../i18n/tr";

/** The namespace of every server-built sentence on /customers. */
export const CUSTOMERS_WORDS = "customersWords";

/** English, from messages/en.json — what the code always said. */
export const customersEnglish = (): Tr => englishTr(CUSTOMERS_WORDS);

/** A figure as the code wrote it (String(n)) in English; the language's own digits otherwise. */
export function fig(n: number, locale: AppLocale): string {
  return locale === "en" ? String(n) : intlNumber(n, Number.isInteger(n) ? 0 : 1, locale);
}

/** A share already in percent ("10" → "10%"), as the code wrote it in English; Intl's percent otherwise. */
export function percentText(pct: number, locale: AppLocale, decimals?: number): string {
  if (locale === "en") return `${decimals === undefined ? pct : pct.toFixed(decimals)}%`;
  const d = decimals ?? (Number.isInteger(pct) ? 0 : 1);
  return new Intl.NumberFormat(intlTag(locale), {
    style: "percent",
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  }).format(Number(pct.toFixed(d)) / 100);
}

/** Phrases one after another: "A; B; C" in English (the catalogue's "semi" join). */
export function semiJoin(parts: readonly string[], tr: Tr): string {
  if (parts.length === 0) return "";
  return parts.slice(1).reduce((first, then) => tr("semi", { first, then }), parts[0] as string);
}

/** An API's choices, quoted: '"a", "b" or "c"' in English as the refusals wrote them; the language's "or" otherwise. */
export function orList(items: readonly string[], locale: AppLocale): string {
  const quoted = items.map((a) => `"${a}"`);
  if (locale !== "en") return listWords(quoted, locale, ", ", "disjunction");
  return quoted.length < 2
    ? quoted.join("")
    : `${quoted.slice(0, -1).join(", ")} or ${quoted[quoted.length - 1]}`;
}

/** A list: "a, b" in English as the code joined it; the language's own list otherwise. */
export function listWords(
  items: readonly string[],
  locale: AppLocale,
  englishJoin = ", ",
  type: "conjunction" | "disjunction" | "unit" = "unit",
): string {
  if (locale === "en") return items.join(englishJoin);
  return new Intl.ListFormat(intlTag(locale), { type, style: "long" }).format(items);
}
