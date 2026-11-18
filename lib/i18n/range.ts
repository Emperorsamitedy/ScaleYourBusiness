// One way to say "from this to that" in each language, with no dash in it.
//
// The owner, 2026-11-18 (docs/DASHBOARD-OVERHAUL.md, L7): "no em and en
// dashes throughout the app"; a range reads "+€136 to +€1,213". Every range
// a screen builds in code goes through here, so a figure is never worded two
// ways. The ends arrive already formatted (money, a count, a day).
//
// English, German, Spanish and French take their own word. Hungarian and
// Russian take a spaced hyphen: their word for it would need the nouns
// around the range in another case, and the result lands inside sentences
// this function cannot see. Chinese takes 至.

import type { AppLocale } from "./locales";

/** "€3,100 to €5,400", in the reader's language. */
export function rangeOf(low: string, high: string, locale: AppLocale = "en"): string {
  switch (locale) {
    case "en":
      return `${low} to ${high}`;
    case "de-DE":
      return `${low} bis ${high}`;
    case "es-ES":
      return `${low} a ${high}`;
    case "fr-FR":
      return `${low} à ${high}`;
    case "zh-Hans":
      return `${low} 至 ${high}`;
    case "hu-HU":
    case "ru-RU":
      return `${low} - ${high}`;
  }
}

/** What a table or a line prints where there is no value: a plain hyphen, never a long dash. */
export const NO_VALUE = "-";
