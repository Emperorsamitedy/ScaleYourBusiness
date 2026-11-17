// How Home prints dates, money and "how long ago", in the reader's locale.
// Shared by the screen's parts so one figure is never printed two ways.

import { minorUnitExponent } from "../../lib/core/money";
import { intlTag } from "../../lib/i18n/locales";
import type { AppLocale } from "../../lib/i18n/locales";
import { moneyText } from "../sheet/num";
import { ago } from "./activity-model";

/** English keeps en-GB, as the app's dates always have. */
export const tagOf = (locale: AppLocale): string => (locale === "en" ? "en-GB" : intlTag(locale));

/** "15 Nov" from an ISO or Postgres day. */
export const shortDay = (iso: string, locale: AppLocale): string =>
  new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString(tagOf(locale), {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });

/** "Tue 17 Nov". */
export const longDay = (d: Date, locale: AppLocale): string =>
  d.toLocaleDateString(tagOf(locale), { weekday: "short", day: "numeric", month: "short" });

/** Whole major units, as every reading on Home prints them (the currency's own exponent). */
export const whole = (minor: number, currency: string, locale: AppLocale): string => {
  const unit = 10 ** minorUnitExponent(currency);
  const text = moneyText(Math.abs(Math.round(minor / unit)) * unit, currency, locale);
  return minor < 0 ? `−${text}` : text;
};

const signed = (minor: number, currency: string, locale: AppLocale): string =>
  `${minor > 0 ? "+" : minor < 0 ? "−" : ""}${whole(Math.abs(minor), currency, locale)}`;

/** A money range as a decision states it: "+€134 – +€1,238". */
export const moneyRange = (
  r: {
    low: { amount_minor: number; currency: string };
    high: { amount_minor: number; currency: string };
  },
  locale: AppLocale,
): string =>
  `${signed(r.low.amount_minor, r.low.currency, locale)} – ${signed(r.high.amount_minor, r.high.currency, locale)}`;

/** "2 hr. ago", "now", "yesterday"; the day and month once it is more than four weeks back. */
export function agoText(ms: number, now: number, locale: AppLocale): string {
  const a = ago(ms, now);
  if (a === null) {
    return new Date(ms).toLocaleDateString(tagOf(locale), { day: "numeric", month: "short" });
  }
  return new Intl.RelativeTimeFormat(tagOf(locale), { numeric: "auto", style: "short" }).format(
    a.value,
    a.unit,
  );
}

/** The full moment, for a row's title: "Tue 17 Nov, 13:37". */
export const fullWhen = (ms: number, locale: AppLocale): string =>
  new Date(ms).toLocaleString(tagOf(locale), {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
