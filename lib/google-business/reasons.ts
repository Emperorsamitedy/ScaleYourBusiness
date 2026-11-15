// Why a Google sign-in came back to /connections without connecting — I-45a.
// Pure, and safe to import in the browser.
//
// The same rule as Meta's (review 2026-10-23, Session D #9): the URL carries
// only a reason CODE from this closed set, and the screen maps it to a fixed
// sentence here. A code it doesn't know reads as the generic sentence, so no
// text from a URL is ever shown as SYB's.

import type { Tr } from "../i18n/tr";

export const GOOGLE_REASONS = {
  start_here:
    "Start the Google sign-in from ScaleX's Connections screen, with the button there. Nothing was sent to Google.",
  signed_out: "Sign in to ScaleX first, then connect Google again.",
  owner_only: "Only an owner can grant or take back this permission. Nothing was sent to Google.",
  unavailable: "Reading reviews from Google isn't set up yet.",
  phrase: "The confirmation phrase didn't match. Type it as shown, then start again.",
  already_connected:
    "Google Business Profile is already connected. Revoke it first to connect another.",
  start_again: "That Google sign-in expired or was already used. Start again from Connections.",
  foreign:
    "That Google sign-in was started from a different ScaleX account. Sign in to ScaleX as that account, or start again.",
  google_error: "Google sign-in didn't finish. Nothing was connected.",
  scope:
    "Google didn't grant exactly the one permission ScaleX asks for. On Google's screen, allow the Business Profile permission, then try again.",
  no_refresh:
    "Google didn't give ScaleX lasting access. Start again: Google asks once more, and ScaleX needs that answer.",
  no_locations:
    "Google showed ScaleX no Business Profile for that Google account. Sign in with the account that manages your profile, then try again.",
  google_auth: "Google didn't accept the sign-in. Start again from Connections.",
  google_permission:
    "Google says ScaleX isn't allowed to read Business Profiles yet. Nothing was connected.",
  google_busy:
    "Google was busy or didn't answer. Nothing was connected — try again in a few minutes.",
  google_refused: "Google refused the sign-in. Nothing was connected.",
  internal: "Something went wrong on our side. Nothing was connected.",
} as const;

export type GoogleReason = keyof typeof GOOGLE_REASONS;

export const GOOGLE_GENERIC = "Google sign-in didn't finish. Nothing was connected.";

export function isGoogleReason(value: unknown): value is GoogleReason {
  return typeof value === "string" && Object.hasOwn(GOOGLE_REASONS, value);
}

/** The fixed sentence for a reason code read off the URL; anything else is the generic one. */
export function googleReasonMessage(reason: string | null | undefined): string {
  return isGoogleReason(reason) ? GOOGLE_REASONS[reason] : GOOGLE_GENERIC;
}

/** What the read beat last reported, in the owner's words (review_settings.google_read_outcome). */
export const GOOGLE_READ_OUTCOMES = {
  ok: "Read without trouble.",
  auth: "Google no longer accepts ScaleX's access, so reviews aren't being read. Revoke it here and connect again.",
  permission:
    "Google says ScaleX isn't allowed to read this Business Profile any more. Check that your Google account still manages it.",
  quota: "Google asked ScaleX to slow down. ScaleX tries again on its next daily read.",
  unavailable: "Google didn't answer. ScaleX tries again on its next daily read.",
  refused: "Google refused the read. ScaleX tries again on its next daily read.",
  fence: "ScaleX stopped a request that wasn't a read. Nothing was sent.",
  internal: "Something went wrong on our side. ScaleX tries again on its next daily read.",
} as const;

export type GoogleReadOutcome = keyof typeof GOOGLE_READ_OUTCOMES;

/**
 * The last read's outcome in words. L-4b: with a translator over
 * "reviewsWords" (googleRead.<outcome>), in the reader's language; without
 * one, the English above, as every caller has always had it.
 */
export function googleReadWords(outcome: string | null, tr?: Tr): string | null {
  if (outcome === null) return null;
  if (!Object.hasOwn(GOOGLE_READ_OUTCOMES, outcome)) return null;
  return tr ? tr(`googleRead.${outcome}`) : GOOGLE_READ_OUTCOMES[outcome as GoogleReadOutcome];
}
