// POST /api/business/erasure — the owner asks for this business to be erased
// (v1 spec §9.4). It leaves every benchmark aggregate at once; an operator
// completes the removal of its data. Owner only, from our own page.

import { type NextRequest, NextResponse } from "next/server";
import { resolveAccess } from "../../../../lib/auth/access";
import { requireRole } from "../../../../lib/auth/roles";
import { appOriginOf, isSameOriginPost } from "../../../../lib/auth/same-origin";
import { logSafeError } from "../../../../lib/core/log-safe";
import { requestErasure } from "../../../../lib/compliance/erasure";

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!isSameOriginPost(request.headers, appOriginOf(request.url))) {
    return NextResponse.json({ error: "ask from our own page" }, { status: 403 });
  }
  const access = await resolveAccess();
  if (!access) return NextResponse.json({ error: "no session" }, { status: 401 });
  const denied = requireRole(access, "business.erase");
  if (denied) return denied;
  try {
    const r = await requestErasure(access.profile_id, access.session?.user_id ?? null);
    console.log(
      JSON.stringify({ event: "business_erasure_requested", account_id: access.account_id }),
    );
    return NextResponse.json({ requested_at: r?.requested_at ?? null });
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "business_erasure_failed",
        account_id: access.account_id,
        ...logSafeError(error),
      }),
    );
    return NextResponse.json({ error: "something went wrong on our side" }, { status: 500 });
  }
}
