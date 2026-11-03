// A translator for any of the seven languages, synchronously, on the
// server — L-4a of TASKS-LANGUAGES.md. For the few places that answer
// before a request translator exists or can be awaited (requireRole's
// refusal is built in a synchronous check every mutating route makes).
// Route handlers and server components otherwise use next-intl's
// getTranslations. English is lib/i18n/tr's own.
//
// Server only: it holds every catalogue.

import { createTranslator } from "next-intl";
import de from "../../messages/de-DE.json";
import en from "../../messages/en.json";
import es from "../../messages/es-ES.json";
import fr from "../../messages/fr-FR.json";
import hu from "../../messages/hu-HU.json";
import ru from "../../messages/ru-RU.json";
import zh from "../../messages/zh-Hans.json";
import type { AppLocale } from "./locales";
import type { Tr } from "./tr";
import { englishTr } from "./tr";

const CATALOGUES: Record<AppLocale, unknown> = {
  en,
  "es-ES": es,
  "de-DE": de,
  "fr-FR": fr,
  "hu-HU": hu,
  "ru-RU": ru,
  "zh-Hans": zh,
};

const cache = new Map<string, Tr>();

/** A plain translator over one namespace in `locale`. */
export function trFor(locale: AppLocale, namespace: string): Tr {
  if (locale === "en") return englishTr(namespace);
  const id = `${locale}|${namespace}`;
  let tr = cache.get(id);
  if (!tr) {
    const t = createTranslator({
      locale,
      messages: CATALOGUES[locale] as typeof en,
      namespace: namespace as "common",
      timeZone: "UTC",
    }) as unknown as Tr;
    tr = (key, values) => t(key, values);
    cache.set(id, tr);
  }
  return tr;
}
