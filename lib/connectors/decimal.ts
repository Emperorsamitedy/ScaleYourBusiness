// Decimal strings → integer minor units, exactly (rule 1).
//
// Shopify and WooCommerce send money as decimal strings ("12.50"). Parsing
// those through a float would put 0.1-style rounding into revenue before it
// ever reached Money. This splits the string instead: whole digits and
// fraction digits are concatenated at the currency's ISO exponent, and
// anything more precise than the currency allows is a refusal, not a round.

import { minorUnitExponent } from "../core/money";

export class DecimalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecimalError";
  }
}

const DECIMAL_RE = /^(-)?(\d+)(?:\.(\d+))?$/;

/** "12.50" in EUR → 1250; "-5.00" → -500; "1200" in JPY → 1200. */
export function decimalToMinor(amount: string, currency: string): number {
  const match = DECIMAL_RE.exec(amount.trim());
  if (!match) throw new DecimalError(`"${amount}" is not a decimal amount`);
  const negative = match[1] === "-";
  const whole = match[2] ?? "";
  const fraction = match[3] ?? "";
  const exponent = minorUnitExponent(currency.toUpperCase());

  if (fraction.length > exponent && /[^0]/.test(fraction.slice(exponent))) {
    throw new DecimalError(
      `"${amount}" is more precise than ${currency.toUpperCase()} minor units allow`,
    );
  }
  const digits = `${whole}${fraction.slice(0, exponent).padEnd(exponent, "0")}`;
  const value = Number(digits);
  if (!Number.isSafeInteger(value)) {
    throw new DecimalError(`"${amount}" is too large to hold exactly`);
  }
  if (value === 0) return 0;
  return negative ? -value : value;
}
