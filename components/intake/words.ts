// The intake's own words in the person's language — L-2 of
// TASKS-LANGUAGES.md. The catalogue is messages/<locale>.json, namespace
// "intake"; the pure wording helpers in ./record take a translator so they
// stay testable without React, and default to English from the same
// catalogue — so English has one source, and what the screen said before
// L-2 is what it still says (components/intake/record.test.ts).

import { useCallback } from "react";
import { createTranslator, useLocale, useTranslations } from "next-intl";
import en from "@/messages/en.json";
import type { AppLocale } from "@/lib/i18n/locales";
import { isAppLocale } from "@/lib/i18n/locales";

/** A plain translator over the "intake" namespace: key → text. */
export type Tr = (key: string, values?: Record<string, string | number>) => string;

const english = createTranslator({ locale: "en", messages: en, namespace: "intake" });

/** English, from messages/en.json — the default every helper falls back to. */
export const EN_TR: Tr = (key, values) =>
  (english as unknown as (k: string, v?: Record<string, string | number>) => string)(key, values);

/** The refusal codes the catalogue words (intake.error.*): anything else falls back to a general line. */
export const INTAKE_ERROR_CODES: ReadonlySet<string> = new Set(Object.keys(en.intake.error));

/**
 * The intake translator and locale for a client component. The translator is
 * the same function from one render to the next while the language stays
 * (see components/sheet/useTr.ts for why that matters).
 */
export function useIntakeWords(): { tr: Tr; locale: AppLocale } {
  const t = useTranslations("intake");
  const raw = useLocale();
  const tr = useCallback<Tr>(
    (key, values) =>
      (t as unknown as (k: string, v?: Record<string, string | number>) => string)(key, values),
    [t],
  );
  return { tr, locale: isAppLocale(raw) ? raw : "en" };
}
