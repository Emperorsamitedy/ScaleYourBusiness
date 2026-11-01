// POST /api/connections/google-business/start — connecting Google Business Profile, step 1 (I-45a).
//
// The Google section's form posts { confirmation } here. The signed-in
// owner must have typed the consent phrase on SYB's screen; it is checked
// before any redirect. Then a single-use nonce cookie and a 303 to Google's
// consent screen asking for exactly the registry's one scope, offline, with
// PKCE. Every refusal goes back to /connections with a reason code; nothing
// is sent to Google. POST only, from our own origin (Meta's review D #8):
// a GET only sends the owner back to the button.

import { type NextRequest, NextResponse } from "next/server";
import { resolveAccess } from "../../../../../lib/auth/access";
import { requireRole } from "../../../../../lib/auth/roles";
import { appOriginOf, isSameOriginPost } from "../../../../../lib/auth/same-origin";
import { logSafeError } from "../../../../../lib/core/log-safe";
import { googleBusinessEnv } from "../../../../../lib/env";
import {
  GOOGLE_NONCE_COOKIE,
  GOOGLE_PENDING_COOKIE,
  googleCookieOptions,
  googleFlowOrigin,
  googleLoginConfig,
  googleReturnUrl,
  reasonForGoogleFailure,
  startGoogleLogin,
} from "../../../../../lib/google-business/login";
import type { GoogleReason } from "../../../../../lib/google-business/reasons";

function backTo(request: NextRequest, reason: GoogleReason): NextResponse {
  const requestOrigin = new URL(request.url).origin;
  const origin = googleFlowOrigin(
    googleLoginConfig(googleBusinessEnv(), requestOrigin),
    requestOrigin,
  );
  return NextResponse.redirect(googleReturnUrl(origin, { kind: "failed", reason }), 303);
}

/** A link can't start the sign-in: it goes back to the button on /connections, nothing sent. */
export async function GET(request: NextRequest): Promise<NextResponse> {
  return backTo(request, "start_here");
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!isSameOriginPost(request.headers, appOriginOf(request.url))) {
    console.warn(JSON.stringify({ event: "google_login_start_refused", account_id: null }));
    return backTo(request, "start_here");
  }
  const access = await resolveAccess();
  // Idea 52: write access is the owner's own consent (rule 13).
  const denied = requireRole(access, "write_access.manage");
  if (denied) return backTo(request, denied.status === 401 ? "signed_out" : "owner_only");
  const session = access?.session ?? null;
  if (!access || !session) return backTo(request, "signed_out");

  const requestOrigin = new URL(request.url).origin;
  const config = googleLoginConfig(googleBusinessEnv(), requestOrigin);
  const origin = googleFlowOrigin(config, requestOrigin);
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
    const { authorize_url, nonce } = await startGoogleLogin({
      accountId: session.account_id,
      profileId: access.profile_id,
      confirmation,
      config,
    });
    const response = NextResponse.redirect(authorize_url, 303);
    response.cookies.set(GOOGLE_NONCE_COOKIE, nonce, googleCookieOptions(origin));
    // A fresh start forgets any earlier sign-in still waiting for its pick.
    response.cookies.set(GOOGLE_PENDING_COOKIE, "", googleCookieOptions(origin, 0));
    return response;
  } catch (error) {
    const reason = reasonForGoogleFailure(error);
    if (reason === "internal") {
      console.error(
        JSON.stringify({
          event: "google_login_start_failed",
          account_id: session.account_id,
          ...logSafeError(error),
        }),
      );
    }
    return backTo(request, reason);
  }
}
