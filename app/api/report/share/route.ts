// The owner's report links — idea 51 (lib/report/share.ts).
//
//   GET  /api/report/share   every link this business has made, with its state
//   POST /api/report/share   { action: "create", days?: 7 | 30 }
//                            { action: "revoke", share_id }
//
// Owner-only: a signed-in session for this profile's account, not just the
// intake cookie — a link that leaves the product is the owner's act, and it
// goes into the decision log as one. The POST is same-origin only
// (lib/auth/same-origin, as /api/support and sign-in are): checked before
// anything is read, so a cross-site form can't mint a link to someone's
// report or revoke one.

import { type NextRequest, NextResponse } from "next/server";
import { resolveAccess } from "../../../../lib/auth/access";
import { appOriginOf, isSameOriginPost } from "../../../../lib/auth/same-origin";
import { logSafeError } from "../../../../lib/core/log-safe";
import {
  DEFAULT_SHARE_DAYS,
  ShareError,
  createShare,
  isShareDays,
  listShares,
  revokeShare,
} from "../../../../lib/report/share";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function owner() {
  const access = await resolveAccess();
  return access?.session ? access : null;
}

export async function GET(): Promise<NextResponse> {
  const access = await owner();
  if (!access) return NextResponse.json({ error: "sign in to share your report" }, { status: 401 });
  try {
    const shares = await listShares({
      accountId: access.account_id,
      profileId: access.profile_id,
    });
    return NextResponse.json({ shares }, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "report_share_error",
        account_id: access.account_id,
        ...logSafeError(error),
      }),
    );
    return NextResponse.json({ error: "something went wrong on our side" }, { status: 500 });
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!isSameOriginPost(request.headers, appOriginOf(request.url))) {
    console.warn(JSON.stringify({ event: "report_share_cross_site_refused", account_id: null }));
    return NextResponse.json({ error: "this request didn't come from our page" }, { status: 403 });
  }
  const access = await owner();
  if (!access) return NextResponse.json({ error: "sign in to share your report" }, { status: 401 });

  let body: { action?: unknown; days?: unknown; share_id?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "body must be JSON" }, { status: 400 });
  }

  try {
    if (body.action === "create") {
      const days = body.days === undefined ? DEFAULT_SHARE_DAYS : body.days;
      if (!isShareDays(days)) {
        return NextResponse.json({ error: "a link lasts 7 or 30 days" }, { status: 400 });
      }
      const { token, share } = await createShare({
        accountId: access.account_id,
        profileId: access.profile_id,
        userId: access.session?.user_id ?? null,
        days,
      });
      // The token leaves exactly once, inside the URL; it is never readable again.
      const url = `${appOriginOf(request.url)}/shared/${token}`;
      return NextResponse.json(
        { url, share },
        { status: 201, headers: { "cache-control": "private, no-store" } },
      );
    }
    if (body.action === "revoke") {
      const shareId = typeof body.share_id === "string" ? body.share_id : "";
      if (!UUID_RE.test(shareId)) {
        return NextResponse.json({ error: "share_id is required" }, { status: 400 });
      }
      const result = await revokeShare({
        accountId: access.account_id,
        profileId: access.profile_id,
        shareId,
      });
      return NextResponse.json(result);
    }
    return NextResponse.json({ error: "action must be create or revoke" }, { status: 400 });
  } catch (error) {
    if (error instanceof ShareError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error(
      JSON.stringify({
        event: "report_share_error",
        account_id: access.account_id,
        ...logSafeError(error),
      }),
    );
    return NextResponse.json({ error: "something went wrong on our side" }, { status: 500 });
  }
}
