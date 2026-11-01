// What the language and currency picker shows — L-1. Pure: the server
// builds it and hands it to the screen, so the browser never re-derives a
// name and the two can't disagree.

import { ISO_4217_CODES, isIsoCurrency } from "../core/currencies";
import type { AppLocale } from "./locales";
import { LANGUAGE_NAMES, LANGUAGE_STATUS, intlTag, isAppLocale } from "./locales";

export interface LanguageOption {
  code: AppLocale;
  /** In its own words: "Deutsch", "简体中文". */
  name: string;
  /** Not live yet — open to this person only because they are a named reviewer. */
  checking: boolean;
}

export interface CurrencyOption {
  /** ISO 4217. */
  code: string;
  /** The currency's name in the reader's language ("euro", "Ungarischer Forint"). */
  name: string;
}

export interface PickerData {
  languages: LanguageOption[];
  /** The language this screen is in now. */
  language: AppLocale;
  currencies: CurrencyOption[];
  /** The business's currency, or null when there's none yet and one must be chosen. */
  currency: string | null;
  /** Whether this person may set the business's language and currency (an owner, or before sign-up). */
  canSetBusiness: boolean;
}

export interface PendingChoices {
  /** A language the browser chose (one of ours; the gate is applied where it's used). */
  language: AppLocale | null;
  /** A currency chosen before there was an account (ISO 4217, checked). */
  currency: string | null;
  /** Whether the browser has made the first step's choice at all. */
  chosen: boolean;
}

/** Pure: the two cookie values as choices. Anything unrecognised is no choice. */
export function readPendingChoices(
  rawLanguage: string | undefined,
  rawCurrency: string | undefined,
): PendingChoices {
  const language = isAppLocale(rawLanguage) ? rawLanguage : null;
  const currency = rawCurrency && isIsoCurrency(rawCurrency) ? rawCurrency : null;
  return { language, currency, chosen: language !== null };
}

export function languageOptions(offered: readonly AppLocale[]): LanguageOption[] {
  return offered.map((code) => ({
    code,
    name: LANGUAGE_NAMES[code],
    checking: LANGUAGE_STATUS[code] !== "live",
  }));
}

/** Every active ISO 4217 currency, named in the reader's language, in code order. */
export function currencyOptions(locale: AppLocale): CurrencyOption[] {
  let names: Intl.DisplayNames | null = null;
  try {
    names = new Intl.DisplayNames([intlTag(locale)], { type: "currency", fallback: "code" });
  } catch {
    names = null;
  }
  return [...ISO_4217_CODES].sort().map((code) => ({ code, name: names?.of(code) ?? code }));
}
