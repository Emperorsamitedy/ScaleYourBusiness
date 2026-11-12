// I-54a: where an imported bank balance lives, shared by the import (which
// writes it) and the cash forecast and track record (which only read it).
// Kept apart so the readers don't import the writer (lib/cash/fence.test.ts).

/** The balance import connection's provider id. Never in a scope registry: it holds no credential. */
export const BALANCE_IMPORT_PROVIDER = "balance_import";

/** The metric an imported statement writes: the closing balance of each day it covers. */
export const BALANCE_METRIC = "cash.balance";

/** D52: the money in each day of an imported statement, when it has a credit or signed-amount column. */
export const MONEY_IN_METRIC = "cash.money_in.daily";

/** A statement balance this many days old or newer stands in for cash today. */
export const BALANCE_FRESH_DAYS = 7;
