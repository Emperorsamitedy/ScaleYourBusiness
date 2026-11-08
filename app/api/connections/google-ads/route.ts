// The Google Ads consent API — P2-20 / P3-22, rule 13.
//
//   GET     /api/connections/google-ads   the consent card: what Google's permission can do,
//                                         what SYB does with it, whether it's set up (and what's
//                                         missing), Google's access level, the connection, the
//                                         ad account and how the last read went, and — while a
//                                         sign-in waits for its pick — the ad accounts to pick
//   DELETE  /api/connections/google-ads   { id }: revoke (the access is deleted here at once)
//                                         { pending: true }: forget a sign-in waiting for its pick
//
// Granting goes through ./start (the typed phrase, then Google's own
// screen), ./callback and ./finish. Signed-in sessions of this business
// only; granting and revoking are the owner's own (write_access.manage).

import { cookies } from "next/headers";
import { type NextRequest, NextResponse } from "next/server";
import { resolveAccess } from "../../../../lib/auth/access";
import { requireRole } from "../../../../lib/auth/roles";
import { logSafeError } from "../../../../lib/core/log-safe";
import { googleAdsEnv, googleAdsMissing } from "../../../../lib/env";
import {
  ExecutionConnectionError,
  activeExecutionConnection,
  executionSecret,
  toPublicExecutionConnection,
} from "../../../../lib/execution/connections";
import { EXECUTION_SCOPE_REGISTRY } from "../../../../lib/execution/scopes";
import { GadsRequestError } from "../../../../lib/google-ads/client";
import {
  GOOGLE_ADS_PHRASE,
  GOOGLE_ADS_PROVIDER,
  googleAdsAccountOf,
  googleAdsConsentLines,
  revokeGoogleAds,
} from "../../../../lib/google-ads/consent";
import {
  GADS_PENDING_COOKIE,
  googleAdsCookieOptions,
  googleAdsFlowOrigin,
  googleAdsLoginConfig,
  listPendingAdAccounts,
} from "../../../../lib/google-ads/login";

function onError(error: unknown, accountId: string): NextResponse {
  if (error instanceof ExecutionConnectionError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  if (error instanceof GadsRequestError) {
    return NextResponse.json({ error: error.message }, { status: 502 });
  }
  console.error(
    JSON.stringify({
      event: "google_ads_route_error",
      account_id: accountId,
      ...logSafeError(error),
    }),
  );
  return NextResponse.json({ error: "something went wrong on our side" }, { status: 500 });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const access = await resolveAccess();
  const session = access?.session ?? null;
  if (!access || !session) {
    return NextResponse.json({ error: "sign in to manage connections" }, { status: 401 });
  }
  try {
    const env = googleAdsEnv();
    const config = googleAdsLoginConfig(env, new URL(request.url).origin);
    const row = await activeExecutionConnection(session.account_id, GOOGLE_ADS_PROVIDER);
    let account: { name: string; customer_id: string; currency: string } | null = null;
    if (row && row.encrypted_secret !== null) {
      try {
        account = googleAdsAccountOf(executionSecret(row));
      } catch {
        account = null;
      }
    }
    // A sign-in waiting for its pick: the ad accounts, re-read from Google.
    let pick: { id: string; name: string; currency: string; manager: boolean }[] | null = null;
    const pending = (await cookies()).get(GADS_PENDING_COOKIE)?.value ?? null;
    if (row === null && pending) {
      try {
        pick = (
          await listPendingAdAccounts({
            accountId: session.account_id,
            profileId: access.profile_id,
            pendingCookie: pending,
            config,
          })
        ).map((c) => ({
          id: c.customer_id,
          name: c.name,
          currency: c.currency,
          manager: c.manager,
        }));
      } catch {
        pick = null;
      }
    }
    const spec = EXECUTION_SCOPE_REGISTRY[GOOGLE_ADS_PROVIDER];
    return NextResponse.json({
      label: spec.label,
      configured: config !== null,
      // Exactly which keys are missing, by name: the card says them.
      missing: googleAdsMissing(),
      access_level: env?.access_level ?? null,
      // Verbatim from the registry: the screen can't promise what it doesn't declare.
      consent: googleAdsConsentLines(),
      scope: spec.write_scopes[0],
      confirm_phrase: GOOGLE_ADS_PHRASE,
      connection: row ? toPublicExecutionConnection(row) : null,
      account,
      last_read: row?.last_sync_at ? { at: row.last_sync_at, error: row.last_error } : null,
      pick,
    });
  } catch (error) {
    return onError(error, session.account_id);
  }
}

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  const access = await resolveAccess();
  const session = access?.session ?? null;
  if (!access || !session) {
    return NextResponse.json({ error: "sign in to manage connections" }, { status: 401 });
  }
  // Idea 52: write access is the owner's own consent (rule 13).
  const denied = requireRole(session, "write_access.manage");
  if (denied) return denied;
  const requestOrigin = new URL(request.url).origin;
  const origin = googleAdsFlowOrigin(
    googleAdsLoginConfig(googleAdsEnv(), requestOrigin),
    requestOrigin,
  );
  try {
    const body = (await request.json().catch(() => null)) as {
      id?: unknown;
      pending?: unknown;
    } | null;
    if (body?.pending === true) {
      const res = NextResponse.json({ forgotten: true });
      res.cookies.set(GADS_PENDING_COOKIE, "", googleAdsCookieOptions(origin, 0));
      return res;
    }
    if (typeof body?.id !== "string") {
      return NextResponse.json({ error: "id is required" }, { status: 422 });
    }
    return NextResponse.json(await revokeGoogleAds(session.account_id, body.id));
  } catch (error) {
    return onError(error, session.account_id);
  }
}
