// The sign-in refusals in the reader's language — L-4a of TASKS-LANGUAGES.md.
//
// The sign-in routes answer in English (an AuthError's message, a redirect's
// ?error=…), and the English is what tests and logs hold. The screens that
// print one (the sign-in form, "Which business?") read it back through the
// "authWords" catalogue: a known sentence is matched and said again in the
// reader's language, a provider's name kept; anything else prints as sent.
// Pure and safe in the browser.

import type { AppLocale } from "../i18n/locales";
import { readStored } from "../i18n/stored";
import type { Tr } from "../i18n/tr";

/** A sign-in refusal in `locale`, given a translator over "authWords". */
export function authErrorWords(text: string, tr: Tr, locale: AppLocale): string {
  if (locale === "en") return text;
  return readStored(
    text,
    "authWords.error",
    (key, values) => tr(`error.${key}`, values),
    (name, raw) =>
      name === "why" ? readStored(raw, "authWords.why", (key) => tr(`why.${key}`)) : raw,
  );
}
