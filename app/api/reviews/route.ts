// The reviews API — idea 45, bad-review alerts.
//
//   GET  /api/reviews                         the reviews (newest first), the forwarding
//                                             address, and the platforms a paste can name
//   POST /api/reviews {action:"paste", …}     file a review the owner pasted
//   POST /api/reviews {action:"draft", id}    suggest a reply (Sonnet, capped)
//   POST /api/reviews {action:"remove", id}   remove a review, its reviewer and its draft
//   POST /api/reviews {action:"rotate"}       a new forwarding address; the old one stops
//   POST /api/reviews {action:"post", id, text}
//                                             approve posting THIS reply under a Google
//                                             review (I-45a lifted 2026-11-16): a
//                                             proposal and its approval, then the engine
//
// Reading needs the intake cookie; every POST needs a signed-in owner and a
// same-origin POST, as the other owner screens do. Only "post" ever writes to
// a review platform, only to Google, and only through the engine.

import { type NextRequest, NextResponse } from "next/server";
import { matchingSession, resolveAccess } from "../../../lib/auth/access";
import { requireRole } from "../../../lib/auth/roles";
import type { RoleAction } from "../../../lib/auth/roles";
import { appOriginOf, isSameOriginPost } from "../../../lib/auth/same-origin";
import { logSafeError } from "../../../lib/core/log-safe";
import { requestWords } from "../../../lib/i18n/request-words";
import { draftReviewReply } from "../../../lib/review-desk/draft";
import { eraseReview } from "../../../lib/review-desk/erase";
import { pasteReview, readPaste } from "../../../lib/review-desk/paste";
import { approveGoogleReply } from "../../../lib/review-desk/post";
import { ReviewDeskError, rotateReviewToken } from "../../../lib/review-desk/settings";
import type { ReviewsView } from "../../../lib/review-desk/view";
import { loadReviewsView } from "../../../lib/review-desk/view";

export type { ReviewsView };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function GET(): Promise<NextResponse> {
  const access = await resolveAccess();
  if (!access) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  try {
    // L-4b: Google's last-read outcome in the reader's language; reviews are content.
    const { tr } = await requestWords("reviewsWords");
    return NextResponse.json(await loadReviewsView(access.profile_id, new Date(), tr));
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

/** Idea 52: the role each action needs (lib/auth/roles); an action not listed asks for an owner. */
const REVIEWS_ROLE: Record<string, RoleAction> = {
  paste: "reviews.answer",
  draft: "reviews.answer",
  post: "reviews.answer",
  remove: "reviews.answer",
  rotate: "reviews.settings",
};

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!isSameOriginPost(request.headers, appOriginOf(request.url))) {
    return NextResponse.json({ error: "this has to come from ScaleX's own page" }, { status: 403 });
  }
  const access = await resolveAccess();
  if (!access) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  const session = await matchingSession();
  if (!session) {
    return NextResponse.json({ error: "this needs you signed in" }, { status: 401 });
  }
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const denied = requireRole(access, REVIEWS_ROLE[String(body.action)] ?? "reviews.settings");
  if (denied) return denied;
  const id = typeof body.id === "string" && UUID_RE.test(body.id) ? body.id : null;
  try {
    switch (body.action) {
      case "paste": {
        const out = await pasteReview(access.profile_id, readPaste(body, new Date()));
        return NextResponse.json({ filed: out.kind === "filed" });
      }
      case "draft": {
        if (!id) return NextResponse.json({ error: "which review?" }, { status: 422 });
        const out = await draftReviewReply({
          profileId: access.profile_id,
          reviewId: id,
          words: await requestWords("reviewsWords"),
        });
        return NextResponse.json(
          out.drafted ? { drafted: true } : { drafted: false, message: out.message },
        );
      }
      case "post": {
        if (!id) return NextResponse.json({ error: "which review?" }, { status: 422 });
        if (typeof body.text !== "string") {
          return NextResponse.json({ error: "which words?" }, { status: 422 });
        }
        const out = await approveGoogleReply({
          profileId: access.profile_id,
          reviewId: id,
          userId: session.user_id,
          text: body.text,
        });
        return NextResponse.json(out, { status: 201 });
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
