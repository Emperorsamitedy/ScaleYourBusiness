// The reviews API — idea 45, bad-review alerts.
//
//   GET  /api/reviews                         the reviews (newest first), the forwarding
//                                             address, and the platforms a paste can name
//   POST /api/reviews {action:"paste", …}     file a review the owner pasted
//   POST /api/reviews {action:"draft", id}    suggest a reply (Sonnet, capped)
//   POST /api/reviews {action:"remove", id}   remove a review, its reviewer and its draft
//   POST /api/reviews {action:"rotate"}       a new forwarding address; the old one stops
//
// Reading needs the intake cookie; every POST needs a signed-in owner and a
// same-origin POST, as the other owner screens do. Nothing here posts a
// reply anywhere: SYB writes to no review platform, ever.

import { type NextRequest, NextResponse } from "next/server";
import { matchingSession, resolveAccess } from "../../../lib/auth/access";
import { appOriginOf, isSameOriginPost } from "../../../lib/auth/same-origin";
import { logSafeError } from "../../../lib/core/log-safe";
import { draftReviewReply } from "../../../lib/review-desk/draft";
import { eraseReview } from "../../../lib/review-desk/erase";
import { pasteReview, readPaste } from "../../../lib/review-desk/paste";
import { ReviewDeskError, rotateReviewToken } from "../../../lib/review-desk/settings";
import type { ReviewsView } from "../../../lib/review-desk/view";
import { loadReviewsView } from "../../../lib/review-desk/view";

export type { ReviewsView };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function GET(): Promise<NextResponse> {
  const access = await resolveAccess();
  if (!access) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  try {
    return NextResponse.json(await loadReviewsView(access.profile_id));
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "reviews_view_failed",
        account_id: access.account_id,
        ...logSafeError(error),
      }),
    );
    return NextResponse.json({ error: "something went wrong on our side" }, { status: 500 });
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!isSameOriginPost(request.headers, appOriginOf(request.url))) {
    return NextResponse.json({ error: "this has to come from SYB's own page" }, { status: 403 });
  }
  const access = await resolveAccess();
  if (!access) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  if (!(await matchingSession())) {
    return NextResponse.json({ error: "this needs you signed in" }, { status: 401 });
  }
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const id = typeof body.id === "string" && UUID_RE.test(body.id) ? body.id : null;
  try {
    switch (body.action) {
      case "paste": {
        const out = await pasteReview(access.profile_id, readPaste(body, new Date()));
        return NextResponse.json({ filed: out.kind === "filed" });
      }
      case "draft": {
        if (!id) return NextResponse.json({ error: "which review?" }, { status: 422 });
        const out = await draftReviewReply({ profileId: access.profile_id, reviewId: id });
        return NextResponse.json(
          out.drafted ? { drafted: true } : { drafted: false, message: out.message },
        );
      }
      case "remove": {
        if (!id) return NextResponse.json({ error: "which review?" }, { status: 422 });
        await eraseReview(access.profile_id, id);
        return NextResponse.json({ removed: true });
      }
      case "rotate": {
        await rotateReviewToken(access.profile_id);
        return NextResponse.json({ rotated: true });
      }
      default:
        return NextResponse.json({ error: "unknown action" }, { status: 422 });
    }
  } catch (error) {
    if (error instanceof ReviewDeskError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error(
      JSON.stringify({
        event: "reviews_post_failed",
        account_id: access.account_id,
        ...logSafeError(error),
      }),
    );
    return NextResponse.json({ error: "something went wrong on our side" }, { status: 500 });
  }
}
