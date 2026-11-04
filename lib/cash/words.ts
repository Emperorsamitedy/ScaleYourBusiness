// The cash forecast's sentences in the reader's language — L-4b of
// TASKS-LANGUAGES.md. Every sentence lib/cash builds from data (the
// forecast's refusals, sources, assumptions and left-out lines, the tight
// week, the scenarios) comes from the "cashWords" catalogue through
// optional words, English by default, so every existing caller and test
// still reads exactly what it read before. The route handler passes the
// request's own (lib/i18n/request-words); what is stored or logged — the
// watch log's warning, the track record's claims — is built in English.
//
// Figures are formatted here in the reader's locale and passed in as
// placeholders, never typed into a message (rule 3), in the business's own
// currency (rule 1).

import { num } from "../../components/sheet/num";
import type { AppLocale } from "../i18n/locales";
import { intlTag } from "../i18n/locales";
import type { Words } from "../i18n/request-words";
import { englishTr } from "../i18n/tr";

export type { Words };

/** English over "cashWords": the default every sentence builder takes. */
export const cashEnglish = (): Words => ({ tr: englishTr("cashWords"), locale: "en" });

/** A share at one decimal: "12.5%" — in another language its own way ("12,5 %"). */
export function pctText(x: number, locale: AppLocale = "en"): string {
  if (locale === "en") return `${num(x * 100, 1)}%`;
  return new Intl.NumberFormat(intlTag(locale), {
    style: "percent",
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(x);
}

/** A whole percent of a share: 0.2 → "20%" ("20 %"). */
export function wholePct(x: number, locale: AppLocale = "en"): string {
  const whole = Math.round(x * 100);
  if (locale === "en") return `${whole}%`;
  return new Intl.NumberFormat(intlTag(locale), {
    style: "percent",
    maximumFractionDigits: 0,
  }).format(whole / 100);
}

/** A multiple at fixed decimals: "1.08×" ("1,08×"). */
export function timesText(x: number, decimals: number, locale: AppLocale = "en"): string {
  const r = Math.round(x * 10 ** decimals) / 10 ** decimals;
  return `${locale === "en" ? r.toFixed(decimals) : num(r, decimals, locale)}×`;
}

/** "a, b and c" — English as it always was; another language its own way. */
export function andList(parts: readonly string[], locale: AppLocale = "en"): string {
  if (parts.length <= 1) return parts[0] ?? "";
  if (locale === "en") return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
  return new Intl.ListFormat(intlTag(locale), { type: "conjunction" }).format(parts);
}

/** A count as the reader writes it. */
export const countText = (n: number, locale: AppLocale = "en"): string => num(n, 0, locale);

/** Measured money series → their noun's key ("cashWords.series.noun.<key>"). */
export const SERIES_NOUN: Readonly<Record<string, string>> = {
  "revenue.daily": "revenue",
  "booking_revenue.daily": "bookingRevenue",
};

/** Measured count series → their kind ("cashWords.perSale.measured.<kind>"). */
export const VOLUME_KIND: Readonly<Record<string, string>> = {
  "orders.daily": "orders",
  "appointments_completed.daily": "appointments",
  "sessions.daily": "visits",
};

/** A series' noun in the reader's words: by its metric when known, else as given. */
export function seriesNoun(s: { noun: string; metric?: string }, words: Words): string {
  const key = s.metric ? SERIES_NOUN[s.metric] : undefined;
  return key ? words.tr(`series.noun.${key}`) : s.noun;
}

/** A series' source: a brand name as given; an import named in the reader's words. */
export function seriesSource(
  s: { source: string; source_key?: "bookings" | "stock" },
  words: Words,
): string {
  return s.source_key ? words.tr(`series.source.${s.source_key}`) : s.source;
}

/** A fact's provenance in the reader's words, when code chose them; a note as given. */
export function factSource(
  f: { source: string; source_key?: "measured" | "estimate" | "derived" | "told" | "statement" },
  words: Words,
): string {
  return f.source_key ? words.tr(`factSource.${f.source_key}`) : f.source;
}
