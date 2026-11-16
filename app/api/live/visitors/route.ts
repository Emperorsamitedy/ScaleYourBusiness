// GET /api/live/visitors — Home's live line (lib/live/visitors): people on
// the business's own site in each of the last 30 minutes, from its Google
// Analytics connection, read-only and never stored. Any reader of the
// business may see it (owner, manager, viewer): it is a figure, not an act.

import { NextResponse } from "next/server";
import { resolveAccess } from "../../../../lib/auth/access";
import { liveVisitors } from "../../../../lib/live/visitors";

export async function GET(): Promise<NextResponse> {
  // The one door (lib/auth/access): a signed cookie, and an owned business only for its own account.
  const access = await resolveAccess();
  if (!access) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  return NextResponse.json(await liveVisitors(access.account_id), {
    headers: { "cache-control": "private, no-store" },
  });
}
