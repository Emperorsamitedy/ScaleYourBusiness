// ISODate — the calendar-date half of the spec's ISO types (data-model-v1.md).
// Branded so a random string cannot pose as a validated date; every ISODate
// in the system comes through isoDate(). ISODateTime arrives with Field<T>
// (P0-14), which is its first consumer.

declare const ISODateBrand: unique symbol;

/** A validated "YYYY-MM-DD" calendar date. Construct via isoDate(). */
export type ISODate = string & { readonly [ISODateBrand]: true };

export class InvalidISODateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidISODateError";
  }
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Validating constructor: shape and real calendar existence (no Feb 30). */
export function isoDate(value: string): ISODate {
  if (!ISO_DATE_RE.test(value)) {
    throw new InvalidISODateError(`expected "YYYY-MM-DD", got "${value}"`);
  }
  // Date.UTC normalises overflow (2026-02-30 → March 2) — reject anything
  // that doesn't round-trip to the same components.
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  const parsed = new Date(Date.UTC(y, m - 1, d));
  if (
    parsed.getUTCFullYear() !== y ||
    parsed.getUTCMonth() !== m - 1 ||
    parsed.getUTCDate() !== d
  ) {
    throw new InvalidISODateError(`"${value}" is not a real calendar date`);
  }
  return value as ISODate;
}
