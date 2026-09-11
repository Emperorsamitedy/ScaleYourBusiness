// The mode decision API — Session H (P1-42..45).
//
//   GET  /api/mode   latest decision, or {none:true}
//   POST /api/mode   decide from the profile's current state (or defer)
//   PUT  /api/mode   override the watch length — extend freely,
//                    shorten only with an acknowledgement (P1-44)

import { eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { type NextRequest, NextResponse } from "next/server";
import { db } from "../../../db";
import { businessProfiles } from "../../../db/schema";
import { currentSession } from "../../../lib/auth/service";
import { ModeError, decideForProfile, latestDecision, overrideWatch } from "../../../lib/mode/service";

const COOKIE = "syb_intake_profile";
const AUTH_COOKIE = "syb_session";

async function resolveProfile(): Promise<string | null> {
  const store = await cookies();
  const profileId = store.get(COOKIE)?.value;
  if (!profileId) return null;
  const [row] = await db
    .select({ id: businessProfiles.id })
    .from(businessProfiles)
    .where(eq(businessProfiles.id, profileId));
  return row?.id ?? null;
}

function onError(error: unknown): NextResponse {
  if (error instanceof ModeError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  console.error(JSON.stringify({ event: "mode_error", message: String(error) }));
  return NextResponse.json({ error: "something went wrong on our side" }, { status: 500 });
}

export async function GET(): Promise<NextResponse> {
  const profileId = await resolveProfile();
  if (!profileId) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  try {
    const decision = await latestDecision(profileId);
    return NextResponse.json(decision ?? { none: true });
  } catch (error) {
    return onError(error);
  }
}

export async function POST(): Promise<NextResponse> {
  const profileId = await resolveProfile();
  if (!profileId) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  try {
    return NextResponse.json(await decideForProfile(profileId));
  } catch (error) {
    return onError(error);
  }
}

export async function PUT(request: NextRequest): Promise<NextResponse> {
  const profileId = await resolveProfile();
  if (!profileId) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  try {
    const body = (await request.json()) as {
      to_weeks?: unknown;
      acknowledgement_text?: unknown;
    };
    const toWeeks = body.to_weeks;
    if (toWeeks !== 4 && toWeeks !== 6 && toWeeks !== 8) {
      return NextResponse.json({ error: "to_weeks must be 4, 6 or 8" }, { status: 422 });
    }
    const store = await cookies();
    const session = await currentSession(store.get(AUTH_COOKIE)?.value);
    const decision = await overrideWatch({
      profileId,
      toWeeks,
      userId: session?.user_id ?? null,
      ...(typeof body.acknowledgement_text === "string"
        ? { acknowledgementText: body.acknowledgement_text }
        : {}),
    });
    return NextResponse.json(decision);
  } catch (error) {
    return onError(error);
  }
}
