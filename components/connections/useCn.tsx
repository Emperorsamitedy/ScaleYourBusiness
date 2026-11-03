"use client";

// The connections catalogue for a client component — L-3d. next-intl's
// translator over "connections" (or one of its subtrees), with rich text
// for the setup steps' bold labels and has() for the registry lines that
// carry words, and the locale the figure formatters take.

import { useTranslations } from "next-intl";
import type { AppLocale } from "../../lib/i18n/locales";
import { useAppLocale } from "../sheet/useTr";
import type { CnTr } from "./words";

export function useCn(namespace = "connections"): { t: CnTr; locale: AppLocale } {
  const t = useTranslations(namespace as "common") as unknown as CnTr;
  return { t, locale: useAppLocale() };
}

/** The bold tag every catalogue line with a provider's own label uses. */
export const bold = { b: (chunks: React.ReactNode) => <strong>{chunks}</strong> };
