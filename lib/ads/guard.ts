// The spend guardrails and Meta's budget arithmetic — P3-22b/c (Session D,
// layer D3). Pure: no database, no network. The SAME guard runs at
// generation (lib/ads/proposals.ts, budgetGuard) and again inside the
// executor's pre-flight and attempt (lib/execution/providers/meta.ts), so
// the two can never disagree about what is allowed.
//
//   ±50%     no single approval moves a daily budget by more than half
//   ceiling  the owner's stated monthly ad ceiling (question 8.1i) bounds
//            the whole account: every campaign's average day, plus the
//            change, × 30. A ceiling in another currency is never converted
//            (rule 1) — the change is refused, saying why
//   floor    never below Meta's minimum daily budget (executor only: the
//            generator never proposes a decrease)
//
// Every refusal is a sentence that names the number it hit.
//
// THE CURRENCY OFFSET. Meta takes budgets as integers in its own unit per
// currency: offset 100 = cents, offset 1 = whole units (HUF, JPY, KRW …).
// SYB stores money in ISO 4217 minor units (lib/core/money: HUF is fillér),
// so a HUF budget of 1 500,00 Ft is 150 000 here and 1 500 to Meta. The
// table is copied from Meta's Marketing API "Currencies" page, read
// 2026-10-19 — the page lists ELEVEN offset-1 currencies, not the fourteen
// the task text recalled. A currency Meta doesn't list is refused, never
// guessed: a wrong offset is a budget 100× off.

import type { Money } from "../core/money";
import { format, minorUnitExponent, money } from "../core/money";

/** P3-22c: no single change beyond this share of the current daily budget. */
export const MAX_CHANGE_SHARE = 0.5;

/**
 * Meta's currency offsets — the Marketing API "Currencies" page, read
 * 2026-10-19, every row except "credits" (FBZ), which is not a currency an
 * ad account can bill in. Offset 1: CLP, COP, CRC, HUF, ISK, IDR, JPY, KRW,
 * PYG, TWD, VND. Everything else listed: 100.
 */
export const META_CURRENCY_OFFSET: Readonly<Record<string, 1 | 100>> = {
  DZD: 100,
  ARS: 100,
  AUD: 100,
  BHD: 100,
  BDT: 100,
  BOB: 100,
  BGN: 100,
  BRL: 100,
  GBP: 100,
  CAD: 100,
  CLP: 1,
  CNY: 100,
  COP: 1,
  CRC: 1,
  HRK: 100,
  CZK: 100,
  DKK: 100,
  EGP: 100,
  EUR: 100,
  GTQ: 100,
  HNL: 100,
  HKD: 100,
  HUF: 1,
  ISK: 1,
  INR: 100,
  IDR: 1,
  ILS: 100,
  JPY: 1,
  JOD: 100,
  KES: 100,
  KRW: 1,
  LVL: 100,
  LTL: 100,
  MOP: 100,
  MYR: 100,
  MXN: 100,
  NZD: 100,
  NIO: 100,
  NGN: 100,
  NOK: 100,
  PKR: 100,
  PYG: 1,
  PEN: 100,
  PHP: 100,
  PLN: 100,
  QAR: 100,
  RON: 100,
  RUB: 100,
  SAR: 100,
  RSD: 100,
  SGD: 100,
  SKK: 100,
  ZAR: 100,
  SEK: 100,
  CHF: 100,
  TWD: 1,
  THB: 100,
  TRY: 100,
  AED: 100,
  UAH: 100,
  USD: 100,
  UYU: 100,
  VEF: 100,
  VND: 1,
  VES: 100,
};

export class UnknownMetaCurrencyError extends Error {
  readonly retryable = false;
  constructor(currency: string) {
    super(
      `Meta's currency table doesn't list ${currency}, so I won't send a budget in it — a wrong unit would be a budget 100× off. Nothing was changed.`,
    );
    this.name = "UnknownMetaCurrencyError";
  }
}

function offsetOf(currency: string): 1 | 100 {
  const offset = META_CURRENCY_OFFSET[currency.toUpperCase()];
  if (offset === undefined) throw new UnknownMetaCurrencyError(currency);
  return offset;
}

/**
 * Pure: SYB minor units → the integer Meta takes, rounded DOWN to Meta's
 * unit (never more than approved). `sent_minor` is what that integer is
 * back in SYB minor units — the number the guard must check, since it is
 * the number that is actually sent. A HUF budget goes out in whole forints.
 */
export function toMetaBudget(
  amountMinor: number,
  currency: string,
): { meta_value: number; sent_minor: number } {
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) {
    throw new RangeError(`a budget is a non-negative integer in minor units, got ${amountMinor}`);
  }
  const offset = offsetOf(currency);
  const scale = 10 ** minorUnitExponent(currency.toUpperCase());
  const metaValue =
    offset >= scale ? amountMinor * (offset / scale) : Math.floor(amountMinor / (scale / offset));
  return { meta_value: metaValue, sent_minor: fromMetaBudget(metaValue, currency) };
}

/** Pure: Meta's integer budget → SYB minor units. */
export function fromMetaBudget(metaValue: number, currency: string): number {
  if (!Number.isSafeInteger(metaValue) || metaValue < 0) {
    throw new RangeError(`Meta's budget is a non-negative integer, got ${metaValue}`);
  }
  const offset = offsetOf(currency);
  const scale = 10 ** minorUnitExponent(currency.toUpperCase());
  return offset >= scale ? Math.floor(metaValue / (offset / scale)) : metaValue * (scale / offset);
}

/**
 * The absolute floor, in SYB minor units: Meta's lowest documented daily
 * budget (impression-billed ad sets, "$1 a day") per currency.
 *
 * VERIFY AT BUILD — these are not copied from a Meta page. Meta's
 * Currencies page carries no minimum-budget column (read 2026-10-19), and
 * its Business Help Centre states the USD figures only. USD, EUR and GBP
 * are the "$1 a day" figure; HUF is a USD-equivalent placeholder. Two
 * backstops stand behind the table: the ad account's own `min_daily_budget`
 * (read live, and it wins when higher), and Meta's `validate_only` dry run,
 * which refuses anything Meta itself won't take before anything changes.
 * Minimums above this — clicks, likes, video views, low-frequency events —
 * depend on the ad sets' billing event, not the campaign objective, so they
 * are left to the dry run rather than guessed per objective.
 */
export const META_MIN_DAILY_BUDGET_MINOR: Readonly<Record<string, number>> = {
  USD: 100,
  EUR: 100,
  GBP: 100,
  HUF: 40_000,
};

/**
 * Pure: the floor for a campaign — the table's figure and the ad account's
 * reported minimum (SYB minor units), whichever is higher. Null = neither
 * is known, and a budget change is refused rather than guessed.
 */
export function dailyBudgetFloor(currency: string, accountMinMinor: number | null): number | null {
  const table = META_MIN_DAILY_BUDGET_MINOR[currency.toUpperCase()] ?? null;
  if (table === null) return accountMinMinor;
  return accountMinMinor === null ? table : Math.max(table, accountMinMinor);
}

export interface SpendGuardArgs {
  /** The daily budget (or, at generation, the average daily spend) before the change. */
  current_daily_minor: number;
  /** The daily budget after it — at the executor, the number actually sent. */
  proposed_daily_minor: number;
  currency: string;
  /** The whole account's average daily spend; defaults to this campaign's current. */
  account_daily_minor?: number;
  /** The owner's stated monthly ceiling (8.1i), when one exists. */
  monthly_ceiling?: Money | null;
  /** Meta's minimum daily budget, at the executor. */
  floor_minor?: number | null;
}

const fmt = (amount: number, currency: string) => format(money(amount, currency));

/** Pure: why a budget change may not go through, or null when it may. */
export function spendGuard(a: SpendGuardArgs): string | null {
  if (!(a.current_daily_minor > 0)) {
    return "the campaign's current daily budget is zero or unknown, so a change can't be held to 50% of it";
  }
  const share = (a.proposed_daily_minor - a.current_daily_minor) / a.current_daily_minor;
  if (Math.abs(share) > MAX_CHANGE_SHARE + 1e-9) {
    return `a ${Math.round(share * 100)}% change is beyond the ${MAX_CHANGE_SHARE * 100}% allowed in one approval`;
  }
  const floor = a.floor_minor ?? null;
  if (floor !== null && a.proposed_daily_minor < floor) {
    return `it would set the daily budget to ${fmt(a.proposed_daily_minor, a.currency)}, under Meta's minimum of ${fmt(floor, a.currency)} a day`;
  }
  const ceiling = a.monthly_ceiling ?? null;
  if (ceiling !== null && a.proposed_daily_minor > a.current_daily_minor) {
    if (ceiling.currency.toUpperCase() !== a.currency.toUpperCase()) {
      return `your ad ceiling is in ${ceiling.currency} and this campaign spends in ${a.currency} — I won't convert to compare them`;
    }
    const account = a.account_daily_minor ?? a.current_daily_minor;
    const projected = Math.round((account + (a.proposed_daily_minor - a.current_daily_minor)) * 30);
    if (projected > ceiling.amount_minor) {
      return `it would take monthly ad spend to about ${fmt(projected, a.currency)}, over your stated ceiling of ${fmt(ceiling.amount_minor, a.currency)}`;
    }
  }
  return null;
}
