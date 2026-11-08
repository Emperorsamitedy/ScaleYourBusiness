// The commercial facts the landing page states, in one place, so
// nothing on the page is a promise the business has not made.
//
// The price is not here: it is read from reportPrice() (lib/billing),
// the same value checkout charges, so the button and the receipt can
// never disagree.
//
// EXAMINER is null until the owner supplies one (GUARANTEE and
// DELIVERY_DAYS were set on 2026-11-07). While null, the landing page prints the owner's design's bracketed
// placeholder ("[3]", "[7]") in their place rather than inventing a value:
// a bracket reads as unfinished, an invented deadline or refund promise
// reads as a commitment nobody made.

export interface Examiner {
  name: string;
  /** e.g. "Founder" */
  role: string;
  /** Path under /public. */
  photo: string;
  /** One or two sentences, first person. */
  note: string;
}

export const EXAMINER: Examiner | null = null;

export interface Guarantee {
  /** Refund unless at least this many fixable leaks are found… */
  min_findings: number;
  /** …together worth more than the price. */
}

/** Decided by the owner on 2026-11-07: fewer than 3 fixable leaks, a full refund. */
export const GUARANTEE: Guarantee | null = { min_findings: 3 };

/** Working days from order to signed report. null until the owner commits to one. */
/** Decided by the owner on 2026-11-07: 7 working days. */
export const DELIVERY_DAYS: number | null = 7;
