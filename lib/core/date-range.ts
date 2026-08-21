// DateRange — data-model-v1.md §3.3. `to: null` means ongoing.

import type { ISODate } from "./iso";

export interface DateRange {
  from: ISODate;
  /** null = ongoing (an open engagement, a still-running campaign). */
  to: ISODate | null;
}

export class InvalidDateRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidDateRangeError";
  }
}

/**
 * Validating constructor. Inputs are already-branded ISODates, so the only
 * rule left to enforce is ordering: a closed range must not end before it
 * starts. Same-day ranges are legal (a one-day campaign).
 * ISO dates compare correctly as strings.
 */
export function dateRange(from: ISODate, to: ISODate | null): DateRange {
  if (to !== null && to < from) {
    throw new InvalidDateRangeError(`range ends (${to}) before it starts (${from})`);
  }
  return { from, to };
}

export function isOngoing(range: DateRange): boolean {
  return range.to === null;
}
