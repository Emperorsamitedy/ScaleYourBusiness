// POST /api/mandate/[token] — a client grants a firm's mandate from the
// email (v1 spec §7.6), with no SYB account of their own beforehand: the
// link proves the address, the business is made for them, and they land
// signed in on the connections page — the connector invitation.

import { type NextRequest, NextResponse } from "next/server";
import {
  AUTH_COOKIE,
  INTAKE_COOKIE,
  authCookieOptions,
  intakeCookieOptions,
  signProfileCookie,
} from "../../../../lib/auth/access";
import { appOriginOf, isSameOriginPost } from "../../../../lib/auth/same-origin";
import { logSafeError } from "../../../../lib/core/log-safe";
import { MandateError, grantByToken } from "../../../../lib/partners/mandates";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
): Promise<NextResponse> {
  const origin = appOriginOf(request.url);
  if (!isSameOriginPost(request.headers, origin)) {
    return NextResponse.json({ error: "use the page from the email" }, { status: 403 });
  }
  const { token } = await params;
  try {
    const granted = await grantByToken(token);
    const response = NextResponse.json({ next: "/connections" });
    response.cookies.set(AUTH_COOKIE, granted.session.session_token, authCookieOptions());
    response.cookies.set(
      INTAKE_COOKIE,
      signProfileCookie(granted.profile_id),
      intakeCookieOptions(),
    );
    return response;
  } catch (error) {
    if (error instanceof MandateError)
      return NextResponse.json({ error: error.message }, { status: error.status });
    console.error(
      JSON.stringify({ event: "mandate_grant_failed", account_id: null, ...logSafeError(error) }),
    );
    return NextResponse.json({ error: "something went wrong on our side" }, { status: 500 });
  }
}
