"use client";

// A screen's translator and locale for a client component — L-3a. The
// translator is next-intl's for the request's locale (the cookie through
// the status gate, i18n/request.ts), over one namespace; the locale is
// what the figure formatters take (components/sheet/num.ts).

import { useLocale, useTranslations } from "next-intl";
import type { AppLocale } from "../../lib/i18n/locales";
import { isAppLocale } from "../../lib/i18n/locales";
import type { Tr } from "../../lib/i18n/tr";

/** The request's locale, as one of the app's seven. */
export function useAppLocale(): AppLocale {
  const raw = useLocale();
  return isAppLocale(raw) ? raw : "en";
}

/** A plain translator over `namespace`, and the locale. */
export function useTr(namespace: string): { tr: Tr; locale: AppLocale } {
  const t = useTranslations(namespace as "common") as unknown as Tr;
  const locale = useAppLocale();
  return { tr: (key, values) => t(key, values), locale };
}
