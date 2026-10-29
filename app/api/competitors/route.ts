// /api/competitors — feature 35. GET: the Competitors screen's view.
// POST { name, url?, listing_url?, price_pages? }: add one to the list,
// through the fact write path. Nothing here fetches anything.

import { NextResponse } from "next/server";
import { addCompetitor } from "../../../lib/competitors/service";
import { buildCompetitorsView } from "../../../lib/competitors/view";
import { body, failure, session, signedOut } from "./shared";
import { requireRole } from "../../../lib/auth/roles";

export async function GET(): Promise<NextResponse> {
  const s = await session();
  if (!s) return signedOut();
  try {
    return NextResponse.json(await buildCompetitorsView(s.profile_id));
  } catch (error) {
    return failure(error, s.account_id, "competitors_view_failed");
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const s = await session();
  if (!s) return signedOut();
  const denied = requireRole(s, "competitors.manage");
  if (denied) return denied;
  const input = await body(request);
  if (!input) return NextResponse.json({ error: "body must be a JSON object" }, { status: 400 });
  try {
    const id = await addCompetitor(s.profile_id, input);
    return NextResponse.json({ id }, { status: 201 });
  } catch (error) {
    return failure(error, s.account_id, "competitor_add_failed");
  }
}
