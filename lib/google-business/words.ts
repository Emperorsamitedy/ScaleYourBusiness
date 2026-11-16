// What /connections and /reviews say about the Google permission — I-45a.
// Pure, and safe to import in the browser. Plain words: what Google's
// permission can do, what SYB does with it (since 2026-11-16: approved
// replies and approved hours changes too), how to take it back, and what
// has to be in place before it can work.

/** Said beside the consent, in one breath. */
export const GOOGLE_WHAT_IT_CAN_DO =
  "Google's permission can also post replies to your reviews and edit your Business Profile listing. ScaleX reads your reviews with it, and posts a reply or changes your opening hours only after you approve that exact change. You can revoke it any time.";

/** Said while the connection is off for want of SYB's setup. */
export const GOOGLE_NOT_SET_UP =
  "Not set up yet. Google lets apps read Business Profile reviews only after it approves them, and ScaleX's approval isn't in place yet. Until then, forward Google's review emails or paste a review.";

/** What must be true before it works. */
export const GOOGLE_NEEDS: readonly string[] = [
  "ScaleX's approval from Google to use the Business Profile APIs (Google's own review of ScaleX).",
  "You sign in with the Google account that manages your Business Profile, and allow the one permission Google asks about.",
  "If you manage more than one location, you pick the one ScaleX reads.",
];

/** Said beside the connect button: what connecting does and doesn't do. */
export const GOOGLE_NOTHING_WRITTEN =
  "Connecting records your consent and reads your reviews once a day. ScaleX posts a reply or changes your opening hours only after you approve that exact change, and changes nothing else on your listing.";

/** Said beside revoke. */
export const GOOGLE_REVOKE_NOTE =
  "Revoking deletes ScaleX's access here at once, and ScaleX stops reading. Reviews already read stay on Reviews until you remove them or their year is up. To remove ScaleX on Google's side too, open your Google Account's Security page, then Third-party connections.";

/** Said when a connection's consent predates the write lines (I-45a lifted). */
export const GOOGLE_RECONSENT =
  "Reconnect Google Business Profile on Connections to allow replies and hours changes: your consent there was given when ScaleX only read reviews. Nothing was sent to Google.";

/** On /reviews: how the Google reviews got there. */
export const GOOGLE_READ_NOTE = "Read from your Google Business Profile.";
