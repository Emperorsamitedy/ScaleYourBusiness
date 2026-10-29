// Abandoned carts, measured — idea 47. Pure: no database, no clock, no model.

/** The pinned numbers, tested at their boundaries. */
export const CARTS = {
  /** Each sync reads the checkouts started in this many days (the window and the one before). */
  read_days: 60,
  /** Stored carts older than this are deleted. */
  retention_days: 90,
} as const;
