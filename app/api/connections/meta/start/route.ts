// POST /api/connections/meta/start — Facebook Login for testers, step 1 (P3-20j).
//
// The Execution section's form posts { provider, confirmation } here. The
// signed-in owner (a session for THIS profile's account, via resolveAccess)
// must have typed the consent phrase on SYB's screen: it is checked before
// any redirect. Then a single-use nonce cookie and a 303 to Meta's OAuth
// dialog asking for exactly the provider's registry scopes. Every refusal
// goes back to /connections with a reason code (review 2026-10-23, Session
// D #9) that the screen turns into a fixed sentence; nothing is sent to Meta.
//
// POST only, from our own origin (review 2026-10-23, Session D #8). A GET
// used to start the flow too, and the start refused only a Sec-Fetch-Site of
// cross-site or same-site — so a link from anywhere, opened by a browser
// that sends no Sec-Fetch-Site, took a signed-in owner into Meta's dialog
// with the phrase already "typed". Now the start must prove it came from our
// page (isSameOriginPost: Sec-Fetch-Site, else Origin; neither → refused),
// and a GET only sends the owner back to the button.

import { type NextRequest, NextResponse } from "next/server";
import { resolveAccess } from "../../../../../lib/auth/access";
import { appOriginOf, isSameOriginPost } from "../../../../../lib/auth/same-origin";
import { logSafeError } from "../../../../../lib/core/log-safe";
import { metaLoginEnv } from "../../../../../lib/env";
import { ExecutionConnectionError } from "../../../../../lib/execution/connections";
import {
  META_LOGIN_NONCE_COOKIE,
  META_LOGIN_PENDING_COOKIE,
  MetaLoginError,
  connectionsReturnUrl,
  flowOrigin,
  isMetaLoginProvider,
  loginCookieOptions,
  metaLoginConfig,
  reasonForLoginFailure,
  startMetaLogin,
} from "../../../../../lib/execution/meta-login";
import type { ConnectionsReason } from "../../../../../lib/execution/meta-login-reasons";
import { requireRole } from "../../../../../lib/auth/roles";

function backTo(request: NextRequest, provider: unknown, reason: ConnectionsReason): NextResponse {
  const requestOrigin = new URL(request.url).origin;
  const origin = flowOrigin(metaLoginConfig(metaLoginEnv(), requestOrigin), requestOrigin);
  return NextResponse.redirect(
    connectionsReturnUrl(origin, {
      kind: "failed",
      provider: isMetaLoginProvider(provider) ? provider : null,
      reason,
    }),
    303,
  );
}

async function start(
  request: NextRequest,
  provider: unknown,
  confirmation: unknown,
): Promise<NextResponse> {
  const requestOrigin = new URL(request.url).origin;
  const config = metaLoginConfig(metaLoginEnv(), requestOrigin);
  const origin = flowOrigin(config, requestOrigin);
  const back = (reason: ConnectionsReason) => backTo(request, provider, reason);

  const access = await resolveAccess();
  const session = access?.session ?? null;
  if (!access || !session) return back("signed_out");

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
    if (error instanceof MetaLoginError) return back(reasonForLoginFailure(error.reason));
    if (!(error instanceof ExecutionConnectionError)) {
      console.error(
        JSON.stringify({
          event: "meta_login_start_failed",
          account_id: session.account_id,
          ...logSafeError(error),
        }),
      );
    }
    return back("internal");
  }
}

/** A link can't start the sign-in: it goes back to the button on /connections, nothing sent. */
export async function GET(request: NextRequest): Promise<NextResponse> {
  return backTo(request, request.nextUrl.searchParams.get("provider"), "start_here");
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  // The phrase must have been typed on SYB's own screen, not carried in by another site's form.
  if (!isSameOriginPost(request.headers, appOriginOf(request.url))) {
    console.warn(JSON.stringify({ event: "meta_login_start_refused", account_id: null }));
    return backTo(request, null, "start_here");
  }
  // Idea 52: write access is the owner's own consent (rule 13).
  const denied = requireRole(await resolveAccess(), "write_access.manage");
  if (denied) return backTo(request, null, denied.status === 401 ? "signed_out" : "owner_only");
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
