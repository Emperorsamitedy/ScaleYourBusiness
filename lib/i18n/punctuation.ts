// The punctuation code adds between and after translated sentences — L-4b.
// A screen that joins a list of fragments, or ends a fragment it was sent,
// does it in the reader's language: Chinese takes full-width marks (the
// register chosen in L-1), every other language the ASCII ones, so
// English is exactly what it always was. Pure and safe in the browser.

import type { AppLocale } from "./locales";

/** "; " between list items — "；" in Chinese. */
export function listSep(locale: AppLocale = "en"): string {
  return locale === "zh-Hans" ? "；" : "; ";
}

/** The full stop after a fragment — "。" in Chinese. */
export function fullStop(locale: AppLocale = "en"): string {
  return locale === "zh-Hans" ? "。" : ".";
}

/**
 * A sentence whose last placeholder already ends in a full stop — a short
 * date such as German "20. Dez." or French "20 déc." — would end "Dez..".
 * Outside English (whose dates carry no dot) the doubled stop is one.
 */
export function oneStop(text: string, locale: AppLocale = "en"): string {
  return locale === "en" ? text : text.replace(/(?<!\.)\.\.(?!\.)/g, ".");
}
