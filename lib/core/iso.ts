// ISODate / ISODateTime — the spec's ISO types (data-model-v1.md).
// Branded so a random string cannot pose as a validated date; every value
// comes through its constructor.

declare const ISODateBrand: unique symbol;
declare const ISODateTimeBrand: unique symbol;

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

/** A validated ISO 8601 timestamp with an explicit zone. Construct via isoDateTime(). */
export type ISODateTime = string & { readonly [ISODateTimeBrand]: true };

// Timezone must be explicit (Z or offset): observed_at answers "when was
// this true", and a zoneless timestamp answers it differently in every zone.
const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

export function isoDateTime(value: string): ISODateTime {
  if (!ISO_DATETIME_RE.test(value) || Number.isNaN(Date.parse(value))) {
    throw new InvalidISODateError(
      `expected an ISO 8601 timestamp with explicit zone (e.g. "2026-08-20T14:30:00Z"), got "${value}"`,
    );
  }
  // The date component must be real too — Date.parse normalises overflow.
  isoDate(value.slice(0, 10));
  return value as ISODateTime;
}
