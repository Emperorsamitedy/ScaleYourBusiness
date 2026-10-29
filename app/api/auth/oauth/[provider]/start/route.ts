// GET /api/auth/oauth/:provider/start — the SSO door opens.
//
// A provider whose keys aren't set doesn't pretend: the visitor is
// sent back to the entrance they came from with an honest sentence.
// A configured one gets a state nonce (double-submit cookie, checked
// at the callback) and a redirect to its authorize endpoint.

import { randomBytes } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import {
  authorizeRedirect,
  KNOWN_PROVIDERS,
  oauthProvider,
  STATE_COOKIE,
} from "../../../../../../lib/auth/oauth";
import {
  RETURN_COOKIE,
  returnCookieOptions,
  returnPath,
} from "../../../../../../lib/auth/return-to";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ provider: string }> },
): Promise<NextResponse> {
  const { provider: providerId } = await params;
  const origin = process.env.APP_URL || new URL(request.url).origin;
  const from = request.nextUrl.searchParams.get("from") === "signin" ? "/login" : "/signup";

  if (!KNOWN_PROVIDERS.includes(providerId)) {
    return NextResponse.redirect(new URL(from, origin));
  }
  const provider = oauthProvider(providerId);
  if (!provider) {
    const label = providerId.charAt(0).toUpperCase() + providerId.slice(1);
    const message = `${label} sign-in isn't connected yet — your email below works today.`;
    return NextResponse.redirect(new URL(`${from}?error=${encodeURIComponent(message)}`, origin));
  }

  const state = randomBytes(24).toString("base64url");
  const redirectUri = `${origin}/api/auth/oauth/${provider.id}/callback`;
  const response = NextResponse.redirect(authorizeRedirect(provider, redirectUri, state));
  response.cookies.set(STATE_COOKIE, `${state}:${from}`, {
    httpOnly: true,
    path: "/api/auth/oauth",
    maxAge: 600,
    // Apple's callback is a cross-site POST; a Lax cookie would not
    // ride along with it.
    sameSite: provider.responseMode === "form_post" ? "none" : "lax",
    secure: provider.responseMode === "form_post" || origin.startsWith("https"),
  });
  // Idea 53: a sign-in started from a proposal's card comes back to it.
  const back = returnPath(request.nextUrl.searchParams.get("next"));
  if (back) response.cookies.set(RETURN_COOKIE, back, returnCookieOptions());
  return response;
}
