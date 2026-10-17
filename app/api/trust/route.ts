// The trust API — Phase 3 Session E (P3-26/27). One deterministic
// read: the scorecard and the full suggestion history with outcomes.
// No POST — this surface only ever reports; nothing here acts.

import { resolveAccess } from "../../../lib/auth/access";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "../../../db";
import { businessProfiles } from "../../../db/schema";
import { buildTrustView } from "../../../lib/trust/scorecard";

export async function GET(): Promise<NextResponse> {
  // The one door (lib/auth/access): a signed cookie, and an owned business only for its own account.
  const profileId = (await resolveAccess())?.profile_id;
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
