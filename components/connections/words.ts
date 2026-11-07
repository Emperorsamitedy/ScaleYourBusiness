// The connections screen's words and figures in the reader's language —
// L-3d of TASKS-LANGUAGES.md. Pure, and safe in the browser.
//
// The screen's fixed words are the "connections" catalogue
// (messages/*.json). What the registries say stays where it is and stays
// English: SCOPE_GUIDE (lib/connectors/scopes.ts) and CREDENTIAL_FIELDS
// (lib/connectors/credentials.ts) are still what the API sends and what the
// scope audit reads; the catalogue repeats their English word for word under
// `guide.<provider>.<n>` and `field.<provider>.<name>` (words.test.ts holds
// it), so the screen can say them in another language without a registry
// line changing.
//
// Not translated, on purpose: the consent lines of write access and the
// phrase the owner types to confirm. A consent's hash covers the lines as
// shown and the phrase as typed (lib/execution/consent.ts), so they stay
// the registry's English until a consent records the language it was shown
// in.

import type { AppLocale } from "../../lib/i18n/locales";
import { intlTag } from "../../lib/i18n/locales";
import { dayMonthYear } from "../../lib/i18n/format";
import { gives, joinSentences, labelList, parseTs } from "./patch";

export { joinSentences, labelList };

/** key → text over the "connections" namespace, with next-intl's rich text and has(). */
export interface CnTr {
  (key: string, values?: Record<string, string | number>): string;
  rich(key: string, values: Record<string, unknown>): React.ReactNode;
  has(key: string): boolean;
}

/** One SCOPE_GUIDE line as the API sends it. */
export interface GuideEntry {
  scope: string;
  grant: string;
  why: string;
}

/** Shopify's history without read_all_orders (SHOPIFY_DEFAULT_HISTORY_DAYS, lib/connectors/providers/shopify.ts). */
export const SHOPIFY_DEFAULT_DAYS = 60;

/** The guide's catalogue key for a provider's nth line. */
export const guideKey = (provider: string, i: number) => `guide.${provider}.s${i}`;

/** Values every guide line may use. */
const GUIDE_VALUES = { days: SHOPIFY_DEFAULT_DAYS };

/** A guide line in the reader's words; the registry's own where the catalogue has none. */
export function guideLine(
  t: CnTr,
  provider: string,
  i: number,
  g: GuideEntry,
): { grant: string; why: string } {
  const key = guideKey(provider, i);
  return {
    // A grant that is the scope's own code is shown as the code, in every language.
    grant: t.has(`${key}.grant`) ? t(`${key}.grant`, GUIDE_VALUES) : g.grant,
    why: t.has(`${key}.why`) ? t(`${key}.why`, GUIDE_VALUES) : g.why,
  };
}

/**
 * "Your orders, your product list, …" — what a source gives. English is
 * the registry's own words trimmed to their subject (patch.ts `gives`),
 * as before; other languages say each line's subject from the catalogue.
 */
export function givesText(
  t: CnTr,
  provider: string,
  guide: readonly GuideEntry[],
  locale: AppLocale,
): string {
  if (locale === "en") return gives(guide);
  const parts: string[] = [];
  guide.forEach((_, i) => {
    const key = `${guideKey(provider, i)}.gives`;
    if (!t.has(key)) return;
    const word = t(key, GUIDE_VALUES);
    if (!parts.some((p) => p.toLocaleLowerCase(intlTag(locale)) === word.toLocaleLowerCase())) {
      parts.push(word);
    }
  });
  const first = parts[0];
  if (first !== undefined) {
    parts[0] = first.charAt(0).toLocaleUpperCase(intlTag(locale)) + first.slice(1);
  }
  return parts.join(t("guide.sep"));
}

/** A stored day ("2026-10-17") in the reader's own date ("17 Oct 2026"). */
export function storedDay(iso: string, locale: AppLocale): string {
  const day = iso.slice(0, 10);
  return dayMonthYear(day, locale);
}

/** "17 Oct 2026, 14:20": a moment in the browser's time zone, in the reader's writing. */
export function moment(iso: string, locale: AppLocale): string {
  return new Date(parseTs(iso)).toLocaleString(locale === "en" ? "en-GB" : intlTag(locale), {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** "6 Nov 2026" — a calendar day, in the reader's writing (en-GB in English, as before). */
export function calendarDay(iso: string, locale: AppLocale): string {
  return new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString(
    locale === "en" ? "en-GB" : intlTag(locale),
    { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" },
  );
}

/** "45%" in English, as before; the language's percent ("45 %", "45 %") elsewhere. */
export function percent(whole: number, locale: AppLocale, decimals = 0): string {
  if (locale === "en") return `${whole.toFixed(decimals)}%`;
  return new Intl.NumberFormat(intlTag(locale), {
    style: "percent",
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(whole / 100);
}

/** The sample figures the import forms show, typed once here (rule 3). */
export const IMPORT_SAMPLES = {
  slashDate: "03/04/2026",
  ambiguousAmount: "1.200",
  dotDecimal: "1,234.56",
  commaDecimal: "1.234,56",
} as const;

/** "3 April" / "March 4": the two readings of 03/04, in English as the forms always said. */
export function dateOrderExample(order: "dmy" | "mdy", locale: AppLocale): string {
  if (locale === "en") return order === "dmy" ? "3 April" : "March 4";
  const day = order === "dmy" ? "2026-04-03" : "2026-03-04";
  return new Date(`${day}T00:00:00Z`).toLocaleDateString(intlTag(locale), {
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  });
}

/** GOOGLE_NEEDS (lib/google-business/words.ts), in order, as "reviews.google.needs" keys them. */
export const GOOGLE_NEED_KEYS = ["approval", "signIn", "location"] as const;
