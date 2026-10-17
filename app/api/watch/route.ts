// GET /api/watch — the watching status screen's read (P1-47): the
// current decision, the honest activity log, days remaining, the
// thresholds that would trigger an interruption, and (P2-24) any
// interruption that has actually happened. All of it is stored fact;
// nothing here is generated.

import { resolveAccess } from "../../../lib/auth/access";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "../../../db";
import { businessProfiles } from "../../../db/schema";
import { openInterruptions } from "../../../lib/anomaly/detect";
import { thresholdTexts } from "../../../lib/anomaly/thresholds";
import { latestDecision } from "../../../lib/mode/service";
import { watchLog } from "../../../lib/watch/job";

export async function GET(): Promise<NextResponse> {
  // The one door (lib/auth/access): a signed cookie, and an owned business only for its own account.
  const profileId = (await resolveAccess())?.profile_id;
  if (!profileId) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  const [row] = await db
    .select({ id: businessProfiles.id })
    .from(businessProfiles)
    .where(eq(businessProfiles.id, profileId));
  if (!row) return NextResponse.json({ error: "no intake session" }, { status: 401 });

  const decision = await latestDecision(profileId);
  const log = await watchLog(profileId);
  const daysRemaining =
    decision?.mode === "watching"
      ? Math.max(0, Math.ceil((Date.parse(decision.review_at) - Date.now()) / 86_400_000))
      : null;

  return NextResponse.json({
    decision,
    days_remaining: daysRemaining,
    // The rules as code (P2-24), each saying whether anything enforces it yet.
    thresholds: thresholdTexts(),
    interruptions: await openInterruptions(profileId),
    log: log.map((entry) => ({ at: entry.at, kind: entry.kind, detail: entry.detail })),
  });
}
