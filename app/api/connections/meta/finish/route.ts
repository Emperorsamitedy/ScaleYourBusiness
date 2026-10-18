// POST /api/connections/meta/finish — Facebook Login for testers, step 4 (P3-20j).
//
// { provider, asset_id }: the owner's pick. The waiting token (encrypted,
// httpOnly) and the picked id — looked up again in Meta's own list — go to
// consentToExecution, the same door as a pasted token: /me/permissions
// matched exactly, encryption at rest, the consent row. The waiting
// sign-in is forgotten after any attempt to connect, success or refusal;
// only a pick that isn't on the list leaves it to pick again.

import { cookies } from "next/headers";
import { type NextRequest, NextResponse } from "next/server";
import { resolveAccess } from "../../../../../lib/auth/access";
import { logSafeError } from "../../../../../lib/core/log-safe";
import { metaLoginEnv } from "../../../../../lib/env";
import { ExecutionConnectionError } from "../../../../../lib/execution/connections";
import {
  META_LOGIN_PENDING_COOKIE,
  MetaLoginError,
  finishMetaLogin,
  flowOrigin,
  loginCookieOptions,
  metaLoginConfig,
} from "../../../../../lib/execution/meta-login";
import { metaExecution } from "../../../../../lib/execution/providers/meta";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const access = await resolveAccess();
  const session = access?.session ?? null;
  if (!access || !session) {
    return NextResponse.json({ error: "sign in to manage connections" }, { status: 401 });
  }
  const requestOrigin = new URL(request.url).origin;
  const origin = flowOrigin(metaLoginConfig(metaLoginEnv(), requestOrigin), requestOrigin);
  const forget = (response: NextResponse) => {
    response.cookies.set(META_LOGIN_PENDING_COOKIE, "", loginCookieOptions(origin, 0));
    return response;
  };

  const body = (await request.json().catch(() => null)) as {
    provider?: unknown;
    asset_id?: unknown;
  } | null;
  const store = await cookies();
  try {
    const connection = await finishMetaLogin({
      accountId: session.account_id,
      profileId: access.profile_id,
      provider: body?.provider,
      assetId: body?.asset_id,
      pendingCookie: store.get(META_LOGIN_PENDING_COOKIE)?.value ?? null,
      exec: metaExecution,
    });
    return forget(NextResponse.json(connection, { status: 201 }));
  } catch (error) {
    if (error instanceof MetaLoginError && error.reason === "bad_pick") {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof ExecutionConnectionError) {
      return forget(NextResponse.json({ error: error.message }, { status: error.status }));
    }
    console.error(
      JSON.stringify({
        event: "meta_login_finish_failed",
        account_id: session.account_id,
        ...logSafeError(error),
      }),
    );
    return forget(
      NextResponse.json({ error: "something went wrong on our side" }, { status: 500 }),
    );
  }
}
