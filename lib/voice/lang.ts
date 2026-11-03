// I-50a (decided 2026-11-03, owner: "Yes, the chosen language"): the
// microphone listens in the person's chosen language — the request's
// locale, which is the language cookie (copied from users.language at
// sign-in) through the status gate (lib/i18n/server requestLocale) — never
// the browser's own language and never the account's code-set "en-GB".
//
// Pure data, safe in the browser. The values are the BCP 47 tags the Web
// Speech API's `lang` takes. English keeps "en-GB", what it has always
// listened in; Simplified Chinese is "zh-CN", because recognisers name a
// spoken language by its region, not by its script ("zh-Hans").

import type { AppLocale } from "../i18n/locales";

export const SPEECH_LANG: Readonly<Record<AppLocale, string>> = {
  en: "en-GB",
  "es-ES": "es-ES",
  "de-DE": "de-DE",
  "fr-FR": "fr-FR",
  "hu-HU": "hu-HU",
  "ru-RU": "ru-RU",
  "zh-Hans": "zh-CN",
};

/** The tag speech recognition listens in, for the person's chosen language. */
export function speechLang(locale: AppLocale): string {
  return SPEECH_LANG[locale];
}
