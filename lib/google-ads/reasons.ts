// Why a Google Ads sign-in came back to /connections without connecting —
// P2-20. Pure, and safe to import in the browser.
//
// The same rule as Meta's and Business Profile's: the URL carries only a
// reason CODE from this closed set, the screen maps it to a fixed sentence
// (connections.googleAds.reason.<code> in the catalogues; the English below
// is the source), and a code it doesn't know reads as the generic sentence,
// so no text from a URL is ever shown as SYB's.

export const GOOGLE_ADS_REASONS = {
  start_here:
    "Start the Google Ads sign-in from SYB's Connections screen, with the button there. Nothing was sent to Google.",
  signed_out: "Sign in to SYB first, then connect Google Ads again.",
  owner_only: "Only an owner can grant or take back this permission. Nothing was sent to Google.",
  unavailable: "Google Ads isn't set up yet.",
  phrase: "The confirmation phrase didn't match. Type it as shown, then start again.",
  already_connected: "Google Ads is already connected. Revoke it first to connect another account.",
  start_again: "That Google sign-in expired or was already used. Start again from Connections.",
  foreign:
    "That Google sign-in was started from a different SYB account. Sign in to SYB as that account, or start again.",
  google_error: "Google sign-in didn't finish. Nothing was connected.",
  scope:
    "Google didn't grant exactly the one permission SYB asks for. On Google's screen, allow the Google Ads permission, then try again.",
  no_refresh:
    "Google didn't give SYB lasting access. Start again: Google asks once more, and SYB needs that answer.",
  no_accounts:
    "Google showed SYB no Google Ads account for that Google account. Sign in with the account that has access to your ads, then try again.",
  managers_only:
    "That Google account reaches only manager accounts. SYB connects the ad account itself: give your Google account access to it, then try again.",
  access_level:
    "Google hasn't approved SYB's Google Ads access for real ad accounts yet. Nothing was connected.",
  google_auth: "Google didn't accept the sign-in. Start again from Connections.",
  google_permission: "Google says SYB isn't allowed into that Google Ads account. Nothing was connected.",
  google_busy:
    "Google was busy or didn't answer. Nothing was connected — try again in a few minutes.",
  google_refused: "Google refused the sign-in. Nothing was connected.",
  internal: "Something went wrong on our side. Nothing was connected.",
} as const;

export type GoogleAdsReason = keyof typeof GOOGLE_ADS_REASONS;

export const GOOGLE_ADS_GENERIC = "Google sign-in didn't finish. Nothing was connected.";

export function isGoogleAdsReason(value: unknown): value is GoogleAdsReason {
  return typeof value === "string" && Object.hasOwn(GOOGLE_ADS_REASONS, value);
}

/** The fixed sentence for a reason code read off the URL; anything else is the generic one. */
export function googleAdsReasonMessage(reason: string | null | undefined): string {
  return isGoogleAdsReason(reason) ? GOOGLE_ADS_REASONS[reason] : GOOGLE_ADS_GENERIC;
}
