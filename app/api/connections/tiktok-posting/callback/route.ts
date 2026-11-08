// GET /api/connections/tiktok-posting/callback — connecting TikTok posting, step 2 (2026-11-08).
//
// TikTok sends the owner back here. The nonce cookie is cleared whatever
// happens (single use). A cancel becomes a plain sentence on /connections;
// otherwise the state must verify against that nonce and the account now
// signed in, the code is exchanged server-side, the grant must hold exactly
// the consent's scopes, and the consent row is written.

import { cookies } from "next/headers";
import { type NextRequest, NextResponse } from "next/server";
import { resolveAccess } from "../../../../../lib/auth/access";
import { requireRole } from "../../../../../lib/auth/roles";
import { tiktokAuditStatus, tiktokPostingEnv } from "../../../../../lib/env";
import {
  TIKTOK_NONCE_COOKIE,
  completeTikTokCallback,
  tiktokCookieOptions,
  tiktokFlowOrigin,
  tiktokLoginConfig,
  tiktokReturnUrl,
} from "../../../../../lib/execution/tiktok-posting";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestOrigin = new URL(request.url).origin;
  const config = tiktokLoginConfig(tiktokPostingEnv(), requestOrigin);
  const origin = tiktokFlowOrigin(config, requestOrigin);
  const q = request.nextUrl.searchParams;
  const store = await cookies();
  const access = await resolveAccess();
  // Write access is the owner's own consent (rule 13, idea 52).
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
    query: { code: q.get("code"), state: q.get("state"), error: q.get("error") },
    nonceCookie: store.get(TIKTOK_NONCE_COOKIE)?.value ?? null,
    config,
    audit: tiktokAuditStatus(),
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
