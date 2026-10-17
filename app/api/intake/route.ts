// Intake API — Session N. One resource, cookie-scoped session, no auth
// beyond what the intake needs (CLAUDE.md scope rule).
//
//   POST /api/intake            start (or resume) a session
//   GET  /api/intake            current state
//   PUT  /api/intake            submit an answer  { question_id, action }
//   PATCH /api/intake           interim entity count { question_id, count }

import { logSafeError } from "../../../lib/core/log-safe";
import {
  INTAKE_COOKIE,
  intakeCookieOptions,
  resolveAccess,
  signProfileCookie,
} from "../../../lib/auth/access";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  bootstrapIntake,
  getIntakeState,
  IntakeError,
  submitAnswer,
  submitEntities,
  submitEntityCount,
} from "../../../lib/intake/service";
import type { AnswerAction } from "../../../lib/intake/types";

async function resolveSession(): Promise<{ account_id: string; profile_id: string } | null> {
  // The one door (lib/auth/access): a signed cookie, and an owned business only for its own account.
  const access = await resolveAccess();
  return access ? { profile_id: access.profile_id, account_id: access.account_id } : null;
}

function errorResponse(error: unknown): NextResponse {
  if (error instanceof IntakeError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  console.error(JSON.stringify({ event: "intake_error", ...logSafeError(error) }));
  return NextResponse.json({ error: "something went wrong on our side" }, { status: 500 });
}

export async function POST(): Promise<NextResponse> {
  try {
    let session = await resolveSession();
    session ??= await bootstrapIntake();
    const state = await getIntakeState(session.account_id, session.profile_id);
    const response = NextResponse.json(state);
    response.cookies.set(
      INTAKE_COOKIE,
      signProfileCookie(session.profile_id),
      intakeCookieOptions(),
    );
    return response;
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * Leave the current intake, so the next POST starts a fresh profile.
 *
 * POST resumes whatever the cookie points at and there was no way out:
 * an owner with a second business, or one who wanted to abandon a
 * half-finished intake and begin again, was pinned to their first
 * profile forever. The cookie is httpOnly, so they could not clear it
 * themselves either.
 *
 * This ends the session only. The profile and every fact in it stay
 * exactly where they are — facts are superseded, never destroyed, and a
 * stale cookie is no reason to break that. Recovering an abandoned
 * profile is what the resume link is for.
 */
export async function DELETE(): Promise<NextResponse> {
  const response = NextResponse.json({ ended: true });
  response.cookies.set(INTAKE_COOKIE, "", intakeCookieOptions(0));
  return response;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const session = await resolveSession();
    if (!session) return NextResponse.json({ error: "no intake session" }, { status: 404 });
    // ?ask=<question_id> — a gap on the fact sheet links straight to its
    // question. getIntakeState already honours a preferred id; unknown or
    // inapplicable ids simply fall back to normal selection.
    const ask = request.nextUrl.searchParams.get("ask") ?? undefined;
    return NextResponse.json(await getIntakeState(session.account_id, session.profile_id, ask));
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
    const body = (await request.json()) as {
      question_id?: string;
      count?: number;
      rows?: Record<string, unknown>[];
    };
    if (!body.question_id) {
      return NextResponse.json({ error: "question_id required" }, { status: 400 });
    }
    if (Array.isArray(body.rows)) {
      return NextResponse.json(
        await submitEntities(session.account_id, session.profile_id, body.question_id, body.rows),
      );
    }
    if (typeof body.count !== "number") {
      return NextResponse.json({ error: "rows or count required" }, { status: 400 });
    }
    return NextResponse.json(
      await submitEntityCount(session.account_id, session.profile_id, body.question_id, body.count),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
