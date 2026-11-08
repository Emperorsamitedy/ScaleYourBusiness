// GET /api/connections/tiktok/callback — connecting TikTok Ads, step 2.
//
// TikTok sends the advertiser back here with `auth_code` and `state`. The
// nonce cookie is cleared whatever happens (single use). The state must
// verify against that nonce and the account now signed in; the code is
// exchanged server-side; the scopes must be exactly the registry's; then the
// consent row is written and the connection stored, encrypted.

import { cookies } from "next/headers";
import { type NextRequest, NextResponse } from "next/server";
import { resolveAccess } from "../../../../../lib/auth/access";
import { requireRole } from "../../../../../lib/auth/roles";
import { tiktokAdsEnv } from "../../../../../lib/env";
import {
  TIKTOK_NONCE_COOKIE,
  completeTikTokCallback,
  tiktokCookieOptions,
  tiktokFlowOrigin,
  tiktokLoginConfig,
  tiktokReturnUrl,
} from "../../../../../lib/tiktok/login";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestOrigin = new URL(request.url).origin;
  const config = tiktokLoginConfig(tiktokAdsEnv(), requestOrigin);
  const origin = tiktokFlowOrigin(config, requestOrigin);
  const q = request.nextUrl.searchParams;
  const store = await cookies();
  const access = await resolveAccess();
  // Write access is the owner's own consent (rule 13).
  if (access?.session && requireRole(access, "write_access.manage")) {
    const refused = NextResponse.redirect(
      tiktokReturnUrl(origin, { kind: "failed", reason: "owner_only" }),
      303,
    );
    refused.cookies.set(TIKTOK_NONCE_COOKIE, "", tiktokCookieOptions(origin, 0));
    return refused;
  }
  const outcome = await completeTikTokCallback({
    accountId: access?.session?.account_id ?? null,
    userId: access?.session?.user_id ?? null,
    query: {
      // TikTok's redirect carries auth_code (and, per its own example, a code too).
      auth_code: q.get("auth_code") ?? q.get("code"),
      state: q.get("state"),
      error: q.get("error"),
    },
    nonceCookie: store.get(TIKTOK_NONCE_COOKIE)?.value ?? null,
    config,
  });
  const response = NextResponse.redirect(
    tiktokReturnUrl(
      origin,
      outcome.kind === "failed"
        ? { kind: "failed", reason: outcome.reason }
        : { kind: outcome.kind },
    ),
    303,
  );
  response.cookies.set(TIKTOK_NONCE_COOKIE, "", tiktokCookieOptions(origin, 0));
  return response;
}
