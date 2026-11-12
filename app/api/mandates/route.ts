// POST /api/mandates — the owner's side of a firm's access (v1 spec §7.1).
//
//   { action: "grant", request_id }   grant a firm's waiting request
//   { action: "revoke", mandate_id }  one tap; access ends at the next request
//
// Owner only ("mandates.manage"), from our own page, for the business in
// the session's door; the id names a request or a mandate of THIS business.

import { type NextRequest, NextResponse } from "next/server";
import { resolveAccess } from "../../../lib/auth/access";
import { requireRole } from "../../../lib/auth/roles";
import { appOriginOf, isSameOriginPost } from "../../../lib/auth/same-origin";
import { logSafeError } from "../../../lib/core/log-safe";
import { MandateError, grantRequest, revokeMandate } from "../../../lib/partners/mandates";

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!isSameOriginPost(request.headers, appOriginOf(request.url))) {
    return NextResponse.json({ error: "change this from our own page" }, { status: 403 });
  }
  const access = await resolveAccess();
  if (!access?.session) return NextResponse.json({ error: "sign in first" }, { status: 401 });
  const denied = requireRole(access, "mandates.manage");
  if (denied) return denied;
  let b: { action?: unknown; request_id?: unknown; mandate_id?: unknown };
  try {
    b = (await request.json()) as typeof b;
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  try {
    if (b.action === "grant" && typeof b.request_id === "string") {
      const m = await grantRequest({
        ownerUserId: access.session.user_id,
        ownerEmail: access.session.email,
        profileId: access.profile_id,
        requestId: b.request_id,
      });
      return NextResponse.json({ mandate_id: m.id });
    }
    if (b.action === "revoke" && typeof b.mandate_id === "string") {
      await revokeMandate({
        ownerUserId: access.session.user_id,
        profileId: access.profile_id,
        mandateId: b.mandate_id,
      });
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: "unknown action" }, { status: 400 });
  } catch (error) {
    if (error instanceof MandateError)
      return NextResponse.json({ error: error.message }, { status: error.status });
    console.error(
      JSON.stringify({
        event: "mandate_action_failed",
        account_id: access.account_id,
        ...logSafeError(error),
      }),
    );
    return NextResponse.json({ error: "something went wrong on our side" }, { status: 500 });
  }
}
