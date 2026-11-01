// Reading a figure the person typed into the intake — L-2 of
// TASKS-LANGUAGES.md. Pure, so the browser and the tests share it.
//
// People write numbers their own way: "1.234,56" in German, "1 234,56" in
// French (an ordinary, a no-break or a narrow no-break space between the
// thousands), "1,234.56" in English. Every unambiguous way is accepted,
// whatever the screen's language, through the one reader every import
// already uses (lib/core/money readAmount) — no float anywhere until the
// screen needs a number.
//
// What is NOT guessed: a lone "." or "," before exactly three digits
// ("1.200", "12,000") is a thousands mark in one convention and a decimal
// in the other. The person's language makes one reading likelier, never
// certain, so the screen asks which they meant — the same question the
// imports ask (settleDecimalStyle) — and records only their answer.

import { readAmount } from "../core/money";

export type TypedAmount =
  | { kind: "empty" }
  /** One reading only: a canonical decimal ("1234.56", "-3", "0.5"). */
  | { kind: "value"; decimal: string }
  /** Two readings: thousands-grouped first ("1200"), then decimal ("1.2"). */
  | { kind: "ambiguous"; grouped: string; decimal: string }
  | { kind: "unreadable" };

function canonical(negative: boolean, whole: string, fraction: string): string {
  const w = whole.replace(/^0+(?=\d)/, "");
  const f = fraction.replace(/0+$/, "");
  const body = f === "" ? w : `${w}.${f}`;
  return negative && /[1-9]/.test(body) ? `-${body}` : body;
}

/** Pure: what a typed figure says — one value, two possible values, or nothing readable. */
export function readTypedAmount(raw: string): TypedAmount {
  if (raw.trim() === "") return { kind: "empty" };
  const read = readAmount(raw, null);
  if (read.ok)
    return { kind: "value", decimal: canonical(read.negative, read.whole, read.fraction) };
  if (read.reason !== "ambiguous") return { kind: "unreadable" };
  // "1.200": read it both ways; each style settles it one way.
  const asGrouped = readAmount(raw, raw.includes(".") ? "comma_decimal" : "dot_decimal");
  const asDecimal = readAmount(raw, raw.includes(".") ? "dot_decimal" : "comma_decimal");
  if (!asGrouped.ok || !asDecimal.ok) return { kind: "unreadable" };
  return {
    kind: "ambiguous",
    grouped: canonical(asGrouped.negative, asGrouped.whole, asGrouped.fraction),
    decimal: canonical(asDecimal.negative, asDecimal.whole, asDecimal.fraction),
  };
}

/** Pure: how many decimals a canonical decimal carries ("1.25" → 2). */
export const decimalsOf = (decimal: string): number => decimal.split(".")[1]?.length ?? 0;
