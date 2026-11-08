// The TikTok post form on /content — 2026-11-08.
//
//   GET  /api/content/tiktok              the connected TikTok account as TikTok describes
//                                         it NOW (creator_info, read live as TikTok requires
//                                         when the post form renders): nickname, the privacy
//                                         options SYB offers, which interactions the account
//                                         has turned off, the longest video it may post
//   POST /api/content/tiktok {item_id, privacy_level, allow_comment, allow_duet,
//                             allow_stitch, brand_organic}
//                                         the owner's choice for one draft whose TikTok
//                                         proposal waits for its decision; approving it then
//                                         hashes these with the caption and the video
//
// Signed-in sessions of this business; choosing is part of deciding
// (proposals.decide).

import { type NextRequest, NextResponse } from "next/server";
import { resolveAccess } from "../../../../lib/auth/access";
import { requireRole } from "../../../../lib/auth/roles";
import { logSafeError } from "../../../../lib/core/log-safe";
import { ContentError } from "../../../../lib/content/plan";
import { saveTikTokSettings, tiktokCreatorView } from "../../../../lib/content/tiktok-publish";
import { ExecutionConnectionError } from "../../../../lib/execution/connections";

function onError(error: unknown, accountId: string): NextResponse {
  if (error instanceof ContentError || error instanceof ExecutionConnectionError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  console.error(
    JSON.stringify({
      event: "content_tiktok_error",
      account_id: accountId,
      ...logSafeError(error),
    }),
  );
  return NextResponse.json({ error: "something went wrong on our side" }, { status: 500 });
}

export async function GET(): Promise<NextResponse> {
  const access = await resolveAccess();
  const session = access?.session ?? null;
  if (!access || !session) return NextResponse.json({ error: "sign in first" }, { status: 401 });
  try {
    return NextResponse.json(await tiktokCreatorView(session.account_id));
  } catch (error) {
    return onError(error, session.account_id);
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const access = await resolveAccess();
  const session = access?.session ?? null;
  if (!access || !session) return NextResponse.json({ error: "sign in first" }, { status: 401 });
  const denied = requireRole(access, "proposals.decide");
  if (denied) return denied;
  try {
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (typeof body?.["item_id"] !== "string") {
      return NextResponse.json({ error: "item_id is required" }, { status: 422 });
    }
    const settings = await saveTikTokSettings({
      profileId: access.profile_id,
      accountId: session.account_id,
      itemId: body["item_id"],
      input: body,
    });
    return NextResponse.json({ settings });
  } catch (error) {
    return onError(error, session.account_id);
  }
}
