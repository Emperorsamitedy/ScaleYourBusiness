// POST /api/competitors/:id/match { key, offer_id } — the owner corrects
// which of their offers a competitor's offer compares with: an offer id,
// "none", or null to go back to the match table's own guess.

import { NextResponse } from "next/server";
import { setOfferMatch } from "../../../../../lib/competitors/service";
import { body, failure, session, signedOut } from "../../shared";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const s = await session();
  if (!s) return signedOut();
  const { id } = await params;
  const input = await body(request);
  const key = typeof input?.key === "string" ? input.key : "";
  const offer = input?.offer_id;
  if (key === "" || !(offer === null || typeof offer === "string")) {
    return NextResponse.json({ error: "key and offer_id are required" }, { status: 400 });
  }
  try {
    await setOfferMatch(s.profile_id, id, key, offer);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return failure(error, s.account_id, "competitor_match_failed");
  }
}
