// POST /api/auth/switch — move this browser to another business (idea 52).
//
// A plain form post from "Which business?" or the switcher in the frame:
// { account_id }. Same-origin only (lib/auth/same-origin), like every
// sign-in. The new session is for the target business's OWN users row,
// issued only when that row's email is exactly this session's verified
// email (lib/auth/switch). It sets the two cookies a sign-in sets and
// lands where a sign-in lands. Logged as account_switch, ids only.

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
import { SwitchError, switchAccount } from "../../../../lib/auth/switch";
import { logSafeError } from "../../../../lib/core/log-safe";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function back(origin: string, message: string): NextResponse {
  return NextResponse.redirect(
    new URL(`/login/choose?error=${encodeURIComponent(message)}`, origin),
    303,
  );
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const origin = appOriginOf(request.url);
  if (!isSameOriginPost(request.headers, origin)) {
    return back(origin, "choose the business again on our page");
  }
  const store = await cookies();
  const token = store.get(AUTH_COOKIE)?.value;
  const session = await currentSession(token);
  if (!session) {
    return NextResponse.redirect(new URL("/login", origin), 303);
  }
  const value = await request
    .formData()
    .then((form) => form.get("account_id"))
    .catch(() => null);
  const accountId = typeof value === "string" ? value : "";
  if (!UUID_RE.test(accountId)) return back(origin, "no such business");
  try {
    const next = await switchAccount({ session, currentToken: token, targetAccountId: accountId });
    const response = NextResponse.redirect(
      new URL(next.profile_id ? "/profile" : "/intake", origin),
      303,
    );
    response.cookies.set(AUTH_COOKIE, next.session_token, authCookieOptions());
    if (next.profile_id) {
      response.cookies.set(
        INTAKE_COOKIE,
        signProfileCookie(next.profile_id),
        intakeCookieOptions(),
      );
    } else {
      response.cookies.set(INTAKE_COOKIE, "", { ...intakeCookieOptions(), maxAge: 0 });
    }
    return response;
  } catch (error) {
    if (error instanceof SwitchError) return back(origin, error.message);
    console.error(
      JSON.stringify({
        event: "account_switch_failed",
        account_id: session.account_id,
        ...logSafeError(error),
      }),
    );
    return back(origin, "something went wrong on our side");
  }
}
