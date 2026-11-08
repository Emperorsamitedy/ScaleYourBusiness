// GET /api/connections/google-ads/callback — Google's redirect back (P2-20).
//
// Verifies the signed state against the nonce cookie and the signed-in
// account, exchanges the code (PKCE), checks the grant holds exactly the
// adwords scope, then connects the one ad account or keeps the grant,
// encrypted, for the owner's pick. Always clears the nonce; always lands on
// /connections with a closed outcome code. A manager on the team is refused
// before anything is exchanged: write access is the owner's own (rule 13).

import { cookies } from "next/headers";
import { type NextRequest, NextResponse } from "next/server";
import { resolveAccess } from "../../../../../lib/auth/access";
import { requireRole } from "../../../../../lib/auth/roles";
import { googleAdsEnv } from "../../../../../lib/env";
import {
  GADS_NONCE_COOKIE,
  GADS_PENDING_COOKIE,
  completeGoogleAdsCallback,
  googleAdsCookieOptions,
  googleAdsFlowOrigin,
  googleAdsLoginConfig,
  googleAdsReturnUrl,
} from "../../../../../lib/google-ads/login";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestOrigin = new URL(request.url).origin;
  const config = googleAdsLoginConfig(googleAdsEnv(), requestOrigin);
  const origin = googleAdsFlowOrigin(config, requestOrigin);
  const q = request.nextUrl.searchParams;
  const store = await cookies();
  const access = await resolveAccess();
  if (access?.session && requireRole(access, "write_access.manage")) {
    const refused = NextResponse.redirect(
      googleAdsReturnUrl(origin, { kind: "failed", reason: "owner_only" }),
      303,
    );
    refused.cookies.set(GADS_NONCE_COOKIE, "", googleAdsCookieOptions(origin, 0));
    return refused;
  }
  const outcome = await completeGoogleAdsCallback({
    accountId: access?.session?.account_id ?? null,
    userId: access?.session?.user_id ?? null,
    query: { code: q.get("code"), state: q.get("state"), error: q.get("error") },
    nonceCookie: store.get(GADS_NONCE_COOKIE)?.value ?? null,
    config,
  });
  const response = NextResponse.redirect(
    googleAdsReturnUrl(
      origin,
      outcome.kind === "failed"
        ? { kind: "failed", reason: outcome.reason }
        : { kind: outcome.kind },
    ),
    303,
  );
  response.cookies.set(GADS_NONCE_COOKIE, "", googleAdsCookieOptions(origin, 0));
  if (outcome.kind === "pick") {
    response.cookies.set(GADS_PENDING_COOKIE, outcome.pending, googleAdsCookieOptions(origin));
  }
  return response;
}
