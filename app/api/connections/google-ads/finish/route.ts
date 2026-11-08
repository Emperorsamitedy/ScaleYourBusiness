// POST /api/connections/google-ads/finish — the owner's pick (P2-20).
//
// { customer_id } is looked up again in Google's own list for the waiting
// grant (never trusted from the browser), then the consent is recorded.
// The waiting grant's cookie is cleared whatever happens.

import { cookies } from "next/headers";
import { type NextRequest, NextResponse } from "next/server";
import { resolveAccess } from "../../../../../lib/auth/access";
import { requireRole } from "../../../../../lib/auth/roles";
import { logSafeError } from "../../../../../lib/core/log-safe";
import { googleAdsEnv } from "../../../../../lib/env";
import { ExecutionConnectionError } from "../../../../../lib/execution/connections";
import { GbpRequestError } from "../../../../../lib/google-business/client";
import { GadsRequestError } from "../../../../../lib/google-ads/client";
import {
  GADS_PENDING_COOKIE,
  finishGoogleAdsLogin,
  googleAdsCookieOptions,
  googleAdsFlowOrigin,
  googleAdsLoginConfig,
} from "../../../../../lib/google-ads/login";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const access = await resolveAccess();
  const session = access?.session ?? null;
  if (!access || !session) {
    return NextResponse.json({ error: "sign in to manage connections" }, { status: 401 });
  }
  // Idea 52: write access is the owner's own consent (rule 13).
  const denied = requireRole(session, "write_access.manage");
  if (denied) return denied;
  const requestOrigin = new URL(request.url).origin;
  const config = googleAdsLoginConfig(googleAdsEnv(), requestOrigin);
  const origin = googleAdsFlowOrigin(config, requestOrigin);
  const forget = (response: NextResponse) => {
    response.cookies.set(GADS_PENDING_COOKIE, "", googleAdsCookieOptions(origin, 0));
    return response;
  };
  const body = (await request.json().catch(() => null)) as { customer_id?: unknown } | null;
  const store = await cookies();
  try {
    const connection = await finishGoogleAdsLogin({
      accountId: session.account_id,
      profileId: access.profile_id,
      userId: session.user_id,
      customerId: body?.customer_id,
      pendingCookie: store.get(GADS_PENDING_COOKIE)?.value ?? null,
      config,
    });
    return forget(NextResponse.json(connection, { status: 201 }));
  } catch (error) {
    if (error instanceof ExecutionConnectionError) {
      return forget(NextResponse.json({ error: error.message }, { status: error.status }));
    }
    if (error instanceof GadsRequestError || error instanceof GbpRequestError) {
      return forget(
        NextResponse.json({ error: `Google didn't finish: ${error.message}` }, { status: 502 }),
      );
    }
    console.error(
      JSON.stringify({
        event: "google_ads_login_finish_failed",
        account_id: session.account_id,
        ...logSafeError(error),
      }),
    );
    return forget(
      NextResponse.json({ error: "something went wrong on our side" }, { status: 500 }),
    );
  }
}
