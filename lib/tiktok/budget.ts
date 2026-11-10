// TikTok's budget arithmetic — TikTok Ads (specs/tiktok-ads-api-v1.md). Pure.
//
// TikTok takes a campaign budget as a float in the account currency's MAJOR
// units (`budget: 50.0`), to a per-currency precision: 0.01 for most, whole
// units for HUF, JPY, KRW and five others. SYB stores money in ISO 4217
// minor units (lib/core/money: HUF is fillér), so a HUF budget of
// 1 500,00 Ft is 150 000 here and 1500 to TikTok. The table is TikTok's
// "Budget verification ratio and value range for each currency" page, read
// 2026-11-08: [budget verification ratio, decimals TikTok accepts]. A
// currency TikTok doesn't list is refused, never guessed.
//
// The floor: a campaign's minimum daily budget is 50 × the currency's ratio
// (that page's campaign table; USD 50, HUF 50, JPY 5 000). TikTok's Budget
// page says 20 USD for the same thing; the two disagree, so SYB keeps the
// higher one (spec: verified false).

import { minorUnitExponent, money, roundMinorTo, toDecimalString } from "../core/money";

export const TIKTOK_BUDGET_CURRENCIES: Readonly<Record<string, readonly [number, 0 | 2]>> = {
  USD: [1, 2],
  EUR: [1, 2],
  JPY: [100, 0],
  HKD: [10, 2],
  GBP: [1, 2],
  MYR: [1, 2],
  RUB: [100, 2],
  ZAR: [10, 2],
  KRW: [1000, 0],
  AED: [1, 2],
  SAR: [1, 2],
  HUF: [1, 0],
  PLN: [4, 2],
  DKK: [10, 2],
  SEK: [10, 2],
  NOK: [10, 2],
  TRY: [10, 2],
  MXN: [10, 2],
  THB: [10, 2],
  AUD: [1, 2],
  CAD: [1, 2],
  NZD: [1, 2],
  SGD: [1, 2],
  CHF: [1, 2],
  CNY: [10, 2],
  DZD: [100, 2],
  ARS: [1, 2],
  BDT: [100, 2],
  BOB: [10, 2],
  BRL: [1, 2],
  CLP: [1000, 0],
  COP: [1000, 2],
  CRC: [1000, 2],
  CZK: [10, 2],
  EGP: [10, 2],
  GTQ: [10, 2],
  HNL: [10, 2],
  ISK: [100, 0],
  INR: [100, 2],
  IDR: [10000, 0],
  ILS: [1, 2],
  KES: [100, 2],
  MOP: [10, 2],
  TWD: [10, 0],
  NIO: [10, 2],
  NGN: [100, 2],
  PKR: [100, 2],
  PYG: [10000, 0],
  PEN: [1, 2],
  PHP: [50, 2],
  QAR: [1, 2],
  RON: [1, 2],
  UAH: [10, 2],
  UYU: [10, 2],
  VEF: [100000, 2],
  VND: [10000, 0],
};

/** The campaign-level base minimum daily budget, in major units, before the currency's ratio. */
export const TIKTOK_CAMPAIGN_MIN_DAILY_BASE = 50;

export class UnknownTikTokCurrencyError extends Error {
  constructor(currency: string) {
    super(
      `TikTok doesn't list ${currency} among the currencies it takes budgets in, so I won't set one. Nothing was changed.`,
    );
    this.name = "UnknownTikTokCurrencyError";
  }
}

function entry(currency: string): readonly [number, 0 | 2] {
  const e = TIKTOK_BUDGET_CURRENCIES[currency.toUpperCase()];
  if (!e) throw new UnknownTikTokCurrencyError(currency.toUpperCase());
  return e;
}

/**
 * Minor units → what TikTok is sent: major units at TikTok's precision,
 * and the minor amount that value really is (a HUF budget loses its
 * fillér). The guard runs on `sent_minor`, the number TikTok will hold.
 * `toward` (review 2026-11-08): round toward the budget before the change,
 * so what is sent never moves further than the owner approved — an
 * approved 50% raise of 5 003 Ft goes as 7 504 Ft, never 7 505 Ft (which
 * the ±50% guard would refuse). Without it, the nearest unit.
 */
export function toTikTokBudget(
  minor: number,
  currency: string,
  toward?: number,
): { value: number; sent_minor: number } {
  if (!Number.isSafeInteger(minor) || minor <= 0) {
    throw new RangeError("a budget must be a whole number of minor units above zero");
  }
  const [, decimals] = entry(currency);
  const exp = minorUnitExponent(currency.toUpperCase());
  const keep = Math.min(decimals, exp);
  const step = 10 ** (exp - keep);
  const mode =
    toward === undefined || toward === minor ? "nearest" : toward < minor ? "down" : "up";
  const sent_minor = roundMinorTo(minor, step, mode);
  if (sent_minor <= 0) throw new RangeError("that budget rounds to nothing in TikTok's precision");
  // TikTok takes major units as a JSON number: read from the exact decimal string, never divided.
  return { value: Number(toDecimalString(money(sent_minor, currency.toUpperCase()))), sent_minor };
}

/** What TikTok reports (a float in major units) → SYB minor units. */
export function fromTikTokBudget(value: number, currency: string): number {
  entry(currency);
  const exp = minorUnitExponent(currency.toUpperCase());
  return Math.round(value * 10 ** exp);
}

/** TikTok's campaign minimum daily budget in SYB minor units (50 × the ratio). */
export function tiktokMinDailyMinor(currency: string): number {
  const [ratio] = entry(currency);
  return TIKTOK_CAMPAIGN_MIN_DAILY_BASE * ratio * 10 ** minorUnitExponent(currency.toUpperCase());
}
