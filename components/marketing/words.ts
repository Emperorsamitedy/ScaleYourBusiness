// The landing page's words and figures in the reader's language — L-3d of
// TASKS-LANGUAGES.md. Pure, and safe in the browser.
//
// The fixed words are the "landing" catalogue (messages/*.json); the
// illustrative businesses (lib/marketing) stay English data, which the
// catalogue's English repeats word for word (words.test.ts holds it). Every
// figure goes through the locale's formatters in the demo's own currency,
// never converted. English keeps exactly what the page always printed:
// where Intl would write a figure differently ("$10k", "€6–9", "15:00"),
// English passes the page's own characters.

import type { AppLocale } from "../../lib/i18n/locales";
import { intlTag } from "../../lib/i18n/locales";
import { dayMonth } from "../../lib/i18n/format";
import { chartDate, chartIsoDay } from "../../lib/marketing/sample-chart";
import type { DemoSample } from "../../lib/marketing/sample-diagnosis";
import type { Tr } from "../../lib/i18n/tr";
import { moneyText, num } from "../sheet/num";

/** Placeholders the owner's design prints while the offer isn't set (lib/marketing/offer.ts). */
export const PENDING_DAYS = 7;
export const PENDING_LEAKS = 3;

/** "[7]" while the owner hasn't committed to a figure, "7" once they have — grouped the reader's way. */
export function offerFigure(value: number | null, pending: number, locale: AppLocale): string {
  return value === null ? `[${num(pending, 0, locale)}]` : num(value, 0, locale);
}

/** The landing's fixed figures, typed here once, never into a message (rule 3). */
export const LANDING_FIGURES = {
  checks: 36,
  markers: 36,
  fixes: 3,
  walkthroughMinutes: 30,
  connectMinutes: 2,
  questionsMinutes: 12,
  /** The size the page is built for, a month, in US dollars as the page has always said. */
  sizeLowUsd: 10_000,
  sizeHighUsd: 50_000,
  readMonths: 12,
  recordDays: 28,
  chartDays: 90,
  decisions: 1,
} as const;

/** "$10k" in English, as the page has always written it; the language's short form elsewhere. */
export function sizeUsd(usd: number, locale: AppLocale): string {
  if (locale === "en") return `$${Math.round(usd / 1000)}k`;
  return new Intl.NumberFormat(intlTag(locale), {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 0,
  }).format(usd);
}

/** The approval stamp's time: "15:00", in the reader's writing. */
export function stampTime(locale: AppLocale): string {
  if (locale === "en") return "15:00";
  return new Intl.DateTimeFormat(intlTag(locale), {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  }).format(new Date(Date.UTC(2026, 9, 1, 15, 0)));
}

/** "€ —" before the total is counted: the currency's sign where the language puts it. */
export function moneyDash(currency: string, locale: AppLocale): string {
  if (locale === "en") return "€ —";
  const parts = new Intl.NumberFormat(intlTag(locale), {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).formatToParts(0);
  let out = "";
  let dashed = false;
  for (const p of parts) {
    if (
      p.type === "integer" ||
      p.type === "group" ||
      p.type === "decimal" ||
      p.type === "fraction"
    ) {
      if (!dashed) out += "—";
      dashed = true;
    } else out += p.value;
  }
  return out.trim();
}

/** A chart day ("20 Jul" in English, as the chart has always printed it). */
export function chartDay(day: number, locale: AppLocale): string {
  return locale === "en" ? chartDate(day) : dayMonth(chartIsoDay(day), locale);
}

/**
 * The step-2 answer tiles. English prints the sample's own strings; other
 * languages format the same bounds (OPTION_BOUNDS) through the locale.
 */
export type OptionBound = { under: number } | { from: number; to: number } | { over: number };

export const OPTION_BOUNDS: Readonly<
  Record<DemoSample["id"], { money: boolean; bounds: readonly OptionBound[] }>
> = {
  shop: {
    money: true,
    bounds: [{ under: 600 }, { from: 600, to: 900 }, { from: 900, to: 1200 }, { over: 1200 }],
  },
  salon: {
    money: false,
    bounds: [{ from: 0, to: 5 }, { from: 6, to: 12 }, { from: 13, to: 20 }, { over: 20 }],
  },
};

export function optionWords(sample: DemoSample, tr: Tr, locale: AppLocale): string[] {
  if (locale === "en") return [...sample.record.options];
  const { money, bounds } = OPTION_BOUNDS[sample.id];
  const fig = (v: number) => (money ? moneyText(v, sample.currency, locale) : num(v, 0, locale));
  return bounds.map((b) =>
    "under" in b
      ? tr("s2.under", { a: fig(b.under) })
      : "over" in b
        ? tr("s2.over", { a: fig(b.over) })
        : tr("s2.between", { a: fig(b.from), b: fig(b.to) }),
  );
}

/** The step-2 fact's bounds: the picked tile's range, the sample's own figures. */
export function factWords(sample: DemoSample, tr: Tr, locale: AppLocale): string {
  const { money, bounds } = OPTION_BOUNDS[sample.id];
  const b = bounds[sample.record.picked];
  const fig = (v: number) => (money ? moneyText(v, sample.currency, locale) : num(v, 0, locale));
  const [low, high] = b && "from" in b ? [b.from, b.to] : [0, 0];
  return tr(`${sample.id}.fact`, { low: fig(low), high: fig(high) });
}
