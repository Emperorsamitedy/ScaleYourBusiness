// GET /api/watch — the watching status screen's read (P1-47): the
// current decision, the honest activity log, days remaining, and the
// thresholds that would trigger an interruption. All of it is stored
// fact; nothing here is generated.

import { eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { db } from "../../../db";
import { businessProfiles } from "../../../db/schema";
import { latestDecision } from "../../../lib/mode/service";
import { watchLog } from "../../../lib/watch/job";

const COOKIE = "syb_intake_profile";

/** What would interrupt the watch early — shown, not enforced yet (Phase 2). */
const INTERRUPT_THRESHOLDS = [
  "Revenue drops more than 30% week over week",
  "A validation finding of critical severity appears",
  "You reopen a core answer the diagnosis rests on",
];

export async function GET(): Promise<NextResponse> {
  const store = await cookies();
  const profileId = store.get(COOKIE)?.value;
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
    thresholds: INTERRUPT_THRESHOLDS,
    log: log.map((entry) => ({ at: entry.at, kind: entry.kind, detail: entry.detail })),
  });
}
