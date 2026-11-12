// The free entry's options, in the reader's language (server side).
// Business types read their words from the bank (lib/bank), countries from
// Intl, bands from their euro edges; no option's words are typed in here.

import benchmarkMap from "../../specs/benchmark-map-v1.json";
import { loadFactWords } from "../bank/words";
import { presentMoney } from "../i18n/format";
import type { AppLocale } from "../i18n/locales";
import type { Tr } from "../i18n/tr";
import entryFile from "../../specs/entry-v1.json";
import { BUSINESS_TYPES, CHANNELS, REVENUE_BANDS, operationsQuestion } from "./one-number";

/** The EU (Eurostat writes Greece "EL") and the nearby markets SYB already serves. */
const COUNTRIES = [
  ...(benchmarkMap as { countries: { eu27: string[] } }).countries.eu27.map((c) =>
    c === "EL" ? "GR" : c,
  ),
  "CH",
  "NO",
  "IS",
  "GB",
];

const BANDS = entryFile.monthly_revenue_bands as unknown as Record<
  string,
  { from: number; to: number | null }
>;

export async function entryOptions(locale: AppLocale, tr: Tr) {
  const words = await loadFactWords(locale);
  const english = await loadFactWords("en");
  const name = (code: string) =>
    words.value("identity.business_type", code) ??
    english.value("identity.business_type", code) ??
    code;
  const collator = new Intl.Collator(locale);
  const regions = new Intl.DisplayNames([locale], { type: "region" });
  const eur = (minor: number) =>
    presentMoney({ amount_minor: minor, currency: "EUR" }, locale, { whole: true });
  return {
    sectors: BUSINESS_TYPES.map((c) => ({ value: c, label: name(c) })).sort((a, b) =>
      collator.compare(a.label, b.label),
    ),
    countries: COUNTRIES.map((c) => ({ value: c, label: regions.of(c) ?? c })).sort((a, b) =>
      collator.compare(a.label, b.label),
    ),
    bands: REVENUE_BANDS.map((id) => {
      const b = BANDS[id]!;
      return {
        value: id,
        label: tr(`band.${id}`, { from: eur(b.from), to: b.to === null ? "" : eur(b.to) }),
      };
    }),
    channels: CHANNELS,
    operations: Object.fromEntries(BUSINESS_TYPES.map((t) => [t, operationsQuestion(t)])),
  };
}
