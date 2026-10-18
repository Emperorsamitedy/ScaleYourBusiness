// The commercial facts the landing page states, in one place, so
// nothing on the page is a promise the business has not made.
//
// The price is not here: it is read from reportPrice() (lib/payments),
// the same value checkout charges, so the button and the receipt can
// never disagree.
//
// EXAMINER, GUARANTEE and DELIVERY_DAYS are null until the owner supplies
// them. While null, the landing page prints the owner's design's bracketed
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

export const GUARANTEE: Guarantee | null = null;

/** Working days from order to signed report. null until the owner commits to one. */
export const DELIVERY_DAYS: number | null = null;
