// GET /api/connections/meta/callback — Facebook Login for testers, step 2 (P3-20j).
//
// Meta sends the owner back here. The nonce cookie is cleared whatever
// happens (single use). A cancel becomes a plain sentence on /connections;
// otherwise the state must verify against that nonce and the account now
// signed in, the code is exchanged server-side, the token made long-lived,
// and the candidates listed. The token rides on only as an encrypted,
// httpOnly, ten-minute cookie; the owner lands on the picker.

import { cookies } from "next/headers";
import { type NextRequest, NextResponse } from "next/server";
import { resolveAccess } from "../../../../../lib/auth/access";
import { metaLoginEnv } from "../../../../../lib/env";
import {
  META_LOGIN_NONCE_COOKIE,
  META_LOGIN_PENDING_COOKIE,
  completeMetaCallback,
  connectionsReturnUrl,
  flowOrigin,
  loginCookieOptions,
  metaLoginConfig,
} from "../../../../../lib/execution/meta-login";
import { metaExecution } from "../../../../../lib/execution/providers/meta";
import { requireRole } from "../../../../../lib/auth/roles";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestOrigin = new URL(request.url).origin;
  const config = metaLoginConfig(metaLoginEnv(), requestOrigin);
  const origin = flowOrigin(config, requestOrigin);
  const q = request.nextUrl.searchParams;

  const store = await cookies();
  const access = await resolveAccess();
  // Idea 52: write access is the owner's own consent (rule 13).
  if (access?.session && requireRole(access, "write_access.manage")) {
    const refused = NextResponse.redirect(
      connectionsReturnUrl(origin, { kind: "failed", provider: null, reason: "owner_only" }),
      303,
    );
    refused.cookies.set(META_LOGIN_NONCE_COOKIE, "", loginCookieOptions(origin, 0));
    return refused;
  }
  const outcome = await completeMetaCallback({
    accountId: access?.session?.account_id ?? null,
    query: {
      code: q.get("code"),
      state: q.get("state"),
      error: q.get("error"),
      error_reason: q.get("error_reason"),
    },
    nonceCookie: store.get(META_LOGIN_NONCE_COOKIE)?.value ?? null,
    config,
    exec: metaExecution,
  });

  const response = NextResponse.redirect(connectionsReturnUrl(origin, outcome), 303);
  response.cookies.set(META_LOGIN_NONCE_COOKIE, "", loginCookieOptions(origin, 0));
  if (outcome.kind === "pick") {
    response.cookies.set(META_LOGIN_PENDING_COOKIE, outcome.pending, loginCookieOptions(origin));
  }
  return response;
}
