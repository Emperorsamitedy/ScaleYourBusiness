// POST /api/auth/redeem-code — sign in with the 6-digit code from the
// sign-in email (2026-11-16), for an owner who reads their email on one
// device and signs in on another.
//
// Same-origin only, like every mutating auth route. Answers JSON (the
// sign-in screen posts with fetch): { landing } with the signed-in cookies
// set, or { error } in the same English the screen reads back through
// authWords. Wrong, expired and used codes all fail alike; guessing is
// capped in lib/auth/service (redeemLoginCode).

import { logSafeError } from "../../../../lib/core/log-safe";
import { cookies } from "next/headers";
import { type NextRequest, NextResponse } from "next/server";
import { landingPath, setSignInCookies } from "../../../../lib/auth/landing";
import { RETURN_COOKIE } from "../../../../lib/auth/return-to";
import { appOriginOf, isSameOriginPost } from "../../../../lib/auth/same-origin";
import { AuthError, redeemLoginCode } from "../../../../lib/auth/service";
import { ResumeError } from "../../../../lib/intake/resume";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const origin = appOriginOf(request.url);
  if (!isSameOriginPost(request.headers, origin)) {
    return NextResponse.json({ error: "sign in from our own page" }, { status: 403 });
  }
  try {
    const body = (await request.json().catch(() => null)) as {
      email?: unknown;
      code?: unknown;
    } | null;
    if (typeof body?.email !== "string") {
      return NextResponse.json({ error: "an email address is needed" }, { status: 422 });
    }
    const clientIp =
      request.headers.get("x-real-ip") ??
      request.headers.get("x-forwarded-for")?.split(",")[0] ??
      null;
    const session = await redeemLoginCode(body.email, body.code, clientIp);
    // Read only when there's a business to return to, as before the shared helper.
    const landing = landingPath(
      session,
      session.profile_id ? (await cookies()).get(RETURN_COOKIE)?.value : undefined,
    );
    return setSignInCookies(NextResponse.json({ landing }), session);
  } catch (error) {
    if (error instanceof AuthError || error instanceof ResumeError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error(JSON.stringify({ event: "redeem_code_failed", ...logSafeError(error) }));
    return NextResponse.json({ error: "something went wrong on our side" }, { status: 500 });
  }
}
