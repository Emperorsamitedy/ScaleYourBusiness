// The sentences an ad proposal shows — P3-54. No imports: /content and the
// queue (client components) read them from here, and the proposal builder
// (lib/ads/adcreate.ts) writes the same words into the proposal it records.

/** The card's fixed sentence — what approving creates, and what it can't undo. */
export const CREATES_PAUSED_NOTE =
  "Creates paused; going live is a separate approval; created objects can't be deleted, only paused.";

export const AD_RUN_UNDO =
  "Everything is created paused, so nothing spends until you approve going live. Meta's campaigns, ad sets, creatives and ads can't be deleted once made, only paused, and paused they spend nothing.";

export const GO_LIVE_UNDO =
  "Pause it again: the campaign, its ad set and its ad go back to paused, and spending stops.";
