// Whole units as typed → integer minor units. No database: the result view
// renders in the browser and imports this.

import { minorUnitExponent } from "../core/money";

/** Whole units → integer minor units of the currency (whole × whole: exact). */
export function toMinor(major: number, currency: string): number {
  return major * 10 ** minorUnitExponent(currency);
}
