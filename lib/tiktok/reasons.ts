// Why a TikTok sign-in came back to /connections without connecting — TikTok Ads.
// Pure, and safe to import in the browser.
//
// Meta's and Google's rule (review 2026-10-23, Session D #9): the URL carries
// only a reason CODE from this closed set; the screen says the fixed sentence
// for it from its catalogue ("connections.tiktok.reason.*"), and a code it
// doesn't know reads as the generic one. No text from a URL is ever shown.

export const TIKTOK_REASONS = {
  start_here:
    "Start the TikTok sign-in from SYB's Connections screen, with the button there. Nothing was sent to TikTok.",
  signed_out: "Sign in to SYB first, then connect TikTok again.",
  owner_only: "Only an owner can grant or take back this permission. Nothing was sent to TikTok.",
  unavailable: "TikTok Ads isn't set up yet.",
  phrase: "The confirmation phrase didn't match. Type it as shown, then start again.",
  already_connected: "TikTok is already connected. Revoke it first to connect again.",
  start_again: "That TikTok sign-in expired or was already used. Start again from Connections.",
  foreign:
    "That TikTok sign-in was started from a different SYB account. Sign in to SYB as that account, or start again.",
  tiktok_error: "TikTok sign-in didn't finish. Nothing was connected.",
  scope:
    "TikTok didn't grant exactly the permissions SYB asks for. Check the app's Scope of permission against the list on Connections, then try again.",
  no_advertisers:
    "TikTok showed SYB no ad account for that sign-in. Sign in with the TikTok login that runs your ads, then try again.",
  tiktok_auth:
    "TikTok didn't accept the sign-in. If TikTok is still checking SYB's app, wait until it has passed; otherwise start again.",
  tiktok_permission:
    "TikTok says SYB's app isn't allowed to read that ad account. Nothing was connected.",
  tiktok_busy:
    "TikTok was busy or didn't answer. Nothing was connected — try again in a few minutes.",
  tiktok_refused: "TikTok refused the sign-in. Nothing was connected.",
  internal: "Something went wrong on our side. Nothing was connected.",
} as const;

export type TikTokReason = keyof typeof TIKTOK_REASONS;

/** What an unknown code reads as. */
export const TIKTOK_GENERIC = "TikTok sign-in didn't finish. Nothing was connected.";

export function isTikTokReason(value: unknown): value is TikTokReason {
  return typeof value === "string" && Object.hasOwn(TIKTOK_REASONS, value);
}
