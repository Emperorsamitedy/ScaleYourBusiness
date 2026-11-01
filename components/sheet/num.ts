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

import { minorUnitExponent } from "../../lib/core/money";
import type { AppLocale } from "../../lib/i18n/locales";
import { intlNumber, intlMoney } from "../../lib/i18n/format";

function group(intPart: string): string {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
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
  const major = amount_minor / 10 ** minorUnitExponent(currency);
  return num(major, decimals, locale);
}

/** Money with its unit, for prose and buttons: "€290", "4 090 HUF". */
export function moneyText(
  amount_minor: number,
  currency: string,
  locale: AppLocale = "en",
): string {
  const exp = minorUnitExponent(currency);
  const major = amount_minor / 10 ** exp;
  const decimals = Number.isInteger(major) ? 0 : exp;
  const code = currency.toUpperCase();
  if (locale !== "en") return intlMoney(major, code, decimals, locale);
  const symbol = SYMBOLS[code];
  return symbol ? `${symbol}${num(major, decimals)}` : `${num(major, decimals)} ${code}`;
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
  if (locale !== "en") return intlMoney(amount_minor / 10 ** exp, code, exp, locale);
  const body = num(amount_minor / 10 ** exp, exp);
  const symbol = SYMBOLS[code];
  return symbol ? `${symbol}${body}` : `${body} ${code}`;
}

/** A signed delta: +2.1, −0.4, 0.0. */
export function delta(n: number, decimals = 1, locale: AppLocale = "en"): string {
  if (Number(Math.abs(n).toFixed(decimals)) === 0) return num(0, decimals, locale);
  return n > 0 ? `+${num(n, decimals, locale)}` : num(n, decimals, locale);
}
