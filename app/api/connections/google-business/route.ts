// The Google Business Profile consent API — I-45a, rule 13.
//
//   GET     /api/connections/google-business   the consent screen: what the permission can do,
//                                              what SYB does with it, whether it's set up, the
//                                              connection, how the last read went, and — while a
//                                              sign-in waits for its pick — the locations to pick
//   DELETE  /api/connections/google-business   { id }: revoke (the access is deleted here at once)
//                                              { pending: true }: forget a sign-in waiting for its pick
//
// Granting goes through ./start (the typed phrase, then Google's own
// screen), ./callback and ./finish. Signed-in sessions of this business
// only; granting and revoking are the owner's own (write_access.manage).

import { cookies } from "next/headers";
import { type NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "../../../../db";
import { reviewSettings } from "../../../../db/schema";
import { resolveAccess } from "../../../../lib/auth/access";
import { requireRole } from "../../../../lib/auth/roles";
import { logSafeError } from "../../../../lib/core/log-safe";
import { googleBusinessEnv } from "../../../../lib/env";
import {
  ExecutionConnectionError,
  activeExecutionConnection,
  toPublicExecutionConnection,
} from "../../../../lib/execution/connections";
import { EXECUTION_SCOPE_REGISTRY } from "../../../../lib/execution/scopes";
import { GbpRequestError } from "../../../../lib/google-business/client";
import {
  GOOGLE_PROVIDER,
  GOOGLE_REVIEWS_PHRASE,
  googleConsentLines,
  revokeGoogleReviews,
} from "../../../../lib/google-business/consent";
import {
  GOOGLE_PENDING_COOKIE,
  googleCookieOptions,
  googleFlowOrigin,
  googleLoginConfig,
  listPendingLocations,
} from "../../../../lib/google-business/login";
import { googleReadWords } from "../../../../lib/google-business/reasons";
import {
  GOOGLE_NEEDS,
  GOOGLE_NOTHING_WRITTEN,
  GOOGLE_NOT_SET_UP,
  GOOGLE_REVOKE_NOTE,
  GOOGLE_WHAT_IT_CAN_DO,
} from "../../../../lib/google-business/words";

function onError(error: unknown, accountId: string): NextResponse {
  if (error instanceof ExecutionConnectionError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  if (error instanceof GbpRequestError) {
    return NextResponse.json({ error: error.message }, { status: 502 });
  }
  console.error(
    JSON.stringify({
      event: "google_business_route_error",
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
    const requestOrigin = new URL(request.url).origin;
    const config = googleLoginConfig(googleBusinessEnv(), requestOrigin);
    const row = await activeExecutionConnection(session.account_id, GOOGLE_PROVIDER);
    const [settings] = await db
      .select({
        title: reviewSettings.google_location_title,
        read_at: reviewSettings.google_read_at,
        outcome: reviewSettings.google_read_outcome,
      })
      .from(reviewSettings)
      .where(eq(reviewSettings.profile_id, access.profile_id));
    // A sign-in waiting for its pick: the locations, re-read from Google.
    let pick: { id: string; title: string }[] | null = null;
    const store = await cookies();
    const pending = store.get(GOOGLE_PENDING_COOKIE)?.value ?? null;
    if (row === null && pending) {
      try {
        pick = (
          await listPendingLocations({
            accountId: session.account_id,
            profileId: access.profile_id,
            pendingCookie: pending,
            config,
          })
        ).map((l) => ({ id: `${l.account}/${l.location}`, title: l.title }));
      } catch {
        pick = null;
      }
    }
    const spec = EXECUTION_SCOPE_REGISTRY[GOOGLE_PROVIDER];
    return NextResponse.json({
      label: spec.label,
      configured: config !== null,
      not_set_up: config === null ? GOOGLE_NOT_SET_UP : null,
      what_it_can_do: GOOGLE_WHAT_IT_CAN_DO,
      // Verbatim from the registry: the screen can't promise what it doesn't declare.
      consent: googleConsentLines(),
      scope: spec.write_scopes[0],
      needs: GOOGLE_NEEDS,
      confirm_phrase: GOOGLE_REVIEWS_PHRASE,
      nothing_written: GOOGLE_NOTHING_WRITTEN,
      revoke_note: GOOGLE_REVOKE_NOTE,
      connection: row ? toPublicExecutionConnection(row) : null,
      location_title: row ? (settings?.title ?? null) : null,
      last_read:
        row && settings?.read_at
          ? { at: settings.read_at, words: googleReadWords(settings.outcome) }
          : null,
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
  const origin = googleFlowOrigin(
    googleLoginConfig(googleBusinessEnv(), requestOrigin),
    requestOrigin,
  );
  try {
    const body = (await request.json().catch(() => null)) as {
      id?: unknown;
      pending?: unknown;
    } | null;
    if (body?.pending === true) {
      const res = NextResponse.json({ forgotten: true });
      res.cookies.set(GOOGLE_PENDING_COOKIE, "", googleCookieOptions(origin, 0));
      return res;
    }
    if (typeof body?.id !== "string") {
      return NextResponse.json({ error: "id is required" }, { status: 422 });
    }
    return NextResponse.json(await revokeGoogleReviews(session.account_id, body.id));
  } catch (error) {
    return onError(error, session.account_id);
  }
}
