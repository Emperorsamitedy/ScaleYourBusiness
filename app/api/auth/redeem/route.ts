// /api/auth/redeem — the emailed link (P1-49).
//
// GET never signs in (login CSRF, security audit 2026-10-17): it sends the
// browser to /login/confirm, which names the address the link was sent to
// and asks. Only that page's POST, from our own origin, redeems the link.
// A mail scanner opening the link no longer burns it, either.
//
// The POST sets two cookies and redirects. The auth session is the durable
// identity; the intake cookie is the working credential every existing
// route already reads — re-pointing it at the account's profile is what
// makes login-from-a-new-device just work with zero route changes.

import { logSafeError } from "../../../../lib/core/log-safe";
import { cookies } from "next/headers";
import { type NextRequest, NextResponse } from "next/server";
import {
  AUTH_COOKIE,
  INTAKE_COOKIE,
  authCookieOptions,
  intakeCookieOptions,
  signProfileCookie,
} from "../../../../lib/auth/access";
import { RETURN_COOKIE, returnPath } from "../../../../lib/auth/return-to";
import { appOriginOf, isSameOriginPost } from "../../../../lib/auth/same-origin";
import { AuthError, redeemLogin } from "../../../../lib/auth/service";

export function GET(request: NextRequest): NextResponse {
  const token = request.nextUrl.searchParams.get("token") ?? "";
  const confirm = new URL("/login/confirm", appOriginOf(request.url));
  confirm.searchParams.set("token", token);
  return NextResponse.redirect(confirm, 303);
}

function toLogin(origin: string, message: string): NextResponse {
  return NextResponse.redirect(new URL(`/login?error=${encodeURIComponent(message)}`, origin), 303);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const origin = appOriginOf(request.url);
  if (!isSameOriginPost(request.headers, origin)) {
    console.warn(JSON.stringify({ event: "redeem_cross_site_refused" }));
    return toLogin(origin, "open your sign-in link again and confirm on our page");
  }
  let token: string;
  try {
    const form = await request.formData();
    const value = form.get("token");
    token = typeof value === "string" ? value : "";
  } catch {
    return toLogin(origin, "that sign-in link is no longer valid");
  }
  try {
    const session = await redeemLogin(token);
    // Idea 53: back to the proposal card the sign-in started from, once.
    const back = session.profile_id
      ? returnPath((await cookies()).get(RETURN_COOKIE)?.value)
      : null;
    const response = NextResponse.redirect(
      new URL(back ?? (session.profile_id ? "/profile" : "/intake"), origin),
      303,
    );
    response.cookies.delete(RETURN_COOKIE);
    response.cookies.set(AUTH_COOKIE, session.session_token, authCookieOptions());
    if (session.profile_id) {
      response.cookies.set(
        INTAKE_COOKIE,
        signProfileCookie(session.profile_id),
        intakeCookieOptions(),
      );
    }
    return response;
  } catch (error) {
    const message = error instanceof AuthError ? error.message : "something went wrong on our side";
    if (!(error instanceof AuthError)) {
      console.error(JSON.stringify({ event: "redeem_failed", ...logSafeError(error) }));
    }
    return toLogin(origin, message);
  }
}
