// The idea check's options, in the reader's language (server side). Business
// types read their words from the bank, countries from Intl; no option's
// words are typed in here.

import ideaFile from "../../specs/idea-v1.json";
import { loadFactWords } from "../bank/words";
import type { AppLocale } from "../i18n/locales";
import { BUSINESS_TYPES, CURRENCIES, IDEA_COUNTRIES } from "./check";

export async function ideaOptions(locale: AppLocale) {
  const words = await loadFactWords(locale);
  const english = await loadFactWords("en");
  const name = (code: string) =>
    words.value("identity.business_type", code) ??
    english.value("identity.business_type", code) ??
    code;
  const collator = new Intl.Collator(locale);
  const regions = new Intl.DisplayNames([locale], { type: "region" });
  return {
    sectors: BUSINESS_TYPES.map((c) => ({ value: c, label: name(c) })).sort((a, b) =>
      collator.compare(a.label, b.label),
    ),
    countries: IDEA_COUNTRIES.map((c) => ({ value: c, label: regions.of(c) ?? c })).sort((a, b) =>
      collator.compare(a.label, b.label),
    ),
    currencies: [...CURRENCIES],
    currencyByCountry: ideaFile.currency_by_country as Record<string, string>,
  };
}
