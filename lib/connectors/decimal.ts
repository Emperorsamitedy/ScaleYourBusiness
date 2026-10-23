// Decimal strings → integer minor units, exactly (rule 1).
//
// Shopify and WooCommerce send money as decimal strings ("12.50"). Parsing
// those through a float would put 0.1-style rounding into revenue before it
// ever reached Money. This reads the API's own machine format (a dot, no
// grouping) and hands the digits to lib/core/money.ts's digitsToMinor, the
// one exact conversion every import, connector and chat amount shares
// (review 2026-10-23, #4): anything more precise than the currency allows
// is a refusal, not a round. Amounts people wrote ("1.234,56") go through
// readAmount there instead, which knows a lone "1.200" is ambiguous.

import { digitsToMinor } from "../core/money";

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
  const r = digitsToMinor(match[1] === "-", match[2] ?? "", match[3] ?? "", currency);
  if (r.ok) return r.minor;
  throw new DecimalError(
    r.reason === "too_precise"
      ? `"${amount}" is more precise than ${currency.toUpperCase()} minor units allow`
      : `"${amount}" is too large to hold exactly`,
  );
}
