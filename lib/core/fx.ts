// FX — the multi-market spec §A.3. Pure.
//
// One source: the ECB's daily reference rates, quoted as units of a
// currency per one euro ("391.48" HUF). A rate is kept as the decimal
// string the ECB published, never parsed into a float: conversion scales
// both sides to integers and divides once, in BigInt, rounding half away
// from zero to the target's own currency step.
//
// Every conversion carries the rate, the date it used and the source, on
// the converted value itself. Nothing is ever recomputed at today's rate:
// convertFromStored reproduces a conversion from what was stored with it.
//
// EUR here is a reporting projection for SYB's own cross-market roll-ups
// (§A.4's reporting_eur) — never storage, never a computation step, never
// a comparison basis for a business's own figures.

import { currencyRow, roundToStep } from "./currency-table";
import type { Money } from "./money";
import { money } from "./money";

export const ECB_SOURCE = "ECB daily reference";

export interface FxRate {
  /** The currency the rate prices, e.g. "HUF". */
  currency: string;
  /** "YYYY-MM-DD", the ECB's reference date. */
  date: string;
  /** Units of `currency` per 1 EUR, as published: "391.48". */
  per_eur: string;
  source: string;
}

/** Money that was converted, carrying how (§A.1's fx fields). */
export interface ConvertedMoney extends Money {
  fx_rate_to_eur: string;
  fx_rate_date: string;
  fx_source: string;
}

export class FxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FxError";
  }
}

const RATE = /^\d{1,12}(\.\d{1,10})?$/;

/** "391.48" → { units: 39148n, scale: 2 } — exact. */
function parseRate(s: string): { units: bigint; scale: number } {
  if (!RATE.test(s)) throw new FxError(`"${s}" isn't a rate`);
  const [whole, frac = ""] = s.split(".");
  const units = BigInt(`${whole}${frac}`);
  if (units === 0n) throw new FxError("a rate of zero converts nothing");
  return { units, scale: frac.length };
}

/** a ÷ b rounded half away from zero, in BigInt. */
function divRound(a: bigint, b: bigint): bigint {
  const negative = a < 0n !== b < 0n;
  const absA = a < 0n ? -a : a;
  const absB = b < 0n ? -b : b;
  const q = absA / absB;
  const r = absA % absB;
  const rounded = r * 2n >= absB ? q + 1n : q;
  return negative ? -rounded : rounded;
}

function toSafe(n: bigint): number {
  if (n > BigInt(Number.MAX_SAFE_INTEGER) || n < -BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new FxError("the converted amount is too large to hold exactly");
  }
  return Number(n);
}

/**
 * amount in `from` → EUR at this rate: eur_minor = from_minor × 10^eurDigits
 * × 10^scale ÷ (10^fromDigits × rate_units). One division, then EUR's step.
 */
export function toEur(m: Money, rate: FxRate): ConvertedMoney {
  if (rate.currency !== m.currency) {
    throw new FxError(`a ${rate.currency} rate can't convert ${m.currency}`);
  }
  if (m.currency === "EUR") {
    throw new FxError("EUR needs no conversion — keep the amount as it is");
  }
  const from = currencyRow(m.currency);
  const eur = currencyRow("EUR");
  const { units, scale } = parseRate(rate.per_eur);
  const num = BigInt(m.amount_minor) * 10n ** BigInt(eur.minor_units + scale);
  const den = 10n ** BigInt(from.minor_units) * units;
  const eurMinor = roundToStep(toSafe(divRound(num, den)), eur.rounding_increment_minor);
  return {
    ...money(eurMinor, "EUR"),
    fx_rate_to_eur: rate.per_eur,
    fx_rate_date: rate.date,
    fx_source: rate.source,
  };
}

/**
 * Reproduce a stored conversion from its stored rate and date — never at
 * today's rate. The original amount and the converted value must agree.
 */
export function convertFromStored(original: Money, converted: ConvertedMoney): ConvertedMoney {
  return toEur(original, {
    currency: original.currency,
    date: converted.fx_rate_date,
    per_eur: converted.fx_rate_to_eur,
    source: converted.fx_source,
  });
}
