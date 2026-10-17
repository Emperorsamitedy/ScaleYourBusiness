// POST /api/research/discover — the agent goes and looks.
//
// From the profile's own facts to 3–5 candidate competitors. Nothing is
// written: the response is a proposal list for the owner to confirm, and
// confirming (POST /api/research/competitor) is what creates the record.
// Session-scoped exactly like the intake — no auth beyond what the
// intake needs.

import { logSafeError } from "../../../../lib/core/log-safe";
import { resolveAccess } from "../../../../lib/auth/access";
import { NextResponse } from "next/server";
import { ResearchError } from "../../../../lib/research/competitor";
import { discoverCompetitors } from "../../../../lib/research/discovery";

async function resolveSession(): Promise<{ account_id: string; profile_id: string } | null> {
  // The one door (lib/auth/access): a signed cookie, and an owned business only for its own account.
  const access = await resolveAccess();
  return access ? { profile_id: access.profile_id, account_id: access.account_id } : null;
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
        ...logSafeError(error),
      }),
    );
    return NextResponse.json({ error: "something went wrong on our side" }, { status: 500 });
  }
}
