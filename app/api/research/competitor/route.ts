// POST /api/research/competitor — read one competitor's own pages into a
// Competitor record. Body: { name } for a fresh record, or
// { name, competitor_id } to enrich one the owner already created.
//
// This is the confirmation half of discovery: an owner accepts a
// candidate (or names one themselves), and this route runs Session C's
// researchCompetitor with the live providers. Read scope only, forever.

import { eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { db } from "../../../../db";
import { businessProfiles } from "../../../../db/schema";
import { researchCompetitor, ResearchError } from "../../../../lib/research/competitor";
import { livePageFetcher, liveSearchProvider } from "../../../../lib/research/live";

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
