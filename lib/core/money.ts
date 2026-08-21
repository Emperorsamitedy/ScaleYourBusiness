// Money — data-model-v1.md §3.3.
//
// Integer minor units plus an explicit ISO 4217 currency. Never a float,
// never a bare number (non-negotiable rule 1). A profile can hold HUF
// revenue and EUR ad spend at once; arithmetic across currencies is a
// refusal, not a coercion — totals either share a currency or are grouped
// by currency. FX conversion is not this module's job: aggregates that
// cross currencies carry their own rate and date (§3.3), in a later session.

export interface Money {
  /** Integer count of minor units (fillér, cent). Never a float. */
  amount_minor: number;
  /** ISO 4217 code, e.g. "HUF", "EUR". */
  currency: string;
}

export class CurrencyMismatchError extends Error {
  constructor(left: string, right: string, operation: string) {
    super(
      `Refusing to ${operation} across currencies (${left} vs ${right}) — ` +
        `convert explicitly with an FX rate, or group with totalsByCurrency()`,
    );
    this.name = "CurrencyMismatchError";
  }
}

export class InvalidMoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidMoneyError";
  }
}

const CURRENCY_RE = /^[A-Z]{3}$/;

// Minor-unit exponent per ISO 4217. Default is 2; zero- and three-decimal
// currencies are listed. HUF is 2 — amount_minor is fillér (§3.3), even
// though cash fillér is withdrawn; display formatting is a separate concern.
const CURRENCY_EXPONENT: Readonly<Record<string, number>> = {
  BIF: 0,
  CLP: 0,
  DJF: 0,
  GNF: 0,
  ISK: 0,
  JPY: 0,
  KMF: 0,
  KRW: 0,
  PYG: 0,
  RWF: 0,
  UGX: 0,
  VND: 0,
  VUV: 0,
  XAF: 0,
  XOF: 0,
  XPF: 0,
  BHD: 3,
  IQD: 3,
  JOD: 3,
  KWD: 3,
  LYD: 3,
  OMR: 3,
  TND: 3,
};

export function minorUnitExponent(currency: string): number {
  return CURRENCY_EXPONENT[currency] ?? 2;
}

/** Validating constructor. Every Money in the system should come through here. */
export function money(amount_minor: number, currency: string): Money {
  if (!Number.isSafeInteger(amount_minor)) {
    throw new InvalidMoneyError(
      `amount_minor must be a safe integer, got ${amount_minor} — ` +
        `floats and unsafe magnitudes silently corrupt totals`,
    );
  }
  if (!CURRENCY_RE.test(currency)) {
    throw new InvalidMoneyError(`currency must be a three-letter ISO 4217 code, got "${currency}"`);
  }
  return { amount_minor, currency };
}

function assertSameCurrency(a: Money, b: Money, operation: string): void {
  if (a.currency !== b.currency) {
    throw new CurrencyMismatchError(a.currency, b.currency, operation);
  }
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b, "add");
  return money(a.amount_minor + b.amount_minor, a.currency);
}

export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b, "subtract");
  return money(a.amount_minor - b.amount_minor, a.currency);
}

/**
 * Multiply by a scalar (quantity, percentage as fraction). The result is
 * rounded half away from zero to stay in integer minor units; callers that
 * need a different rounding policy round the factor themselves first.
 */
export function multiply(m: Money, factor: number): Money {
  if (!Number.isFinite(factor)) {
    throw new InvalidMoneyError(`factor must be finite, got ${factor}`);
  }
  const product = m.amount_minor * factor;
  const rounded = Math.sign(product) * Math.round(Math.abs(product));
  return money(rounded === 0 ? 0 : rounded, m.currency);
}

/**
 * Sum monies that must all share one currency. Throws CurrencyMismatchError
 * on the first mismatch — a mixed list refuses to total rather than
 * producing a number that means nothing (non-negotiable rule 1).
 * The expected currency is explicit so an empty list still totals to a
 * well-defined zero.
 */
export function sum(items: readonly Money[], currency: string): Money {
  let acc = money(0, currency);
  for (const item of items) {
    acc = add(acc, item); // throws on mismatch
  }
  return acc;
}

/**
 * Total a mixed-currency list by grouping — the only legal way to "total"
 * across currencies without an explicit FX conversion.
 */
export function totalsByCurrency(items: readonly Money[]): ReadonlyMap<string, Money> {
  const groups = new Map<string, Money>();
  for (const item of items) {
    const existing = groups.get(item.currency);
    groups.set(
      item.currency,
      existing ? add(existing, item) : money(item.amount_minor, item.currency),
    );
  }
  return groups;
}

/** Format for display in the given locale, respecting the currency's minor-unit exponent. */
export function format(m: Money, locale = "en"): string {
  const exponent = minorUnitExponent(m.currency);
  const major = m.amount_minor / 10 ** exponent;
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: m.currency,
    minimumFractionDigits: exponent,
    maximumFractionDigits: exponent,
  }).format(major);
}
