// The request's translator for a route handler or a server component —
// L-4b of TASKS-LANGUAGES.md. The sentences lib/ builds from data take a
// `Tr` and a locale, English by default (lib/i18n/tr.ts); the handler
// that sends them asks for the request's own here and passes it in.
//
// The locale is the cookie through the status gate (lib/i18n/server
// requestLocale), as every page's is. English is the catalogue's own
// English, so a sentence in English is exactly what englishTr says.
// Outside a request (a test calling a handler, a script) it is English.
//
// Translation is presentation only (rules 4 and 7): what a handler stores
// or logs is built in English as before, never with these words.

import { getTranslations } from "next-intl/server";
import type { AppLocale } from "./locales";
import { DEFAULT_LOCALE } from "./locales";
import { oneStop } from "./punctuation";
import { requestLocale } from "./server";
import type { Tr } from "./tr";
import { englishTr } from "./tr";

/** A translator over one namespace, and the locale the figures go out in. */
export interface Words {
  tr: Tr;
  locale: AppLocale;
}

/** English over `namespace`: the default every sentence builder takes. */
export function englishWords(namespace: string): Words {
  return { tr: englishTr(namespace), locale: "en" };
}

/** This request's locale, or English when there is no request to read. */
export async function requestLocaleOrEnglish(): Promise<AppLocale> {
  try {
    return await requestLocale();
  } catch {
    return DEFAULT_LOCALE;
  }
}

/** The request's translator over `namespace` (a catalogue top-level key, or a dotted path into one). */
export async function requestWords(namespace: string, locale?: AppLocale): Promise<Words> {
  const l = locale ?? (await requestLocaleOrEnglish());
  if (l === "en") return englishWords(namespace);
  const t = (await getTranslations({
    locale: l,
    namespace: namespace as "common",
  })) as unknown as Tr;
  return { tr: (key, values) => oneStop(t(key, values), l), locale: l };
}
