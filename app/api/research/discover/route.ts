// POST /api/research/discover — the agent goes and looks.
//
// From the profile's own facts to 3–5 candidate competitors. Nothing is
// written: the response is a proposal list for the owner to confirm, and
// confirming (POST /api/research/competitor) is what creates the record.
// Session-scoped exactly like the intake — no auth beyond what the
// intake needs.

import { eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { db } from "../../../../db";
import { businessProfiles } from "../../../../db/schema";
import { ResearchError } from "../../../../lib/research/competitor";
import { discoverCompetitors } from "../../../../lib/research/discovery";

const COOKIE = "syb_intake_profile";

async function resolveSession(): Promise<{ account_id: string; profile_id: string } | null> {
  const store = await cookies();
  const profileId = store.get(COOKIE)?.value;
  if (!profileId) return null;
  const [row] = await db
    .select({ profile_id: businessProfiles.id, account_id: businessProfiles.account_id })
    .from(businessProfiles)
    .where(eq(businessProfiles.id, profileId));
  return row ?? null;
}

export async function POST(): Promise<NextResponse> {
  const session = await resolveSession();
  if (!session) {
    return NextResponse.json({ error: "no intake session" }, { status: 401 });
  }
  try {
    const result = await discoverCompetitors({
      accountId: session.account_id,
      profileId: session.profile_id,
    });
    return NextResponse.json({
      candidates: result.candidates,
      based_on: result.based_on,
      dropped: result.dropped,
      discovered_at: result.discovered_at,
      events: result.events,
    });
  } catch (error) {
    if (error instanceof ResearchError) {
      return NextResponse.json({ error: error.message }, { status: 422 });
    }
    console.error(
      JSON.stringify({
        event: "research_error",
        account_id: session.account_id,
        message: String(error),
      }),
    );
    return NextResponse.json({ error: "something went wrong on our side" }, { status: 500 });
  }
}
