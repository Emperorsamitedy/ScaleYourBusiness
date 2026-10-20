// Login CSRF — security audit 2026-10-17 (Medium, "Login CSRF via GET links").
//
// A sign-in link used to set cookies on a plain GET, so any page could
// navigate a visitor's browser into someone else's account. The links now
// open a confirm page, and only a POST from our own origin signs in. A
// cross-site form can still POST, so the POST checks where it came from:
// `Sec-Fetch-Site` when the browser sends it (every current one does),
// else the `Origin` header. With neither, it refuses — a sign-in that
// can't prove it came from our page is the one this check exists to stop.

export function isSameOriginPost(headers: Headers, appOrigin: string): boolean {
  const site = headers.get("sec-fetch-site");
  if (site !== null) return site === "same-origin";
  const origin = headers.get("origin");
  if (origin === null) return false;
  return origin.replace(/\/$/, "") === appOrigin.replace(/\/$/, "");
}

/** The origin links and redirects use: APP_URL when set, else the request's own. */
export function appOriginOf(requestUrl: string): string {
  return (process.env.APP_URL || new URL(requestUrl).origin).replace(/\/$/, "");
}
