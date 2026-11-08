// IBAN and BIC checks — P6-05 (rule 26 amended: money is prepared, never
// moved). Pure: no database, no network. An IBAN is accepted only when its
// country is one SYB knows, its length is that country's, and the ISO 7064
// mod-97 check gives 1. Anything else is refused with the reason, so a
// mistyped digit is caught before a payment is ever drafted.
//
// IBANs are sensitive: logs and proposals carry `maskIban(...)`, never the
// whole number.

/**
 * IBAN length per country, from the SWIFT IBAN registry as remembered (no
 * registry was fetched for this build). A country not listed is refused,
 * never guessed.
 */
export const IBAN_LENGTHS: Readonly<Record<string, number>> = {
  AD: 24,
  AE: 23,
  AL: 28,
  AT: 20,
  AZ: 28,
  BA: 20,
  BE: 16,
  BG: 22,
  BH: 22,
  BR: 29,
  BY: 28,
  CH: 21,
  CR: 22,
  CY: 28,
  CZ: 24,
  DE: 22,
  DK: 18,
  DO: 28,
  EE: 20,
  EG: 29,
  ES: 24,
  FI: 18,
  FO: 18,
  FR: 27,
  GB: 22,
  GE: 22,
  GI: 23,
  GL: 18,
  GR: 27,
  GT: 28,
  HR: 21,
  HU: 28,
  IE: 22,
  IL: 23,
  IQ: 23,
  IS: 26,
  IT: 27,
  JO: 30,
  KW: 30,
  KZ: 20,
  LB: 28,
  LC: 32,
  LI: 21,
  LT: 20,
  LU: 20,
  LV: 21,
  MC: 27,
  MD: 24,
  ME: 22,
  MK: 19,
  MR: 27,
  MT: 31,
  MU: 30,
  NL: 18,
  NO: 15,
  PK: 24,
  PL: 28,
  PS: 29,
  PT: 25,
  QA: 29,
  RO: 24,
  RS: 22,
  SA: 24,
  SC: 31,
  SE: 24,
  SI: 19,
  SK: 24,
  SM: 27,
  ST: 25,
  SV: 28,
  TL: 23,
  TN: 24,
  TR: 26,
  UA: 29,
  VA: 22,
  VG: 24,
  XK: 20,
};

/**
 * Countries in the SEPA scheme, as remembered: the EU, the EEA, and the
 * non-EU members that took part before this build. A SEPA file is offered
 * only when both ends are in it; anything else gets instructions only.
 */
export const SEPA_COUNTRIES: ReadonlySet<string> = new Set([
  "AT",
  "BE",
  "BG",
  "HR",
  "CY",
  "CZ",
  "DK",
  "EE",
  "FI",
  "FR",
  "DE",
  "GR",
  "HU",
  "IE",
  "IT",
  "LV",
  "LT",
  "LU",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SK",
  "SI",
  "ES",
  "SE",
  "IS",
  "LI",
  "NO",
  "CH",
  "GB",
  "GI",
  "MC",
  "SM",
  "VA",
  "AD",
]);

/**
 * The SEPA countries outside the EEA (the EU, Iceland, Liechtenstein and
 * Norway). The SCT rulebook makes the payee bank's BIC mandatory for a
 * transfer that involves a bank in one of these, so a file without it is
 * refused by the bank; such a payment needs the BIC to go in a file.
 */
export const SEPA_NON_EEA: ReadonlySet<string> = new Set([
  "CH",
  "GB",
  "GI",
  "MC",
  "SM",
  "VA",
  "AD",
]);

export type IbanRefusal = "empty" | "format" | "country" | "length" | "checksum";

export type IbanCheck =
  { ok: true; iban: string; country: string } | { ok: false; reason: IbanRefusal };

/** Pure: the electronic form: spaces and dashes gone, upper case. */
export function normalizeIban(raw: string): string {
  return raw.replace(/[\s-]+/g, "").toUpperCase();
}

/**
 * Pure: ISO 7064 mod-97-10 over an IBAN in electronic form. The first four
 * characters move to the end, letters become 10..35, and the remainder is
 * taken piece by piece so the number never leaves integer range.
 */
export function ibanMod97(iban: string): number {
  const moved = iban.slice(4) + iban.slice(0, 4);
  let rest = 0;
  for (const ch of moved) {
    const code = ch.charCodeAt(0);
    const digits = code >= 65 && code <= 90 ? String(code - 55) : ch;
    for (const d of digits) rest = (rest * 10 + (d.charCodeAt(0) - 48)) % 97;
  }
  return rest;
}

/** Pure: whether an IBAN is real-shaped: known country, its length, and mod-97 = 1. */
export function checkIban(raw: string): IbanCheck {
  const iban = normalizeIban(raw);
  if (iban === "") return { ok: false, reason: "empty" };
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]+$/.test(iban)) return { ok: false, reason: "format" };
  const country = iban.slice(0, 2);
  const length = IBAN_LENGTHS[country];
  if (length === undefined) return { ok: false, reason: "country" };
  if (iban.length !== length) return { ok: false, reason: "length" };
  // ISO 13616: the check digits a bank computes run 02..98. "00", "01" and
  // "99" never do, yet pass mod-97 for the IBAN whose digits are 97, 98, 02.
  const check = Number(iban.slice(2, 4));
  if (check < 2 || check > 98) return { ok: false, reason: "checksum" };
  if (ibanMod97(iban) !== 1) return { ok: false, reason: "checksum" };
  return { ok: true, iban, country };
}

/** Pure: an optional BIC (8 or 11 characters), normalised; null when it isn't one. */
export function checkBic(raw: string): string | null {
  const bic = raw.replace(/\s+/g, "").toUpperCase();
  return /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}(?:[A-Z0-9]{3})?$/.test(bic) ? bic : null;
}

/**
 * Pure: an IBAN as logs and proposals may show it: the country and the
 * last four characters, the rest hidden behind a fixed-width mask (so the
 * length isn't told either). "DE89370400440532013000" → "DE•• •••• 3000".
 * Never the whole number.
 */
export function maskIban(iban: string | null): string {
  if (iban === null || iban === "") return "";
  const n = normalizeIban(iban);
  if (n.length < 8) return `${n.slice(0, 2)}•• ••••`;
  return `${n.slice(0, 2)}•• •••• ${n.slice(-4)}`;
}

/** Pure: an IBAN in groups of four, the way a bank's form shows it. */
export function groupIban(iban: string): string {
  return (normalizeIban(iban).match(/.{1,4}/g) ?? []).join(" ");
}
