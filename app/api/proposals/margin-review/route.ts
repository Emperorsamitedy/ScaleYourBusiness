// A margin review, proposed — I-44a.
//
//   POST /api/proposals/margin-review   draft one margin review proposal for a
//                                       large, like-for-like gap against
//                                       similar businesses (lib/benchmarks/gap)
//
// Same-origin only. Proposing needs a signed-in user with the right to
// generate proposals (a proposal lands in their queue). It drafts; nothing
// executes it (rule 12), and no price, cost or listing is touched
// (lib/proposals/margin-review).

import { type NextRequest, NextResponse } from "next/server";
import { matchingSession, resolveAccess } from "../../../../lib/auth/access";
import { appOriginOf, isSameOriginPost } from "../../../../lib/auth/same-origin";
import { requireRole } from "../../../../lib/auth/roles";
import { logSafeError } from "../../../../lib/core/log-safe";
import { proposeMarginReview } from "../../../../lib/proposals/margin-review";

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!isSameOriginPost(request.headers, appOriginOf(request.url))) {
    return NextResponse.json({ error: "this has to come from SYB's own page" }, { status: 403 });
  }
  const access = await resolveAccess();
  if (!access) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  if (!(await matchingSession())) {
    return NextResponse.json({ error: "proposing needs you signed in" }, { status: 401 });
  }
  const denied = requireRole(access, "proposals.generate");
  if (denied) return denied;
  try {
    const run = await proposeMarginReview(access.profile_id);
    if ("proposal" in run) {
      return NextResponse.json(
        {
          status: run.status,
          id: run.proposal.id,
          blocked_by_limit: run.proposal.blocked_by_limit,
        },
        { status: 201 },
      );
    }
    return NextResponse.json(
      { status: run.status, error: run.reason },
      { status: run.status === "not_found" || run.status === "no_gap" ? 404 : 409 },
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "margin_review_post_failed",
        account_id: access.account_id,
        ...logSafeError(error),
      }),
    );
    return NextResponse.json({ error: "something went wrong on my side" }, { status: 500 });
  }
}
