// The currency table — the multi-market spec §A.2.
//
// Seeded, not inferred: specs/currencies-v1.json is the data, migration
// 0104 seeds the `currencies` table from it, and a test holds the two
// equal. This module reads the same file, so display and rounding are pure
// and synchronous while the database keeps the reference rows.
//
// Every figure here is built from integer digits: no division, no
// Intl.NumberFormat on a float, no hard-coded 2. HUF is the trap: ISO 4217
// gives it two minor digits, but the fillér was withdrawn in 1999, so its
// rounding increment is 100 minor units — whole forints — and a rendered
// "35 412,50 Ft" is a bug.

import table from "../../specs/currencies-v1.json";

export interface CurrencyRow {
  code: string;
  minor_units: number;
  /** The smallest step an amount rounds to, in minor units (HUF: 100 — whole forints). */
  rounding_increment_minor: number;
  /** The step a list price rounds to (HUF: 50 000 — 500 forints). */
  price_rounding_increment_minor: number;
  symbol: string;
  symbol_position: "before" | "after";
  thousands_sep: string;
  decimal_sep: string;
  /** What a payment processor requires amounts to be divisible by (Stripe HUF: 100). */
  processor_amount_divisor_minor: number;
  processor_notes: string | null;
  /**
   * "home": the row's own symbol and separators in every surface (HUF);
   * "reader": the reader's language through Intl, with the row's decimals
   * and rounding (EUR, written differently across the euro area).
   */
  presentation: "home" | "reader";
}

export const CURRENCY_ROWS: readonly CurrencyRow[] = (table as { rows: CurrencyRow[] }).rows;

const BY_CODE = new Map(CURRENCY_ROWS.map((r) => [r.code, r]));

export class CurrencyTableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CurrencyTableError";
  }
}

export function currencyRow(code: string): CurrencyRow {
  const row = BY_CODE.get(code);
  if (!row) throw new CurrencyTableError(`${code} isn't in the currency table`);
  return row;
}

/** Digits shown after the decimal mark: the minor units the rounding step leaves visible. */
export function displayDecimals(code: string): number {
  const r = currencyRow(code);
  let decimals = r.minor_units;
  let step = r.rounding_increment_minor;
  while (decimals > 0 && step % 10 === 0) {
    decimals -= 1;
    step /= 10;
  }
  return decimals;
}

function assertInteger(n: number, what: string): void {
  if (!Number.isSafeInteger(n))
    throw new CurrencyTableError(`${what} must be a whole number of minor units`);
}

/** Round half away from zero to a multiple of `step` — integers only. */
export function roundToStep(amountMinor: number, step: number): number {
  assertInteger(amountMinor, "an amount");
  assertInteger(step, "a step");
  if (step <= 0) throw new CurrencyTableError("a rounding step is positive");
  const sign = amountMinor < 0 ? -1 : 1;
  const abs = Math.abs(amountMinor);
  const rem = abs % step;
  const down = abs - rem;
  const rounded = rem * 2 >= step ? down + step : down;
  return rounded === 0 ? 0 : sign * rounded;
}

/** The currency's own rounding (HUF: whole forints). */
export function roundForCurrency(amountMinor: number, code: string): number {
  return roundToStep(amountMinor, currencyRow(code).rounding_increment_minor);
}

/** A list price's rounding (HUF: the nearest 500 forints). */
export function roundPrice(amountMinor: number, code: string): number {
  return roundToStep(amountMinor, currencyRow(code).price_rounding_increment_minor);
}

function group(digits: string, sep: string): string {
  let out = "";
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += sep;
    out += digits[i];
  }
  return out;
}

/** Round to whole major units (for headline figures like "€22,800"). */
export function roundToWhole(amountMinor: number, code: string): number {
  return roundToStep(amountMinor, 10 ** currencyRow(code).minor_units);
}

/**
 * The digits of a rounded amount: its whole part and the fraction to show.
 * From the integer's digits only — never a division.
 */
export function moneyDigits(
  m: { amount_minor: number; currency: string },
  opts: { whole?: boolean } = {},
): { negative: boolean; whole: string; fraction: string; decimals: number; rounded: number } {
  const r = currencyRow(m.currency);
  const rounded = opts.whole
    ? roundToWhole(m.amount_minor, m.currency)
    : roundForCurrency(m.amount_minor, m.currency);
  const digits = String(Math.abs(rounded)).padStart(r.minor_units + 1, "0");
  const whole = r.minor_units === 0 ? digits : digits.slice(0, digits.length - r.minor_units);
  const decimals = opts.whole ? 0 : displayDecimals(m.currency);
  const fraction =
    decimals === 0 ? "" : digits.slice(digits.length - r.minor_units).slice(0, decimals);
  return { negative: rounded < 0, whole, fraction, decimals, rounded };
}

/**
 * The amount as its currency shows it: rounded by the table, grouped and
 * marked by the table, the symbol where the table puts it. "35 413 Ft",
 * "€1,234.56", "\u22124 990 Ft". Built from the integer's digits only.
 */
export function formatMoney(
  m: { amount_minor: number; currency: string },
  opts: { whole?: boolean } = {},
): string {
  const r = currencyRow(m.currency);
  const d = moneyDigits(m, opts);
  const number = `${group(d.whole, r.thousands_sep)}${d.fraction ? r.decimal_sep + d.fraction : ""}`;
  const body =
    r.symbol_position === "before" ? `${r.symbol}${number}` : `${number}\u00a0${r.symbol}`;
  return d.negative ? `\u2212${body}` : body;
}

/** §A.2: a processor's divisibility rule, asserted at the billing boundary. */
export function assertProcessorAmount(m: { amount_minor: number; currency: string }): void {
  const r = currencyRow(m.currency);
  assertInteger(m.amount_minor, "a billed amount");
  if (m.amount_minor % r.processor_amount_divisor_minor !== 0) {
    throw new CurrencyTableError(
      `${m.currency} amounts must be divisible by ${r.processor_amount_divisor_minor} minor units for the payment processor`,
    );
  }
}
