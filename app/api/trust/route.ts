// The trust API — Phase 3 Session E (P3-26/27). One deterministic
// read: the scorecard and the full suggestion history with outcomes.
// No POST — this surface only ever reports; nothing here acts.

import { eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { db } from "../../../db";
import { businessProfiles } from "../../../db/schema";
import { buildTrustView } from "../../../lib/trust/scorecard";

const COOKIE = "syb_intake_profile";

export async function GET(): Promise<NextResponse> {
  const store = await cookies();
  const profileId = store.get(COOKIE)?.value;
  if (!profileId) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  const [row] = await db
    .select({ id: businessProfiles.id })
    .from(businessProfiles)
    .where(eq(businessProfiles.id, profileId));
  if (!row) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  try {
    return NextResponse.json(await buildTrustView(row.id));
  } catch (error) {
    console.error(JSON.stringify({ event: "trust_error", message: String(error) }));
    return NextResponse.json({ error: "something went wrong on our side" }, { status: 500 });
  }
}
