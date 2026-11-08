// POST /api/connections/google-ads/start — connecting Google Ads, step 1 (P2-20).
//
// The Google Ads section's form posts { confirmation } here. The signed-in
// owner must have typed the consent phrase on SYB's screen; it is checked
// before any redirect. Then a single-use nonce cookie and a 303 to Google's
// consent screen asking for exactly the registry's one scope, offline, with
// PKCE. Every refusal goes back to /connections with a reason code; nothing
// is sent to Google. POST only, from our own origin: a GET only sends the
// owner back to the button.

import { type NextRequest, NextResponse } from "next/server";
import { resolveAccess } from "../../../../../lib/auth/access";
import { requireRole } from "../../../../../lib/auth/roles";
import { appOriginOf, isSameOriginPost } from "../../../../../lib/auth/same-origin";
import { logSafeError } from "../../../../../lib/core/log-safe";
import { googleAdsEnv } from "../../../../../lib/env";
import {
  GADS_NONCE_COOKIE,
  GADS_PENDING_COOKIE,
  googleAdsCookieOptions,
  googleAdsFlowOrigin,
  googleAdsLoginConfig,
  googleAdsReturnUrl,
  reasonForGoogleAdsFailure,
  startGoogleAdsLogin,
} from "../../../../../lib/google-ads/login";
import type { GoogleAdsReason } from "../../../../../lib/google-ads/reasons";

function backTo(request: NextRequest, reason: GoogleAdsReason): NextResponse {
  const requestOrigin = new URL(request.url).origin;
  const origin = googleAdsFlowOrigin(
    googleAdsLoginConfig(googleAdsEnv(), requestOrigin),
    requestOrigin,
  );
  return NextResponse.redirect(googleAdsReturnUrl(origin, { kind: "failed", reason }), 303);
}

/** A link can't start the sign-in: it goes back to the button on /connections, nothing sent. */
export async function GET(request: NextRequest): Promise<NextResponse> {
  return backTo(request, "start_here");
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!isSameOriginPost(request.headers, appOriginOf(request.url))) {
    console.warn(JSON.stringify({ event: "google_ads_login_start_refused", account_id: null }));
    return backTo(request, "start_here");
  }
  const access = await resolveAccess();
  // Idea 52: write access is the owner's own consent (rule 13).
  const denied = requireRole(access, "write_access.manage");
  if (denied) return backTo(request, denied.status === 401 ? "signed_out" : "owner_only");
  const session = access?.session ?? null;
  if (!access || !session) return backTo(request, "signed_out");

  const requestOrigin = new URL(request.url).origin;
  const config = googleAdsLoginConfig(googleAdsEnv(), requestOrigin);
  const origin = googleAdsFlowOrigin(config, requestOrigin);
  const type = request.headers.get("content-type") ?? "";
  let confirmation: unknown;
  if (type.includes("application/json")) {
    const body = (await request.json().catch(() => null)) as { confirmation?: unknown } | null;
    confirmation = body?.confirmation ?? null;
  } else {
    const form = await request.formData().catch(() => null);
    confirmation = form?.get("confirmation") ?? null;
  }
  try {
    const { authorize_url, nonce } = await startGoogleAdsLogin({
      accountId: session.account_id,
      profileId: access.profile_id,
      confirmation,
      config,
    });
    const response = NextResponse.redirect(authorize_url, 303);
    response.cookies.set(GADS_NONCE_COOKIE, nonce, googleAdsCookieOptions(origin));
    // A fresh start forgets any earlier sign-in still waiting for its pick.
    response.cookies.set(GADS_PENDING_COOKIE, "", googleAdsCookieOptions(origin, 0));
    return response;
  } catch (error) {
    const reason = reasonForGoogleAdsFailure(error);
    if (reason === "internal") {
      console.error(
        JSON.stringify({
          event: "google_ads_login_start_failed",
          account_id: session.account_id,
          ...logSafeError(error),
        }),
      );
    }
    return backTo(request, reason);
  }
}
