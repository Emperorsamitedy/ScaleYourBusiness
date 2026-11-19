// POST /api/auth/business — "Add another business" (idea 52).
//
// A plain form post, same-origin only. For the signed-in person: a fresh
// account, its profile and an owner row for the same verified email, then
// this browser switches into it and lands on Home, which offers the
// interview (L8 of docs/DASHBOARD-OVERHAUL.md). It acts on
// a NEW business only — nothing in the current one changes, so no role is
// needed (the role-wiring test lists it as an identity route).

import { cookies } from "next/headers";
import { type NextRequest, NextResponse } from "next/server";
import {
  AUTH_COOKIE,
  INTAKE_COOKIE,
  authCookieOptions,
  intakeCookieOptions,
  signProfileCookie,
} from "../../../../lib/auth/access";
import { appOriginOf, isSameOriginPost } from "../../../../lib/auth/same-origin";
import { currentSession } from "../../../../lib/auth/service";
import { addBusiness } from "../../../../lib/auth/switch";
import { logSafeError } from "../../../../lib/core/log-safe";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const origin = appOriginOf(request.url);
  const back = (message: string) =>
    NextResponse.redirect(
      new URL(`/login/choose?error=${encodeURIComponent(message)}`, origin),
      303,
    );
  if (!isSameOriginPost(request.headers, origin)) return back("add the business on our page");
  const store = await cookies();
  const token = store.get(AUTH_COOKIE)?.value;
  const session = await currentSession(token);
  if (!session) return NextResponse.redirect(new URL("/login", origin), 303);
  try {
    const next = await addBusiness({ session, currentToken: token });
    // L8: a new business opens in the app, and Home offers the interview.
    const response = NextResponse.redirect(new URL("/home", origin), 303);
    response.cookies.set(AUTH_COOKIE, next.session_token, authCookieOptions());
    if (next.profile_id) {
      response.cookies.set(
        INTAKE_COOKIE,
        signProfileCookie(next.profile_id),
        intakeCookieOptions(),
      );
    }
    return response;
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "business_add_failed",
        account_id: session.account_id,
        ...logSafeError(error),
      }),
    );
    return back("something went wrong on our side");
  }
}
