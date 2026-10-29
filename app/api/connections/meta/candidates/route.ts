// /api/connections/meta/candidates — Facebook Login for testers, step 3 (P3-20j).
//
//   GET     ?provider=meta_publish|meta_ads   the Pages (with linked Instagram) or ad accounts
//                                             the waiting sign-in can reach, re-read from Meta
//   DELETE                                    cancel: forget the waiting sign-in
//
// The token stays in its encrypted httpOnly cookie and is never sent to
// the browser; only ids and names come back. Signed-in owner only.

import { type NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { matchingSession } from "../../../../../lib/auth/access";
import { logSafeError } from "../../../../../lib/core/log-safe";
import { ExecutionConnectionError } from "../../../../../lib/execution/connections";
import {
  META_LOGIN_PENDING_COOKIE,
  flowOrigin,
  listMetaCandidates,
  loginCookieOptions,
  metaLoginConfig,
} from "../../../../../lib/execution/meta-login";
import { metaLoginEnv } from "../../../../../lib/env";
import { metaExecution } from "../../../../../lib/execution/providers/meta";
import { requireRole } from "../../../../../lib/auth/roles";

function cookieOrigin(request: NextRequest): string {
  const requestOrigin = new URL(request.url).origin;
  return flowOrigin(metaLoginConfig(metaLoginEnv(), requestOrigin), requestOrigin);
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const session = await matchingSession();
  if (!session) {
    return NextResponse.json({ error: "sign in to manage connections" }, { status: 401 });
  }
  try {
    const store = await cookies();
    const list = await listMetaCandidates({
      accountId: session.account_id,
      provider: request.nextUrl.searchParams.get("provider"),
      pendingCookie: store.get(META_LOGIN_PENDING_COOKIE)?.value ?? null,
      exec: metaExecution,
    });
    return NextResponse.json(list);
  } catch (error) {
    if (error instanceof ExecutionConnectionError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error(
      JSON.stringify({
        event: "meta_login_candidates_failed",
        account_id: session.account_id,
        ...logSafeError(error),
      }),
    );
    return NextResponse.json({ error: "something went wrong on our side" }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  const session = await matchingSession();
  if (!session) {
    return NextResponse.json({ error: "sign in to manage connections" }, { status: 401 });
  }
  const denied = requireRole(session, "write_access.manage");
  if (denied) return denied;
  console.log(JSON.stringify({ event: "meta_login_cancelled", account_id: session.account_id }));
  const response = NextResponse.json({ cancelled: true });
  response.cookies.set(META_LOGIN_PENDING_COOKIE, "", loginCookieOptions(cookieOrigin(request), 0));
  return response;
}
