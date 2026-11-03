// When the money from a sale reaches the bank — Phase 5 Session B (P5-07).
//
// A table, as data (rule 4): every code of the bank's payment_provider
// vocabulary (question 4.2b) → the days between a sale and the payout that
// carries it, as a low–high range. These are planning assumptions from each
// provider's usual payout schedule, not a measurement of the owner's own
// payouts (nothing reads payouts: rule 26), so the screen labels them
// ASSUMED with PAYOUT_SOURCE. The cautious end of the forecast takes the
// slow end of the range, the hopeful end the fast one.
//
// A business whose customers pay only in ways no provider sits between
// (4.2a: cash, a bank transfer, an invoice) is paid the same day. With no
// provider answer the range is the widest: a sale may take a week to land.
//
// L-4b: the words (why, the day range) in the reader's language through
// optional words (lib/cash/words.ts), English by default; a provider's
// name comes from the catalogue by its code, brand names kept.

import type { Words } from "./words";
import { cashEnglish, countText } from "./words";

/** Days from a sale to the payout that carries it. */
export interface PayoutDays {
  low: number;
  high: number;
  /** How the screen names the provider. */
  label: string;
}

export const PAYOUT_DAYS: Readonly<Record<string, PayoutDays>> = {
  stripe: { low: 2, high: 7, label: "Stripe" },
  paypal: { low: 0, high: 1, label: "PayPal" },
  square: { low: 1, high: 2, label: "Square" },
  adyen: { low: 1, high: 3, label: "Adyen" },
  mollie: { low: 1, high: 3, label: "Mollie" },
  klarna: { low: 7, high: 14, label: "Klarna" },
  shopify_payments: { low: 2, high: 5, label: "Shopify Payments" },
  apple_google_pay: { low: 1, high: 3, label: "Apple Pay or Google Pay" },
  local_provider: { low: 1, high: 5, label: "your local payment provider" },
  bank_only: { low: 0, high: 0, label: "your bank" },
  other: { low: 1, high: 7, label: "your payment provider" },
};

/** No provider named: anything from the same day to a week. */
export const PAYOUT_UNKNOWN: PayoutDays = { low: 0, high: 7, label: "an unnamed provider" };

/** Paid without a provider in between: the money is there the day of the sale. */
export const PAYOUT_DIRECT: PayoutDays = { low: 0, high: 0, label: "paid directly" };

/** Payment methods (bank vocabulary payment_method) that go through a provider's payout. */
export const PROVIDER_METHODS: ReadonlySet<string> = new Set([
  "card",
  "online_payment",
  "installments",
]);

/** Connector providers that are themselves a payment provider of the vocabulary. */
export const SERIES_PROVIDER_CODE: Readonly<Record<string, string>> = {
  stripe: "stripe",
  square: "square",
};

export const PAYOUT_SOURCE =
  "a planning assumption from the provider's usual payout schedule, not a measurement of your payouts";

export interface PayoutChoice {
  days: PayoutDays;
  /** The bank code it came from, or null. */
  code: string | null;
  /** In words: why these days. */
  why: string;
}

/**
 * Pure: the payout range for a business, from its stated provider (4.2b),
 * else the measured series' own provider, else the widest range — unless
 * its stated payment methods (4.2a) never go through a provider.
 */
export function payoutFor(
  args: {
    provider: string | null;
    methods: readonly string[] | null;
    series_provider: string | null;
  },
  words: Words = cashEnglish(),
): PayoutChoice {
  const { tr } = words;
  const source = tr("payout.source");
  if (args.methods !== null && args.methods.length > 0) {
    const through = args.methods.some((m) => PROVIDER_METHODS.has(m));
    if (!through) {
      return { days: PAYOUT_DIRECT, code: null, why: tr("payout.direct") };
    }
  }
  const stated = args.provider !== null ? PAYOUT_DAYS[args.provider] : undefined;
  if (stated && args.provider !== null) {
    return {
      days: stated,
      code: args.provider,
      why: tr("payout.stated", {
        provider: tr(`payout.provider.${args.provider}`),
        days: dayRange(stated, words),
        source,
      }),
    };
  }
  const fromSeries =
    args.series_provider !== null ? SERIES_PROVIDER_CODE[args.series_provider] : undefined;
  const measured = fromSeries ? PAYOUT_DAYS[fromSeries] : undefined;
  if (fromSeries && measured) {
    return {
      days: measured,
      code: fromSeries,
      why: tr("payout.series", {
        provider: tr(`payout.provider.${fromSeries}`),
        days: dayRange(measured, words),
        source,
      }),
    };
  }
  return {
    days: PAYOUT_UNKNOWN,
    code: null,
    why: tr("payout.unknown", { days: PAYOUT_UNKNOWN.high }),
  };
}

/** "2–5 days", "the same day", "1 day". */
export function dayRange(
  d: Pick<PayoutDays, "low" | "high">,
  words: Words = cashEnglish(),
): string {
  const { tr, locale } = words;
  const one = (n: number) => (n === 0 ? tr("payout.sameDay") : tr("payout.days", { count: n }));
  if (d.low === d.high) return one(d.low);
  return d.low === 0
    ? tr("payout.sameDayTo", { count: d.high })
    : tr("payout.range", { low: countText(d.low, locale), high: d.high });
}
