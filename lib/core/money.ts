// Money — data-model-v1.md §3.3.
//
// Integer minor units plus an explicit ISO 4217 currency. Never a float,
// never a bare number (non-negotiable rule 1). A profile can hold HUF
// revenue and EUR ad spend at once; arithmetic across currencies is a
// refusal, not a coercion — totals either share a currency or are grouped
// by currency. FX conversion is not this module's job: aggregates that
// cross currencies carry their own rate and date (§3.3), in a later session.

import { currencyRow, formatMoney, moneyDigits } from "./currency-table";
import { isIsoCurrency } from "./currencies";

export { isIsoCurrency };

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
  if (!isIsoCurrency(currency)) {
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

/** a ÷ b rounded half away from zero, in BigInt — the one division money ever takes. */
function divRound(a: bigint, b: bigint): bigint {
  if (b === 0n) throw new InvalidMoneyError("division by zero");
  const negative = a < 0n !== b < 0n;
  const absA = a < 0n ? -a : a;
  const absB = b < 0n ? -b : b;
  const q = absA / absB;
  const rounded = (absA % absB) * 2n >= absB ? q + 1n : q;
  return negative ? -rounded : rounded;
}

function safe(n: bigint): number {
  if (n > BigInt(Number.MAX_SAFE_INTEGER) || n < -BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new InvalidMoneyError("the result is too large to hold exactly");
  }
  return Number(n);
}

/**
 * The multi-market spec, hard rule 1: scale money by a ratio of integers,
 * exactly — one BigInt division, rounded half away from zero. Shares,
 * percentages and per-day rates are numerator/denominator pairs, never a
 * float factor.
 */
export function scaleMoney(m: Money, numerator: number, denominator: number): Money {
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || denominator === 0) {
    throw new InvalidMoneyError("a money ratio is two whole numbers, the second not zero");
  }
  const checked = money(m.amount_minor, m.currency);
  const r = safe(divRound(BigInt(checked.amount_minor) * BigInt(numerator), BigInt(denominator)));
  return money(r === 0 ? 0 : r, checked.currency);
}

/** A ratio of two amounts in one currency, in basis points (1 % = 100), rounded half away from zero. */
export function ratioOf(part: Money, whole: Money): number {
  assertSameCurrency(part, whole, "compare");
  return safe(divRound(BigInt(part.amount_minor) * 10_000n, BigInt(whole.amount_minor)));
}

/**
 * Integer minor units ÷ a whole count (days, orders, months), rounded half
 * away from zero — the exact way to take a mean or a per-unit amount.
 */
export function perUnit(amountMinor: number, count: number): number {
  if (!Number.isSafeInteger(amountMinor) || !Number.isSafeInteger(count) || count === 0) {
    throw new InvalidMoneyError("a per-unit amount is a whole amount over a whole, non-zero count");
  }
  const r = safe(divRound(BigInt(amountMinor), BigInt(count)));
  return r === 0 ? 0 : r;
}

/** Integer minor units × a factor taken at its written decimal, rounded once. */
export function scaleMinor(amountMinor: number, factor: number): number {
  if (!Number.isSafeInteger(amountMinor)) throw new InvalidMoneyError("minor units are whole");
  if (!Number.isFinite(factor)) throw new InvalidMoneyError(`factor must be finite, got ${factor}`);
  const { num, den } = exactFraction(factor);
  const r = safe(divRound(BigInt(amountMinor) * num, den));
  return r === 0 ? 0 : r;
}

/** Integer minor units × a / b, rounded once — a ratio of two whole numbers. */
export function scaleMinorBy(amountMinor: number, numerator: number, denominator: number): number {
  if (![amountMinor, numerator, denominator].every(Number.isSafeInteger) || denominator === 0) {
    throw new InvalidMoneyError("minor units scale by a ratio of two whole numbers");
  }
  const r = safe(divRound(BigInt(amountMinor) * BigInt(numerator), BigInt(denominator)));
  return r === 0 ? 0 : r;
}

/** Round minor units to a multiple of `step` minor units, half away from zero. */
export function roundMinorTo(
  amountMinor: number,
  step: number,
  mode: "nearest" | "down" | "up" = "nearest",
): number {
  if (!Number.isSafeInteger(amountMinor) || !Number.isSafeInteger(step) || step <= 0) {
    throw new InvalidMoneyError("rounding is a whole amount to a positive whole step");
  }
  const rem = ((amountMinor % step) + step) % step;
  const down = amountMinor - rem;
  const r =
    mode === "down"
      ? down
      : mode === "up"
        ? rem === 0
          ? amountMinor
          : down + step
        : divRoundStep(amountMinor, step);
  return r === 0 ? 0 : r;
}

function divRoundStep(amountMinor: number, step: number): number {
  return safe(divRound(BigInt(amountMinor), BigInt(step))) * step;
}

/** a ÷ b as basis points (1 % = 100), for two whole amounts in the same unit. */
export function ratioBp(a: number, b: number): number {
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || b === 0) {
    throw new InvalidMoneyError("a ratio of whole amounts, the second not zero");
  }
  return safe(divRound(BigInt(a) * 10_000n, BigInt(b)));
}

/** A number's written decimal ("0.3", "1.15", "2e-3") as an exact fraction of integers. */
function exactFraction(factor: number): { num: bigint; den: bigint } {
  const written = String(factor);
  const m = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(written);
  if (!m) throw new InvalidMoneyError(`factor ${written} can't be read exactly`);
  const frac = m[3] ?? "";
  let num = BigInt(`${m[2]}${frac}`);
  let den = 10n ** BigInt(frac.length);
  const exp = Number(m[4] ?? "0");
  if (exp > 0) num *= 10n ** BigInt(exp);
  if (exp < 0) den *= 10n ** BigInt(-exp);
  return { num: m[1] === "-" ? -num : num, den };
}

/**
 * Multiply by a scalar (quantity, percentage as fraction). The factor is
 * taken as the decimal it is written as — 0.3, not 0.29999999999999998 —
 * and the product is computed in integers and rounded once, half away
 * from zero (hard rule 1: no float on any monetary path).
 */
export function multiply(m: Money, factor: number): Money {
  if (!Number.isFinite(factor)) {
    throw new InvalidMoneyError(`factor must be finite, got ${factor}`);
  }
  const checked = money(m.amount_minor, m.currency);
  const { num, den } = exactFraction(factor);
  const r = safe(divRound(BigInt(checked.amount_minor) * num, den));
  return money(r === 0 ? 0 : r, checked.currency);
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

/**
 * Format for display. Rounding, decimals and presentation come from the
 * currency table (lib/core/currency-table): HUF shows whole forints with
 * Hungarian separators whoever reads it; a currency the table marks
 * "reader" (EUR) follows the reader's language. Built from digits, never
 * from a divided float (the multi-market spec §A.2, D42).
 */
export function format(m: Money, locale = "en"): string {
  const checked = money(m.amount_minor, m.currency);
  if (currencyRow(checked.currency).presentation === "home" || locale.startsWith("en")) {
    return formatMoney(checked);
  }
  // A currency written many ways (EUR): the reader's language, the table's
  // decimals and rounding, Intl handed the exact decimal string.
  const d = moneyDigits(checked);
  const exact = `${d.negative ? "-" : ""}${d.whole}${d.fraction ? `.${d.fraction}` : ""}`;
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: checked.currency,
    minimumFractionDigits: d.decimals,
    maximumFractionDigits: d.decimals,
  }).format(exact as unknown as number);
}

/**
 * The amount in major units as a plain decimal string — "4990.00" for
 * 499 000 fillér, "1200" for ¥1 200, "-0.05" — for files a machine reads
 * (idea 49's accountant export). Built from the integer's digits, never by
 * dividing: no float touches it, so 9 007 199 254 740 991 minor units
 * print exactly. A dot is the decimal mark and nothing groups thousands.
 */
export function toDecimalString(m: Money): string {
  const checked = money(m.amount_minor, m.currency);
  const exponent = minorUnitExponent(checked.currency);
  const negative = checked.amount_minor < 0;
  const digits = String(Math.abs(checked.amount_minor));
  if (exponent === 0) return `${negative ? "-" : ""}${digits}`;
  const padded = digits.padStart(exponent + 1, "0");
  const whole = padded.slice(0, padded.length - exponent);
  const fraction = padded.slice(padded.length - exponent);
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

/* ── reading amounts people write (review 2026-10-23, #4) ── */

/**
 * Which mark is the decimal one. "dot_decimal" is 1,234.56 (a comma, a
 * space or nothing groups the thousands); "comma_decimal" is 1.234,56.
 */
export type DecimalStyle = "dot_decimal" | "comma_decimal";

export type AmountReading =
  | {
      ok: true;
      negative: boolean;
      /** Whole digits, no separators. */
      whole: string;
      /** Fraction digits as written, no separators. */
      fraction: string;
      /** The style this value alone proves, or null when it proves none. */
      proves: DecimalStyle | null;
    }
  | {
      ok: false;
      /**
       * unreadable: not an amount at all.
       * ambiguous: a lone separator before exactly three digits ("1.200",
       *   "12,000") is a thousands mark in one style and a decimal in the
       *   other, and no style was given to settle it.
       * style_conflict: the value only reads in the other style.
       */
      reason: "unreadable" | "ambiguous" | "style_conflict";
    };

const GROUP_RE = /[ \u00a0\u202f\u2009']/;
const GROUP_RE_G = /[ \u00a0\u202f\u2009']/g;

/**
 * Read an amount as written ("1.234,56", "1,234.50", "12,50", "1 200",
 * "€ 12.50", "1.200 Ft") into exact digits, with no float anywhere.
 * Symbols and currency letters around it are ignored. A lone "." or ","
 * before exactly three digits is AMBIGUOUS unless `style` settles it;
 * everything else reads one way only.
 */
export function readAmount(raw: string, style: DecimalStyle | null = null): AmountReading {
  const unreadable = { ok: false, reason: "unreadable" } as const;
  let s = raw
    .replace(/[^\d.,\- \u00a0\u202f\u2009']/g, "")
    .trim()
    .replace(/^'+|'+$/g, "")
    .trim();
  let negative = false;
  if (s.startsWith("-")) {
    negative = true;
    s = s.slice(1).trim();
  }
  if (s === "" || s.includes("-") || !/\d/.test(s)) return unreadable;

  const styleOf = (decimalMark: string): DecimalStyle =>
    decimalMark === "." ? "dot_decimal" : "comma_decimal";
  const done = (whole: string, fraction: string, proves: DecimalStyle | null): AmountReading => {
    if (proves !== null && style !== null && proves !== style) {
      return { ok: false, reason: "style_conflict" };
    }
    return { ok: true, negative, whole: whole === "" ? "0" : whole, fraction, proves };
  };

  // Spaces (or apostrophes) group the thousands, so any mark left is the decimal.
  if (GROUP_RE.test(s)) {
    const m = /^(\d{1,3}(?:[ \u00a0\u202f\u2009']\d{3})+)(?:([.,])(\d+))?$/.exec(s);
    if (!m || m[1] === undefined) return unreadable;
    const whole = m[1].replace(GROUP_RE_G, "");
    return m[2] === undefined ? done(whole, "", null) : done(whole, m[3] ?? "", styleOf(m[2]));
  }

  const dots = (s.match(/\./g) ?? []).length;
  const commas = (s.match(/,/g) ?? []).length;
  if (dots === 0 && commas === 0) return /^\d+$/.test(s) ? done(s, "", null) : unreadable;

  if (dots > 0 && commas > 0) {
    // Both: the last one is the decimal mark, the other groups thousands.
    const decimal = s.lastIndexOf(".") > s.lastIndexOf(",") ? "." : ",";
    const group = decimal === "." ? "," : ".";
    const g = group === "." ? "\\." : ",";
    const d = decimal === "." ? "\\." : ",";
    const m = new RegExp(`^(\\d{1,3}(?:${g}\\d{3})+)${d}(\\d+)$`).exec(s);
    if (!m || m[1] === undefined) return unreadable;
    return done(m[1].split(group).join(""), m[2] ?? "", styleOf(decimal));
  }

  const mark = dots > 0 ? "." : ",";
  if (dots + commas > 1) {
    // Repeated, so it can only be the thousands mark.
    const g = mark === "." ? "\\." : ",";
    if (!new RegExp(`^\\d{1,3}(?:${g}\\d{3})+$`).test(s)) return unreadable;
    return done(s.split(mark).join(""), "", mark === "." ? "comma_decimal" : "dot_decimal");
  }
  const [lead = "", tail = ""] = s.split(mark);
  if (!/^\d*$/.test(lead) || !/^\d+$/.test(tail)) return unreadable;
  const couldGroup = tail.length === 3 && lead.length >= 1 && lead.length <= 3 && lead[0] !== "0";
  if (!couldGroup) return done(lead, tail, styleOf(mark));
  // "1.200": a thousands mark in one style, a decimal in the other.
  if (style === null) return { ok: false, reason: "ambiguous" };
  return style === styleOf(mark) ? done(lead, tail, null) : done(`${lead}${tail}`, "", null);
}

export type MinorReading =
  { ok: true; minor: number } | { ok: false; reason: "too_precise" | "too_large" };

/**
 * Exact digits → integer minor units at the currency's ISO 4217 exponent.
 * THE one conversion every import, connector and chat amount goes through
 * (rule 1): digits are concatenated, never multiplied as a float, and a
 * fraction more precise than the currency allows is refused, never
 * rounded. Trailing zeros past the exponent are not extra precision.
 */
export function digitsToMinor(
  negative: boolean,
  whole: string,
  fraction: string,
  currency: string,
): MinorReading {
  const exponent = minorUnitExponent(currency.toUpperCase());
  if (fraction.length > exponent && /[^0]/.test(fraction.slice(exponent))) {
    return { ok: false, reason: "too_precise" };
  }
  const value = Number(`${whole}${fraction.slice(0, exponent).padEnd(exponent, "0")}`);
  if (!Number.isSafeInteger(value)) return { ok: false, reason: "too_large" };
  return { ok: true, minor: value === 0 ? 0 : negative ? -value : value };
}

export type AmountMinorResult =
  | { ok: true; minor: number; proves: DecimalStyle | null }
  | {
      ok: false;
      reason: "unreadable" | "ambiguous" | "style_conflict" | "too_precise" | "too_large";
    };

/** readAmount, then digitsToMinor: an amount as written → exact minor units, or why not. */
export function parseAmountMinor(
  raw: string,
  currency: string,
  style: DecimalStyle | null = null,
): AmountMinorResult {
  const read = readAmount(raw, style);
  if (!read.ok) return read;
  const minor = digitsToMinor(read.negative, read.whole, read.fraction, currency);
  return minor.ok ? { ok: true, minor: minor.minor, proves: read.proves } : minor;
}

/**
 * "1 234,50", "1,234.50", "€1234.5", "1234" → integer minor units for the
 * currency, exactly. Null when unreadable, more precise than the currency
 * allows, or ambiguous ("1.200") with no style to settle it.
 */
export function parseMoneyMinor(
  raw: string,
  currency: string,
  style: DecimalStyle | null = null,
): number | null {
  const r = parseAmountMinor(raw, currency, style);
  return r.ok ? r.minor : null;
}

/**
 * What a column of written amounts says about its style, the way a file's
 * dates settle day-first or month-first: proven by the file, or the
 * owner's word when only ambiguous values appear. A file that proves both
 * styles, or contradicts what the owner said, is refused.
 */
export function settleDecimalStyle(
  cells: readonly string[],
  stated: DecimalStyle | null,
):
  | { ok: true; style: DecimalStyle | null; proven: boolean }
  | { ok: false; reason: "both" | "contradicts_stated" | "ambiguous" } {
  const proven = new Set<DecimalStyle>();
  let ambiguous = false;
  for (const c of cells) {
    if (c.trim() === "") continue;
    const r = readAmount(c, null);
    if (r.ok && r.proves !== null) proven.add(r.proves);
    else if (!r.ok && r.reason === "ambiguous") ambiguous = true;
  }
  if (proven.size > 1) return { ok: false, reason: "both" };
  const [only] = [...proven];
  if (only !== undefined) {
    if (stated !== null && stated !== only) return { ok: false, reason: "contradicts_stated" };
    return { ok: true, style: only, proven: true };
  }
  if (ambiguous && stated === null) return { ok: false, reason: "ambiguous" };
  return { ok: true, style: stated, proven: false };
}

export function isDecimalStyle(v: unknown): v is DecimalStyle {
  return v === "dot_decimal" || v === "comma_decimal";
}

/** The refusal sentences an import uses, so every import asks the same question. */
export const DECIMAL_STYLE_MESSAGES = {
  ambiguous:
    "amounts like 1.200 could be one thousand two hundred or one point two: say whether the dot or the comma separates thousands",
  both: "the amounts in this file are written both ways (1.234,56 and 1,234.56), so I can't read them",
  contradicts_stated:
    "you said which mark separates thousands, but the file has amounts that only read the other way",
} as const;
