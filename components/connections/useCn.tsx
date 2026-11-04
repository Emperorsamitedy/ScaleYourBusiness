"use client";

// The connections catalogue for a client component — L-3d. next-intl's
// translator over "connections" (or one of its subtrees), with rich text
// for the setup steps' bold labels and has() for the registry lines that
// carry words, and the locale the figure formatters take.

import { useCallback } from "react";
import { useTranslations } from "next-intl";
import type { AppLocale } from "../../lib/i18n/locales";
import { useAppLocale } from "../sheet/useTr";
import type { CnTr } from "./words";
import { CONNECTIONS_WORDS, sayServer } from "./server-words";

export function useCn(namespace = "connections"): { t: CnTr; locale: AppLocale } {
  const t = useTranslations(namespace as "common") as unknown as CnTr;
  return { t, locale: useAppLocale() };
}

/**
 * L-4c: a server sentence (a refusal, a stored last error) in the reader's
 * language when it is one of SYB's own; anything else as it came.
 */
export function useSaid(): (text: string) => string {
  const { t, locale } = useCn(CONNECTIONS_WORDS);
  return useCallback((text: string) => sayServer(text, t, locale), [t, locale]);
}

/** The bold tag every catalogue line with a provider's own label uses. */
export const bold = { b: (chunks: React.ReactNode) => <strong>{chunks}</strong> };
