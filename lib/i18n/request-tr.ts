// A translator for the request's language, for route handlers and server
// code that build sentences from data — L-4c of TASKS-LANGUAGES.md. The
// locale is the cookie through the status gate (lib/i18n/server
// requestLocale), exactly what next-intl's request config uses; the
// catalogue is messages/<locale>.json over one namespace.
//
// Outside a request (a unit test, a script) there are no cookies to read,
// and the answer is English — the same words the code said before L-4.

import { createTranslator } from "next-intl";
import type { AppLocale } from "./locales";
import { requestLocale } from "./server";
import type { Tr } from "./tr";
import { englishTr } from "./tr";

type Catalogue = Record<string, unknown>;

const catalogues = new Map<AppLocale, Promise<Catalogue>>();

function catalogue(locale: AppLocale): Promise<Catalogue> {
  let c = catalogues.get(locale);
  if (!c) {
    c = import(`../../messages/${locale}.json`).then((m: { default: Catalogue }) => m.default);
    catalogues.set(locale, c);
  }
  return c;
}

/** Pure but for the catalogue load: a translator over `namespace` in `locale`. */
export async function localeTr(locale: AppLocale, namespace: string): Promise<Tr> {
  if (locale === "en") return englishTr(namespace);
  const t = createTranslator({
    locale,
    messages: await catalogue(locale),
    namespace: namespace as "common",
    timeZone: "UTC",
  }) as unknown as Tr;
  return (key, values) => t(key, values);
}

/** The request's locale, English when there is no request to read. Never throws. */
export async function requestLocaleOrEnglish(): Promise<AppLocale> {
  try {
    return await requestLocale();
  } catch {
    return "en";
  }
}

/** The request's translator over `namespace`, and its locale. */
export async function requestTr(namespace: string): Promise<{ tr: Tr; locale: AppLocale }> {
  const locale = await requestLocaleOrEnglish();
  return { tr: await localeTr(locale, namespace), locale };
}
