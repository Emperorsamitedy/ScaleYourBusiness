// POST /api/intake/reconcile — the two resolution paths of §4.5 (P0-83):
// "Both are right" confirms, "Let me fix one" returns the involved
// questions to the centre. Session comes from the same intake cookie.

import { resolveAccess } from "../../../../lib/auth/access";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "../../../../db";
import { businessProfiles } from "../../../../db/schema";
import { IntakeError, reconcileFinding } from "../../../../lib/intake/service";

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    // The one door (lib/auth/access): a signed cookie, and an owned business only for its own account.
    const profileId = (await resolveAccess())?.profile_id;
    if (!profileId) return NextResponse.json({ error: "no intake session" }, { status: 404 });
    const rows = await db
      .select({ account_id: businessProfiles.account_id })
      .from(businessProfiles)
      .where(eq(businessProfiles.id, profileId));
    const profile = rows[0];
    if (!profile) return NextResponse.json({ error: "no intake session" }, { status: 404 });

    const body = (await request.json()) as { finding_id?: string; choice?: string };
    if (!body.finding_id || (body.choice !== "confirm" && body.choice !== "fix")) {
      return NextResponse.json({ error: "finding_id and choice required" }, { status: 400 });
    }
    return NextResponse.json(
      await reconcileFinding(profile.account_id, profileId, body.finding_id, body.choice),
    );
  } catch (error) {
    if (error instanceof IntakeError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
