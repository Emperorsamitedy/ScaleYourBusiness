// Where bookings come from, by name — pure, so the connector service, the
// report and the watch can all import it without a cycle.

/**
 * The connections row an account's imported bookings files live under:
 * purpose "measure" (its observations feed the same derivations, anomaly
 * checks and watch as any connector's), no secret, no scopes. It is not a
 * ProviderId: nothing can connect to it, the sync runner never pulls it,
 * and the connections list leaves it out (specs/bookings.md §3).
 */
export const BOOKINGS_IMPORT_PROVIDER = "bookings_import";

/** Owner-facing names for measured sources that aren't connectors. */
export const NON_CONNECTOR_SOURCE_LABELS: Readonly<Record<string, string>> = {
  [BOOKINGS_IMPORT_PROVIDER]: "Bookings export",
  // TikTok Ads measures through its one execute consent (lib/connectors/measured-sources).
  tiktok_ads: "TikTok Ads",
};
