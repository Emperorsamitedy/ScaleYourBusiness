// POST /api/research/competitor — read one competitor's own pages into a
// Competitor record. Body: { name } for a fresh record, or
// { name, competitor_id } to enrich one the owner already created.
//
// This is the confirmation half of discovery: an owner accepts a
// candidate (or names one themselves), and this route runs Session C's
// researchCompetitor with the live providers. Read scope only, forever.

import { resolveAccess } from "../../../../lib/auth/access";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { researchCompetitor, ResearchError } from "../../../../lib/research/competitor";
import { livePageFetcher, liveSearchProvider } from "../../../../lib/research/live";

async function resolveSession(): Promise<{ account_id: string; profile_id: string } | null> {
  // The one door (lib/auth/access): a signed cookie, and an owned business only for its own account.
  const access = await resolveAccess();
  return access ? { profile_id: access.profile_id, account_id: access.account_id } : null;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const session = await resolveSession();
  if (!session) {
    return NextResponse.json({ error: "no intake session" }, { status: 401 });
  }

  let body: { name?: unknown; competitor_id?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "body must be JSON" }, { status: 400 });
  }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (name === "") {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }
  const competitorId =
    typeof body.competitor_id === "string" && body.competitor_id !== ""
      ? body.competitor_id
      : undefined;

  try {
    const result = await researchCompetitor({
      accountId: session.account_id,
      profileId: session.profile_id,
      competitorName: name,
      ...(competitorId !== undefined ? { competitorId } : {}),
      search: liveSearchProvider,
      fetchPage: livePageFetcher,
    });
    return NextResponse.json({
      competitor_id: result.competitor_id,
      pages_read: result.pages_read,
      written: result.written,
      unknown: result.unknown,
      preserved_owner_facts: result.preserved_owner_facts,
      researched_at: result.researched_at,
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
