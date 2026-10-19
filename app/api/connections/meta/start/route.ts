// GET|POST /api/connections/meta/start — Facebook Login for testers, step 1 (P3-20j).
//
// The Execution section's form posts { provider, confirmation } here. The
// signed-in owner (a session for THIS profile's account, via resolveAccess)
// must have typed the consent phrase on SYB's screen: it is checked before
// any redirect. Then a single-use nonce cookie and a 303 to Meta's OAuth
// dialog asking for exactly the provider's registry scopes. Every refusal
// goes back to /connections with a plain sentence; nothing is sent to Meta.

import { type NextRequest, NextResponse } from "next/server";
import { resolveAccess } from "../../../../../lib/auth/access";
import { logSafeError } from "../../../../../lib/core/log-safe";
import { metaLoginEnv } from "../../../../../lib/env";
import { ExecutionConnectionError } from "../../../../../lib/execution/connections";
import {
  META_LOGIN_NONCE_COOKIE,
  META_LOGIN_PENDING_COOKIE,
  connectionsReturnUrl,
  flowOrigin,
  isMetaLoginProvider,
  loginCookieOptions,
  metaLoginConfig,
  startMetaLogin,
  startedElsewhere,
} from "../../../../../lib/execution/meta-login";

async function start(
  request: NextRequest,
  provider: unknown,
  confirmation: unknown,
): Promise<NextResponse> {
  const requestOrigin = new URL(request.url).origin;
  const config = metaLoginConfig(metaLoginEnv(), requestOrigin);
  const origin = flowOrigin(config, requestOrigin);
  const named = isMetaLoginProvider(provider) ? provider : null;
  const back = (message: string) =>
    NextResponse.redirect(
      connectionsReturnUrl(origin, { kind: "failed", provider: named, message }),
      303,
    );

  // The phrase must have been typed on SYB's own screen, not carried in by another site's link.
  if (startedElsewhere(request.headers.get("sec-fetch-site"))) {
    return back("Start Facebook sign-in from SYB's Connections screen. Nothing was sent to Meta.");
  }
  const access = await resolveAccess();
  const session = access?.session ?? null;
  if (!access || !session) return back("Sign in to SYB first, then connect Meta.");

  try {
    const { authorize_url, nonce } = await startMetaLogin({
      accountId: session.account_id,
      profileId: access.profile_id,
      provider,
      confirmation,
      config,
    });
    const response = NextResponse.redirect(authorize_url, 303);
    response.cookies.set(META_LOGIN_NONCE_COOKIE, nonce, loginCookieOptions(origin));
    // A fresh start forgets any earlier sign-in still waiting for its pick.
    response.cookies.set(META_LOGIN_PENDING_COOKIE, "", loginCookieOptions(origin, 0));
    return response;
  } catch (error) {
    if (error instanceof ExecutionConnectionError) return back(error.message);
    console.error(
      JSON.stringify({
        event: "meta_login_start_failed",
        account_id: session.account_id,
        ...logSafeError(error),
      }),
    );
    return back("Something went wrong on our side. Nothing was sent to Meta.");
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const q = request.nextUrl.searchParams;
  return start(request, q.get("provider"), q.get("confirmation"));
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const type = request.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    const body = (await request.json().catch(() => null)) as {
      provider?: unknown;
      confirmation?: unknown;
    } | null;
    return start(request, body?.provider, body?.confirmation);
  }
  const form = await request.formData().catch(() => null);
  return start(request, form?.get("provider") ?? null, form?.get("confirmation") ?? null);
}
