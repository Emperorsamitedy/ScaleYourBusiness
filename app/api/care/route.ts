// GET /api/care — the owner's view of alert mode (Session J, P3-44..47).
//
// Per measurable goal: the measure, the baseline, the latest weekly
// verdict with its arithmetic, and the latest alert review — what we
// think went wrong, with evidence, what it suggested, and whether a
// person at Ledgerline now has the case. Read-only: the suggestions it
// made are ordinary proposals in the queue.

import { logSafeError } from "../../../lib/core/log-safe";
import { resolveAccess } from "../../../lib/auth/access";
import { and, desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "../../../db";
import { alertReviews, watchActivity } from "../../../db/schema";
import { careState } from "../../../lib/care/day-zero";
import { readGoalMeasure } from "../../../lib/care/goal-measure";
import { listGoals } from "../../../lib/content/goals";

async function resolveProfile(): Promise<string | null> {
  // The one door (lib/auth/access): a signed cookie, and an owned business only for its own account.
  return (await resolveAccess())?.profile_id ?? null;
}

export async function GET(): Promise<NextResponse> {
  const profileId = await resolveProfile();
  if (!profileId) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  try {
    const care = await careState(profileId);
    const checks = await db
      .select({ at: watchActivity.at, detail: watchActivity.detail, meta: watchActivity.meta })
      .from(watchActivity)
      .where(and(eq(watchActivity.profile_id, profileId), eq(watchActivity.kind, "goal_progress")))
      .orderBy(desc(watchActivity.at));
    const goals = [];
    for (const goal of await listGoals(profileId)) {
      const { measure, baseline } = await readGoalMeasure(profileId, goal.goal_id);
      const latest = checks.find(
        (c) => (c.meta as { goal_id?: string } | null)?.goal_id === goal.goal_id,
      );
      const [review] = await db
        .select()
        .from(alertReviews)
        .where(and(eq(alertReviews.profile_id, profileId), eq(alertReviews.goal_id, goal.goal_id)))
        .orderBy(desc(alertReviews.created_at))
        .limit(1);
      goals.push({
        ...goal,
        measurable: measure !== null,
        measure,
        baseline,
        latest_check: latest
          ? { at: latest.at, detail: latest.detail, ...(latest.meta as object) }
          : null,
        review: review
          ? {
              id: review.id,
              at: review.created_at,
              outcome: review.outcome,
              review: review.review,
              with_a_person: review.escalated_at !== null && review.resolved_at === null,
              escalation_reason: review.escalation_reason,
            }
          : null,
      });
    }
    return NextResponse.json({ care, goals });
  } catch (error) {
    console.error(JSON.stringify({ event: "care_read_failed", ...logSafeError(error) }));
    return NextResponse.json({ error: "something went wrong on our side" }, { status: 500 });
  }
}
