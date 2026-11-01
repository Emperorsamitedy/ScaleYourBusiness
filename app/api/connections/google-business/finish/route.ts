// POST /api/connections/google-business/finish — connecting Google Business Profile, step 3 (I-45a).
//
// { location }: the owner's pick, "accounts/{a}/locations/{l}". The waiting
// grant (encrypted, httpOnly) is refreshed, the pick looked up again in
// Google's own list, and the consent recorded through consentToGoogleReviews:
// the exact-scope check, encryption at rest, the decision-log row. The
// waiting sign-in is forgotten after any attempt, success or refusal.

import { cookies } from "next/headers";
import { type NextRequest, NextResponse } from "next/server";
import { resolveAccess } from "../../../../../lib/auth/access";
import { requireRole } from "../../../../../lib/auth/roles";
import { logSafeError } from "../../../../../lib/core/log-safe";
import { googleBusinessEnv } from "../../../../../lib/env";
import { ExecutionConnectionError } from "../../../../../lib/execution/connections";
import { GbpRequestError } from "../../../../../lib/google-business/client";
import {
  GOOGLE_PENDING_COOKIE,
  finishGoogleLogin,
  googleCookieOptions,
  googleFlowOrigin,
  googleLoginConfig,
} from "../../../../../lib/google-business/login";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const access = await resolveAccess();
  const session = access?.session ?? null;
  if (!access || !session) {
    return NextResponse.json({ error: "sign in to manage connections" }, { status: 401 });
  }
  const denied = requireRole(session, "write_access.manage");
  if (denied) return denied;
  const requestOrigin = new URL(request.url).origin;
  const config = googleLoginConfig(googleBusinessEnv(), requestOrigin);
  const origin = googleFlowOrigin(config, requestOrigin);
  const forget = (response: NextResponse) => {
    response.cookies.set(GOOGLE_PENDING_COOKIE, "", googleCookieOptions(origin, 0));
    return response;
  };
  const body = (await request.json().catch(() => null)) as { location?: unknown } | null;
  const store = await cookies();
  try {
    const connection = await finishGoogleLogin({
      accountId: session.account_id,
      profileId: access.profile_id,
      userId: session.user_id,
      location: body?.location,
      pendingCookie: store.get(GOOGLE_PENDING_COOKIE)?.value ?? null,
      config,
    });
    return forget(NextResponse.json(connection, { status: 201 }));
  } catch (error) {
    if (error instanceof ExecutionConnectionError) {
      return forget(NextResponse.json({ error: error.message }, { status: error.status }));
    }
    if (error instanceof GbpRequestError) {
      return forget(
        NextResponse.json({ error: `Google didn't finish: ${error.message}` }, { status: 502 }),
      );
    }
    console.error(
      JSON.stringify({
        event: "google_login_finish_failed",
        account_id: session.account_id,
        ...logSafeError(error),
      }),
    );
    return forget(
      NextResponse.json({ error: "something went wrong on our side" }, { status: 500 }),
    );
  }
}
