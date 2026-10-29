// POST /api/competitors/:id/read — the owner's "read their pages now".
// The same reader the weekly run uses: only the listed pages, robots.txt
// honoured, the hardened fetcher, the model fallback under its caps. At
// most once per competitor every six hours.

import { NextResponse } from "next/server";
import { readOneNow } from "../../../../../lib/competitors/service";
import { failure, session, signedOut } from "../../shared";
import { requireRole } from "../../../../../lib/auth/roles";

export const maxDuration = 60;

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const s = await session();
  if (!s) return signedOut();
  const denied = requireRole(s, "competitors.manage");
  if (denied) return denied;
  const { id } = await params;
  try {
    const result = await readOneNow(s.profile_id, id);
    console.log(
      JSON.stringify({
        event: "competitor_read",
        account_id: s.account_id,
        competitor_id: id,
        pages: result.pages.length,
        offers_seen: result.offers_seen,
        changes: result.changes.length,
        model: result.model,
      }),
    );
    return NextResponse.json(result);
  } catch (error) {
    return failure(error, s.account_id, "competitor_read_failed");
  }
}
