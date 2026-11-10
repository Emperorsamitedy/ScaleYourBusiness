// The number grammar's formatting half — ux-spec §2 "Figures".
//
// One rule per kind of figure, so a column never mixes them:
//   - money is integer minor units + ISO currency (CLAUDE.md rule 1),
//     shown at a fixed number of decimals chosen per column;
//   - thousands are grouped with a comma ("€2,140"), as the owner's
//     instrument-screen designs set them;
//   - a unit is separated from its number by a space.
// Pure functions; no locale guessing, so the server and the browser
// print the same characters.
//
// L-1 (TASKS-LANGUAGES.md, rule 3): each takes the reader's language. In
// English — the default, and what every caller passes today — the output
// is exactly the hand-written grammar above. In any other language the
// figure goes through Intl in that language's own conventions
// ("1.234,56 €" in German, "1 234,56 €" in French), with the business's
// currency always named. Money is still integer minor units until this
// edge; nothing here converts one currency into another.

import { minorUnitExponent, roundMinorTo } from "../../lib/core/money";
import { currencyRow, displayDecimals } from "../../lib/core/currency-table";
import type { AppLocale } from "../../lib/i18n/locales";
import { intlNumber, intlMoney } from "../../lib/i18n/format";

function group(intPart: string): string {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** A caller's stray fraction of a minor unit is rounded once, here at the display edge. */
const wholeUnits = (n: number): number => (Number.isSafeInteger(n) ? n : Math.round(n));

/**
 * Hard rule 1: minor units as an exact decimal string in major units at
 * `decimals` places ("4090", "49.50", "-0.05"), rounded half away from
 * zero in integers — never a divided float.
 */
function exactMajor(amount: number, exp: number, decimals: number): string {
  const whole = wholeUnits(amount);
  const rounded = decimals < exp ? roundMinorTo(whole, 10 ** (exp - decimals)) : whole;
  const digits = String(Math.abs(rounded)).padStart(exp + 1, "0");
  const intPart = digits.slice(0, digits.length - exp);
  const shown = exp === 0 ? "" : digits.slice(digits.length - exp);
  const frac = decimals <= exp ? shown.slice(0, decimals) : shown.padEnd(decimals, "0");
  return `${rounded < 0 ? "-" : ""}${intPart}${frac ? `.${frac}` : ""}`;
}

/** An exact decimal string in the hand-written English grammar: grouped, a true minus, never minus zero. */
function grammar(exact: string): string {
  const negative = exact.startsWith("-");
  const [i = "0", f] = (negative ? exact.slice(1) : exact).split(".");
  const body = f ? `${group(i)}.${f}` : group(i);
  return negative && /[1-9]/.test(exact) ? `−${body}` : body;
}

/** The currency table's own rounding step, when the table lists the currency (HUF: whole forints). */
function tableStep(code: string): number {
  try {
    return currencyRow(code).rounding_increment_minor;
  } catch {
    return 1;
  }
}

/** Decimals a ledger shows: the table's (HUF: 0), else the ISO exponent. */
function ledgerDecimals(code: string, exp: number): number {
  try {
    return displayDecimals(code);
  } catch {
    return exp;
  }
}

/** A plain number at fixed decimals: 12345.6 → "12,345.6". Negative uses a true minus. */
export function num(n: number, decimals = 0, locale: AppLocale = "en"): string {
  if (locale !== "en") return intlNumber(n, decimals, locale);
  const fixed = Math.abs(n).toFixed(decimals);
  const [i = "0", f] = fixed.split(".");
  const body = f ? `${group(i)}.${f}` : group(i);
  return n < 0 && Number(fixed) !== 0 ? `−${body}` : body;
}

/**
 * Money in major units at a column's fixed decimals, no unit: the unit
 * lives in the column header ("EUR / month"), not in every cell.
 * decimals defaults to 0 — whole units — and a column must pass the same
 * value for every row.
 */
export function moneyFig(
  amount_minor: number,
  currency: string,
  decimals = 0,
  locale: AppLocale = "en",
): string {
  const exact = exactMajor(amount_minor, minorUnitExponent(currency), decimals);
  // Intl formats a decimal string exactly (ECMA-402 2023); no float in between.
  if (locale !== "en") return intlNumber(exact as unknown as number, decimals, locale);
  return grammar(exact);
}

/** Money with its unit, for prose and buttons: "€290", "4 090 HUF". */
export function moneyText(
  amount_minor: number,
  currency: string,
  locale: AppLocale = "en",
): string {
  const exp = minorUnitExponent(currency);
  const code = currency.toUpperCase();
  // The table's rounding first (HUF: whole forints), then decimals only when needed.
  const rounded = roundMinorTo(wholeUnits(amount_minor), tableStep(code));
  const decimals = rounded % 10 ** exp === 0 ? 0 : exp;
  const exact = exactMajor(rounded, exp, decimals);
  if (locale !== "en") return intlMoney(exact as unknown as number, code, decimals, locale);
  const symbol = SYMBOLS[code];
  return symbol ? `${symbol}${grammar(exact)}` : `${grammar(exact)} ${code}`;
}

const SYMBOLS: Record<string, string> = { EUR: "€", USD: "$", GBP: "£" };

/** Money with its unit at the currency's full decimals, for ledgers: "€290.00". */
export function moneyExact(
  amount_minor: number,
  currency: string,
  locale: AppLocale = "en",
): string {
  const exp = minorUnitExponent(currency);
  const code = currency.toUpperCase();
  const decimals = ledgerDecimals(code, exp);
  const exact = exactMajor(amount_minor, exp, decimals);
  if (locale !== "en") return intlMoney(exact as unknown as number, code, decimals, locale);
  const body = grammar(exact);
  const symbol = SYMBOLS[code];
  return symbol ? `${symbol}${body}` : `${body} ${code}`;
}

/** A signed delta: +2.1, −0.4, 0.0. */
export function delta(n: number, decimals = 1, locale: AppLocale = "en"): string {
  if (Number(Math.abs(n).toFixed(decimals)) === 0) return num(0, decimals, locale);
  return n > 0 ? `+${num(n, decimals, locale)}` : num(n, decimals, locale);
}
