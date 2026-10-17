// The commercial facts the landing page states, in one place, so
// nothing on the page is a promise the business has not made.
//
// The price is not here: it is read from reportPrice() (lib/payments),
// the same value checkout charges, so the button and the receipt can
// never disagree.
//
// EXAMINER and GUARANTEE are null until the owner supplies them. While
// null, the page leaves that block out rather than printing a stand-in:
// an invented name or a refund promise nobody agreed to is worse than
// no block at all.

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
