// What measured takings cover, and the analysis's honest limit, in the
// reader's language — L-4a of TASKS-LANGUAGES.md.
//
// lib/hours/coverage and lib/hours/trading write both lines in English, and
// a report keeps the trading-hours block as it was made. The screens read
// them back through the "hoursWords" catalogue, whose English is word for
// word what those files write (words.test.ts): the providers' names carry
// over as they are. Anything else prints as written. Pure and safe in the
// browser.

import type { AppLocale } from "../i18n/locales";
import { readStored } from "../i18n/stored";
import type { Tr } from "../i18n/tr";

/** A coverage or limit line in `locale`, given a translator over "hoursWords". */
export function hoursLineWords(text: string, tr: Tr, locale: AppLocale): string {
  if (locale === "en") return text;
  return readStored(text, "hoursWords.line", (key, values) => tr(`line.${key}`, values));
}
