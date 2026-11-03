// The economics' own sentences in the reader's language — L-4a of
// TASKS-LANGUAGES.md.
//
// computeEconomics writes its refusals ("what" and "why") and formulas in
// English, and a report stores them so (its numbers stay reproducible, and
// the stored words are left as they were — rule 4). The screens read them
// back through the "econWords" catalogue, whose English is word for word
// what unit-economics.ts writes (words.test.ts holds every one): a known
// sentence is said again in the reader's language, with the currency
// codes, an offer's name and the formula's figures carried over. Anything
// else prints as stored. Pure and safe in the browser.

import { num } from "../../components/sheet/num";
import type { AppLocale } from "../i18n/locales";
import { readStored } from "../i18n/stored";
import type { Tr } from "../i18n/tr";
import { englishTr } from "../i18n/tr";

export type EconPart = "what" | "why" | "formula";

export interface EconWords {
  /** A translator over "econWords". */
  tr: Tr;
  locale: AppLocale;
}

export const ENGLISH_ECON: EconWords = { tr: englishTr("econWords"), locale: "en" };

/** Pure: one of the economics' stored sentences in the reader's language. */
export function econText(text: string, part: EconPart, w: EconWords = ENGLISH_ECON): string {
  if (w.locale === "en") return text;
  return readStored(
    text,
    `econWords.${part}`,
    (key, values) => w.tr(`${part}.${key}`, values),
    (name, raw) =>
      (name === "hundred" || name === "one") && /^\d+$/.test(raw)
        ? num(Number(raw), 0, w.locale)
        : raw,
  );
}
