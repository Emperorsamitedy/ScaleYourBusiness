"use client";

// A screen's translator and locale for a client component — L-3a. The
// translator is next-intl's for the request's locale (the cookie through
// the status gate, i18n/request.ts), over one namespace; the locale is
// what the figure formatters take (components/sheet/num.ts). L-4b: a date
// that ends a sentence keeps one full stop (lib/i18n/punctuation oneStop).

import { useCallback } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { AppLocale } from "../../lib/i18n/locales";
import { isAppLocale } from "../../lib/i18n/locales";
import { oneStop } from "../../lib/i18n/punctuation";
import type { Tr } from "../../lib/i18n/tr";

/** The request's locale, as one of the app's seven. */
export function useAppLocale(): AppLocale {
  const raw = useLocale();
  return isAppLocale(raw) ? raw : "en";
}

/**
 * A plain translator over `namespace`, and the locale.
 *
 * The translator is the same function from one render to the next while the
 * language stays (next-intl's own is). It was made anew on every render until
 * 2026-11-20, which no caller could see: a hook that named it among what it
 * depends on then ran again after every render. The interview with Lex read
 * the server that way, without end, for as long as it was open.
 */
export function useTr(namespace: string): { tr: Tr; locale: AppLocale } {
  const t = useTranslations(namespace as "common") as unknown as Tr;
  const locale = useAppLocale();
  const tr = useCallback<Tr>((key, values) => oneStop(t(key, values), locale), [t, locale]);
  return { tr, locale };
}
