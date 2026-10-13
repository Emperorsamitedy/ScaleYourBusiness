// The goals API — Phase 3 Session C (P3-14).
//
//   GET  /api/goals   the owner's goals + suggestions from the report
//   POST /api/goals   add a goal (the owner's words, owner_input source)
//   PUT  /api/goals   refine one — every change supersedes, never overwrites;
//                     `measure` makes it measurable (P3-42)

import { eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { type NextRequest, NextResponse } from "next/server";
import { db } from "../../../db";
import { businessProfiles } from "../../../db/schema";
import { GoalMeasureError, readGoalMeasure, setGoalMeasure } from "../../../lib/care/goal-measure";
import {
  GoalError,
  addGoal,
  listGoals,
  suggestGoalsFromReport,
  updateGoal,
} from "../../../lib/content/goals";

const COOKIE = "syb_intake_profile";

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
  if (error instanceof GoalError || error instanceof GoalMeasureError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  console.error(JSON.stringify({ event: "goals_error", message: String(error) }));
  return NextResponse.json({ error: "something went wrong on our side" }, { status: 500 });
}

export async function GET(): Promise<NextResponse> {
  const profileId = await resolveProfile();
  if (!profileId) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  try {
    const [listed, suggestions] = await Promise.all([
      listGoals(profileId),
      suggestGoalsFromReport(profileId),
    ]);
    const goals = await Promise.all(
      listed.map(async (g) => ({ ...g, ...(await readGoalMeasure(profileId, g.goal_id)) })),
    );
    return NextResponse.json({ goals, suggestions });
  } catch (error) {
    return onError(error);
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const profileId = await resolveProfile();
  if (!profileId) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  try {
    const body = (await request.json()) as {
      statement?: unknown;
      horizon?: unknown;
      area?: unknown;
      target_value?: unknown;
    };
    if (typeof body.statement !== "string") {
      return NextResponse.json({ error: "statement is required" }, { status: 422 });
    }
    const goal = await addGoal(profileId, {
      statement: body.statement,
      horizon: typeof body.horizon === "string" ? body.horizon : null,
      area: typeof body.area === "string" ? body.area : null,
      target_value: typeof body.target_value === "string" ? body.target_value : null,
    });
    return NextResponse.json(goal, { status: 201 });
  } catch (error) {
    return onError(error);
  }
}

export async function PUT(request: NextRequest): Promise<NextResponse> {
  const profileId = await resolveProfile();
  if (!profileId) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  try {
    const body = (await request.json()) as { goal_id?: unknown } & Record<string, unknown>;
    if (typeof body.goal_id !== "string") {
      return NextResponse.json({ error: "goal_id is required" }, { status: 422 });
    }
    const patch: Record<string, string> = {};
    for (const key of ["statement", "horizon", "area", "target_value"] as const) {
      if (typeof body[key] === "string") patch[key] = body[key] as string;
    }
    const goal = await updateGoal(profileId, body.goal_id, patch);
    const measure = body.measure as Record<string, unknown> | undefined;
    if (measure && typeof measure === "object") {
      const set = await setGoalMeasure(profileId, body.goal_id, {
        metric: String(measure.metric ?? ""),
        direction: typeof measure.direction === "string" ? measure.direction : null,
        target_per_30d: Number(measure.target_per_30d),
        currency: typeof measure.currency === "string" ? measure.currency : null,
        deadline: typeof measure.deadline === "string" ? measure.deadline : null,
      });
      return NextResponse.json({ ...goal, ...set });
    }
    return NextResponse.json(goal);
  } catch (error) {
    return onError(error);
  }
}
