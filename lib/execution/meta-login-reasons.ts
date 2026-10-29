// Why a Facebook sign-in came back to /connections without connecting —
// review 2026-10-23, Session D #9. Pure, and safe to import in the browser.
//
// The flow used to hand /connections its sentence in `?message=`, and the
// Execution section showed whatever text the URL carried as SYB's own: a
// link from anywhere could put a phishing sentence inside the consent
// screen. Now the URL carries only a reason CODE from this closed set, and
// the screen maps it to a fixed sentence here. A code it doesn't know reads
// as the generic sentence — nothing from the URL is ever shown.

export const CONNECTIONS_REASONS = {
  start_here:
    "Start Facebook sign-in from SYB's Connections screen, with the button there. Nothing was sent to Meta.",
  signed_out: "Sign in to SYB first, then connect Meta again.",
  owner_only: "Only an owner can grant or take back write access. Nothing was sent to Meta.",
  unavailable: "Facebook sign-in isn't available yet. Use your own Meta app instead.",
  provider: "That isn't a Meta connection SYB offers.",
  phrase: "The confirmation phrase didn't match. Type it as shown, then start again.",
  already_connected: "That Meta connection is already connected. Disconnect it first.",
  start_again: "That Facebook sign-in expired or was already used. Start again from Connections.",
  foreign:
    "That Facebook sign-in was started from a different SYB account. Sign in to SYB as that account, or start again.",
  meta_error: "Facebook sign-in didn't finish. Nothing was connected.",
  no_pages:
    "Meta showed SYB no Pages for that Facebook account. In Meta's dialog, choose the Page (and its Instagram account) you want SYB to publish to, then try again.",
  no_ad_accounts:
    "Meta showed SYB no ad accounts for that Facebook account. In Meta's dialog, choose the ad account you want SYB to manage, then try again.",
  meta_auth:
    "Facebook sign-in didn't finish: Meta didn't accept the sign-in. Start again from Connections.",
  meta_permission:
    "Facebook sign-in didn't finish: Meta says SYB isn't allowed to do that. Check the permissions listed on Connections and start again.",
  meta_busy:
    "Facebook sign-in didn't finish: Meta was busy or didn't answer. Nothing was connected — try again in a few minutes.",
  meta_refused: "Facebook sign-in didn't finish: Meta refused it. Nothing was connected.",
  internal: "Something went wrong on our side. Nothing was connected.",
} as const;

export type ConnectionsReason = keyof typeof CONNECTIONS_REASONS;

/** The generic sentence, for a code that isn't one of ours. */
export const CONNECTIONS_GENERIC = "Facebook sign-in didn't finish. Nothing was connected.";

export function isConnectionsReason(value: unknown): value is ConnectionsReason {
  return typeof value === "string" && Object.hasOwn(CONNECTIONS_REASONS, value);
}

/** The fixed sentence for a reason code read off the URL; anything else is the generic one. */
export function connectionsMessage(reason: string | null | undefined): string {
  return isConnectionsReason(reason) ? CONNECTIONS_REASONS[reason] : CONNECTIONS_GENERIC;
}
