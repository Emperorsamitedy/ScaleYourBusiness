// The profile fields the cash forecast reads — Phase 5 Session B. One place,
// so the bank (specs/question-bank-v1.json), the loader and the tests name
// the same keys.

/** 5.3e (bank 1.8.0): the cash the business has available today, Field<Money>. */
export const CASH_KEY = "costs.cash_available";
/** 5.3f (bank 1.8.0): the least the owner wants in the account, Field<Money>. */
export const BUFFER_KEY = "costs.cash_buffer";
/** 5.3c: the debt the business carries, Field<Money>. A total, not a repayment. */
export const DEBT_KEY = "costs.debt";
/** 4.2a and 4.2b: how customers pay, and through which provider. */
export const PAYMENT_METHODS_KEY = "revenue.payment.methods";
export const PAYMENT_PROVIDER_KEY = "revenue.payment.provider";
/** 4.1b: orders a month, stated (or measured, superseding it). */
export const ORDERS_MONTHLY_KEY = "revenue.order_count_monthly";

/** Where each missing input is asked: a gap links to its question, never a guess. */
export const CASH_ASK = {
  cash: "/intake?ask=5.3e",
  buffer: "/intake?ask=5.3f",
  costs: "/intake?ask=5.1",
  variable: "/intake?ask=5.2",
  offers: "/intake?ask=3.1",
  orders: "/intake?ask=4.1b",
  provider: "/intake?ask=4.2b",
  connect: "/connections",
} as const;
