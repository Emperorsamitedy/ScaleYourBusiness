// GET /api/auth/redeem?token=… — the emailed link lands here (P1-49).
//
// Sets two cookies and redirects. The auth session is the durable
// identity; the intake cookie is the working credential every existing
// route already reads — re-pointing it at the account's profile is what
// makes login-from-a-new-device just work with zero route changes.

import { type NextRequest, NextResponse } from "next/server";
import { AuthError, redeemLogin } from "../../../../lib/auth/service";

const INTAKE_COOKIE = "syb_intake_profile";
const AUTH_COOKIE = "syb_session";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const token = request.nextUrl.searchParams.get("token") ?? "";
  const origin = process.env.APP_URL ?? new URL(request.url).origin;
  try {
    const session = await redeemLogin(token);
    const response = NextResponse.redirect(
      new URL(session.profile_id ? "/profile" : "/intake", origin),
    );
    response.cookies.set(AUTH_COOKIE, session.session_token, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 90,
    });
    if (session.profile_id) {
      response.cookies.set(INTAKE_COOKIE, session.profile_id, {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        maxAge: 60 * 60 * 24 * 30,
      });
    }
    return response;
  } catch (error) {
    const message = error instanceof AuthError ? error.message : "something went wrong on our side";
    if (!(error instanceof AuthError)) {
      console.error(JSON.stringify({ event: "redeem_failed", message: String(error) }));
    }
    return NextResponse.redirect(new URL(`/login?error=${encodeURIComponent(message)}`, origin));
  }
}
