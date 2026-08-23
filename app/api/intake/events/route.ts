// POST /api/intake/events — the P0-87 telemetry sink. Accepts a batched
// JSON body ({ events: [...] }) from fetch-keepalive or sendBeacon (which
// may post text/plain), validates hard, and never errors the intake:
// a malformed batch is dropped, not bounced.

import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "../../../../db";
import { businessProfiles } from "../../../../db/schema";
import { recordIntakeEvents } from "../../../../lib/intake/telemetry";

const COOKIE = "syb_intake_profile";

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const store = await cookies();
    const profileId = store.get(COOKIE)?.value;
    if (!profileId) return new NextResponse(null, { status: 204 });
    const exists = await db
      .select({ id: businessProfiles.id })
      .from(businessProfiles)
      .where(eq(businessProfiles.id, profileId));
    if (exists.length === 0) return new NextResponse(null, { status: 204 });

    // sendBeacon may arrive as text/plain — parse the raw body.
    const raw = await request.text();
    let payload: { events?: unknown };
    try {
      payload = JSON.parse(raw) as { events?: unknown };
    } catch {
      return new NextResponse(null, { status: 204 });
    }
    const accepted = await recordIntakeEvents(profileId, payload.events);
    return NextResponse.json({ accepted }, { status: 200 });
  } catch {
    // Telemetry must never break the intake.
    return new NextResponse(null, { status: 204 });
  }
}
