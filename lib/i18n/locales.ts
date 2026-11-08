// The languages SYB speaks, and whether each is open yet — L-1 of
// TASKS-LANGUAGES.md. Pure data and arithmetic, safe in the browser.
//
// The language lives in a cookie and never in the URL, so every address
// stays as it is. A person's language is stored on their users row; the
// business's own language (what its customers will read) on its profile;
// its currency on the account (accounts.reporting_currency). They are
// three separate choices: a German-speaking owner may run a Hungarian
// business that prices in euros.
//
// The status gate (rule 6 of the plan) is the table below. Only a `live`
// language is offered to customers. A `review` language is offered only to
// the accounts or addresses named in LANGUAGE_REVIEW_ACCOUNTS — the owner
// and the native reviewer they chose — and `building` to nobody. English
// is the source every catalogue is checked against, so it is always live.

export const LOCALES = ["en", "es-ES", "de-DE", "fr-FR", "hu-HU", "ru-RU", "zh-Hans"] as const;

export type AppLocale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: AppLocale = "en";

export function isAppLocale(v: unknown): v is AppLocale {
  return typeof v === "string" && (LOCALES as readonly string[]).includes(v);
}

/** The person's language. Not httpOnly-sensitive: it opens nothing, and the gate is re-checked on every read. */
export const LANGUAGE_COOKIE = "syb_lang";
/** A currency chosen before there is an account to hold it (the sign-up screen). */
export const CURRENCY_COOKIE = "syb_currency";

export type LanguageStatus = "building" | "review" | "live";

/**
 * THE status table. A language moved to `live` after its native reviewer
 * read it (stage L-7) — until the owner's override of 2026-11-08 ("switch
 * all live now"): all six went live unreviewed; native review follows and
 * corrections land as found. `LANGUAGES_IN_REVIEW` sends one back without a code change.
 */
export const LANGUAGE_STATUS: Readonly<Record<AppLocale, LanguageStatus>> = {
  en: "live",
  "es-ES": "live",
  "de-DE": "live",
  "fr-FR": "live",
  "hu-HU": "live",
  "ru-RU": "live",
  "zh-Hans": "live",
};

/** Each language in its own words, as a picker shows it — the same in every catalogue. */
export const LANGUAGE_NAMES: Readonly<Record<AppLocale, string>> = {
  en: "English",
  "es-ES": "Español (España)",
  "de-DE": "Deutsch",
  "fr-FR": "Français",
  "hu-HU": "Magyar",
  "ru-RU": "Русский",
  "zh-Hans": "简体中文",
};

/**
 * A language's status now: the table, unless `LANGUAGES_IN_REVIEW` (a comma
 * list, e.g. "ru-RU,zh-Hans") sends a live language back to review — the
 * owner's lever when a reviewer finds a language not ready, no code change.
 * English is never sent back: it is the source every catalogue is checked against.
 */
export function languageStatus(locale: AppLocale): LanguageStatus {
  const back = (process.env.LANGUAGES_IN_REVIEW ?? "").split(",").map((s) => s.trim());
  return locale !== DEFAULT_LOCALE && back.includes(locale) ? "review" : LANGUAGE_STATUS[locale];
}

/** Pure: whether a language may be used by someone who is (or isn't) a named reviewer. */
export function languageOpenTo(locale: AppLocale, reviewer: boolean): boolean {
  const status = languageStatus(locale);
  return status === "live" || (status === "review" && reviewer);
}

/** Pure: the languages a picker offers, in the table's order. */
export function offeredLanguages(reviewer: boolean): AppLocale[] {
  return LOCALES.filter((l) => languageOpenTo(l, reviewer));
}

/**
 * Pure: a requested language as the one actually used — unknown, or not
 * open to this person, falls back to English. Never throws.
 */
export function resolveLanguage(requested: unknown, reviewer: boolean): AppLocale {
  return isAppLocale(requested) && languageOpenTo(requested, reviewer) ? requested : DEFAULT_LOCALE;
}

/**
 * The tag Intl formats with. English keeps the hand-written formatters'
 * own output (components/sheet/num.ts), so it is only used where Intl is
 * asked; the others are their region's conventions as CLDR writes them.
 */
export function intlTag(locale: AppLocale): string {
  return locale === "en" ? "en-GB" : locale;
}
