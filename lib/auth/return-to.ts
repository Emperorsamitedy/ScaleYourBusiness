// Back to the card after signing in — idea 53 (I-53.5).
//
// A phone alert opens /proposals/<id>. A signed-out owner goes through
// sign-in from there and should land back on that card, not on /profile.
// The way back is a short-lived httpOnly cookie set when the sign-in starts
// (the link request, or the provider's start) and read once when it
// finishes (the redeem POST, or the provider's callback).
//
// It is an allowlist, not a redirect parameter: only the queue and one of
// its cards can be the way back, so the cookie can never send anyone to
// another site or to any other path (an open redirect).

export const RETURN_COOKIE = "syb_return";

const CARD_PATH = /^\/proposals(\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$/;

/** The path to come back to, or null for anything that isn't the queue or a card. */
export function returnPath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const path = raw.trim().toLowerCase();
  return CARD_PATH.test(path) ? path : null;
}

/** As long as a sign-in link lives (LOGIN_TTL_MINUTES), and no longer. */
export function returnCookieOptions(maxAge = 15 * 60) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge,
  };
}
