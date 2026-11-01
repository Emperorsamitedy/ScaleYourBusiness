// GET /api/connections/google-business/callback — connecting Google Business Profile, step 2 (I-45a).
//
// Google sends the owner back here. The nonce cookie is cleared whatever
// happens (single use). A cancel becomes a plain sentence on /connections;
// otherwise the state must verify against that nonce and the account now
// signed in, the code is exchanged server-side with the PKCE verifier, and
// the grant must hold exactly the one scope. One location connects now (the
// consent row is written); several ride on only as an encrypted, httpOnly,
// ten-minute cookie while the owner picks.

import { cookies } from "next/headers";
import { type NextRequest, NextResponse } from "next/server";
import { resolveAccess } from "../../../../../lib/auth/access";
import { requireRole } from "../../../../../lib/auth/roles";
import { googleBusinessEnv } from "../../../../../lib/env";
import {
  GOOGLE_NONCE_COOKIE,
  GOOGLE_PENDING_COOKIE,
  completeGoogleCallback,
  googleCookieOptions,
  googleFlowOrigin,
  googleLoginConfig,
  googleReturnUrl,
} from "../../../../../lib/google-business/login";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestOrigin = new URL(request.url).origin;
  const config = googleLoginConfig(googleBusinessEnv(), requestOrigin);
  const origin = googleFlowOrigin(config, requestOrigin);
  const q = request.nextUrl.searchParams;
  const store = await cookies();
  const access = await resolveAccess();
  // Idea 52: write access is the owner's own consent (rule 13).
  if (access?.session && requireRole(access, "write_access.manage")) {
    const refused = NextResponse.redirect(
      googleReturnUrl(origin, { kind: "failed", reason: "owner_only" }),
      303,
    );
    refused.cookies.set(GOOGLE_NONCE_COOKIE, "", googleCookieOptions(origin, 0));
    return refused;
  }
  const outcome = await completeGoogleCallback({
    accountId: access?.session?.account_id ?? null,
    userId: access?.session?.user_id ?? null,
    query: { code: q.get("code"), state: q.get("state"), error: q.get("error") },
    nonceCookie: store.get(GOOGLE_NONCE_COOKIE)?.value ?? null,
    config,
  });
  const response = NextResponse.redirect(
    googleReturnUrl(
      origin,
      outcome.kind === "failed"
        ? { kind: "failed", reason: outcome.reason }
        : { kind: outcome.kind },
    ),
    303,
  );
  response.cookies.set(GOOGLE_NONCE_COOKIE, "", googleCookieOptions(origin, 0));
  if (outcome.kind === "pick") {
    response.cookies.set(GOOGLE_PENDING_COOKIE, outcome.pending, googleCookieOptions(origin));
  }
  return response;
}
