// POST /api/connections/tiktok/start — connecting TikTok Ads, step 1.
//
// The TikTok card's form posts { confirmation } here. The signed-in owner
// must have typed the consent phrase on SYB's screen; it is checked before
// any redirect. Then a single-use nonce cookie and a 303 to TikTok's
// advertiser authorization page for SYB's app. Every refusal goes back to
// /connections with a reason code; nothing is sent to TikTok. POST only,
// from our own origin: a GET only sends the owner back to the button.

import { type NextRequest, NextResponse } from "next/server";
import { resolveAccess } from "../../../../../lib/auth/access";
import { requireRole } from "../../../../../lib/auth/roles";
import { appOriginOf, isSameOriginPost } from "../../../../../lib/auth/same-origin";
import { logSafeError } from "../../../../../lib/core/log-safe";
import { tiktokAdsEnv } from "../../../../../lib/env";
import {
  TIKTOK_NONCE_COOKIE,
  reasonForTikTokFailure,
  startTikTokLogin,
  tiktokCookieOptions,
  tiktokFlowOrigin,
  tiktokLoginConfig,
  tiktokReturnUrl,
} from "../../../../../lib/tiktok/login";
import type { TikTokReason } from "../../../../../lib/tiktok/reasons";

function backTo(request: NextRequest, reason: TikTokReason): NextResponse {
  const requestOrigin = new URL(request.url).origin;
  const origin = tiktokFlowOrigin(tiktokLoginConfig(tiktokAdsEnv(), requestOrigin), requestOrigin);
  return NextResponse.redirect(tiktokReturnUrl(origin, { kind: "failed", reason }), 303);
}

/** A link can't start the sign-in: it goes back to the button on /connections, nothing sent. */
export async function GET(request: NextRequest): Promise<NextResponse> {
  return backTo(request, "start_here");
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!isSameOriginPost(request.headers, appOriginOf(request.url))) {
    console.warn(JSON.stringify({ event: "tiktok_login_start_refused", account_id: null }));
    return backTo(request, "start_here");
  }
  const access = await resolveAccess();
  // Write access is the owner's own consent (rule 13).
  const denied = requireRole(access, "write_access.manage");
  if (denied) return backTo(request, denied.status === 401 ? "signed_out" : "owner_only");
  const session = access?.session ?? null;
  if (!access || !session) return backTo(request, "signed_out");

  const requestOrigin = new URL(request.url).origin;
  const config = tiktokLoginConfig(tiktokAdsEnv(), requestOrigin);
  const origin = tiktokFlowOrigin(config, requestOrigin);
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
    const { authorize_url, nonce } = await startTikTokLogin({
      accountId: session.account_id,
      profileId: access.profile_id,
      confirmation,
      config,
    });
    const response = NextResponse.redirect(authorize_url, 303);
    response.cookies.set(TIKTOK_NONCE_COOKIE, nonce, tiktokCookieOptions(origin));
    return response;
  } catch (error) {
    const reason = reasonForTikTokFailure(error);
    if (reason === "internal") {
      console.error(
        JSON.stringify({
          event: "tiktok_login_start_failed",
          account_id: session.account_id,
          ...logSafeError(error),
        }),
      );
    }
    return backTo(request, reason);
  }
}
