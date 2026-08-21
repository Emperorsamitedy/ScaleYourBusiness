// Intake API — Session N. One resource, cookie-scoped session, no auth
// beyond what the intake needs (CLAUDE.md scope rule).
//
//   POST /api/intake            start (or resume) a session
//   GET  /api/intake            current state
//   PUT  /api/intake            submit an answer  { question_id, action }
//   PATCH /api/intake           interim entity count { question_id, count }

import { eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { db } from "../../../db";
import { businessProfiles } from "../../../db/schema";
import {
  bootstrapIntake,
  getIntakeState,
  IntakeError,
  submitAnswer,
  submitEntityCount,
} from "../../../lib/intake/service";
import type { AnswerAction } from "../../../lib/intake/types";

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

function errorResponse(error: unknown): NextResponse {
  if (error instanceof IntakeError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  console.error(JSON.stringify({ event: "intake_error", message: String(error) }));
  return NextResponse.json({ error: "something went wrong on our side" }, { status: 500 });
}

export async function POST(): Promise<NextResponse> {
  try {
    let session = await resolveSession();
    session ??= await bootstrapIntake();
    const state = await getIntakeState(session.account_id, session.profile_id);
    const response = NextResponse.json(state);
    response.cookies.set(COOKIE, session.profile_id, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
    });
    return response;
  } catch (error) {
    return errorResponse(error);
  }
}

export async function GET(): Promise<NextResponse> {
  try {
    const session = await resolveSession();
    if (!session) return NextResponse.json({ error: "no intake session" }, { status: 404 });
    return NextResponse.json(await getIntakeState(session.account_id, session.profile_id));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PUT(request: NextRequest): Promise<NextResponse> {
  try {
    const session = await resolveSession();
    if (!session) return NextResponse.json({ error: "no intake session" }, { status: 404 });
    const body = (await request.json()) as { question_id?: string; action?: AnswerAction };
    if (!body.question_id || !body.action) {
      return NextResponse.json({ error: "question_id and action required" }, { status: 400 });
    }
    return NextResponse.json(
      await submitAnswer(session.account_id, session.profile_id, body.question_id, body.action),
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: NextRequest): Promise<NextResponse> {
  try {
    const session = await resolveSession();
    if (!session) return NextResponse.json({ error: "no intake session" }, { status: 404 });
    const body = (await request.json()) as { question_id?: string; count?: number };
    if (!body.question_id || typeof body.count !== "number") {
      return NextResponse.json({ error: "question_id and count required" }, { status: 400 });
    }
    return NextResponse.json(
      await submitEntityCount(session.account_id, session.profile_id, body.question_id, body.count),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
