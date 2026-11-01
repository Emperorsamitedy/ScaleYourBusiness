// Intake API — Session N. One resource, cookie-scoped session, no auth
// beyond what the intake needs (CLAUDE.md scope rule).
//
//   POST /api/intake            start (or resume) a session
//   GET  /api/intake            current state
//   PUT  /api/intake            submit an answer  { question_id, action }
//   PATCH /api/intake           entity rows { question_id, rows } (or interim { count })
//
// GET ?section=, and `section` in a PUT/PATCH body, name an area the owner
// chose on the tile row: the next question comes from that area while it
// has one, then normal order resumes. An unknown section is ignored.

import { logSafeError } from "../../../lib/core/log-safe";
import type { Access } from "../../../lib/auth/access";
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
  parseSection,
  submitAnswer,
  submitEntities,
  submitEntityCount,
} from "../../../lib/intake/service";
import type { AnswerAction } from "../../../lib/intake/types";
import { requireRole } from "../../../lib/auth/roles";
import { pendingChoices } from "../../../lib/i18n/server";

async function resolveSession(): Promise<Access | null> {
  // The one door (lib/auth/access): a signed cookie, and an owned business only for its own account.
  // The whole access, so answering can check the role (idea 52).
  return resolveAccess();
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
    const access = await resolveSession();
    // Resuming reads the interview; with no access at all this is a new
    // visitor's first step (the intake before any account), which has no role.
    if (access) {
      const denied = requireRole(access, "intake.open");
      if (denied) return denied;
    }
    // L-1: a new intake starts in the language and currency of the first step.
    const session = access ?? (await bootstrapIntake(await pendingChoices()));
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
    const section = parseSection(request.nextUrl.searchParams.get("section"));
    return NextResponse.json(
      await getIntakeState(session.account_id, session.profile_id, ask, section),
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PUT(request: NextRequest): Promise<NextResponse> {
  try {
    const session = await resolveSession();
    if (!session) return NextResponse.json({ error: "no intake session" }, { status: 404 });
    const denied = requireRole(session, "profile.edit");
    if (denied) return denied;
    const body = (await request.json()) as {
      question_id?: string;
      action?: AnswerAction;
      section?: unknown;
    };
    if (!body.question_id || !body.action) {
      return NextResponse.json({ error: "question_id and action required" }, { status: 400 });
    }
    return NextResponse.json(
      await submitAnswer(
        session.account_id,
        session.profile_id,
        body.question_id,
        body.action,
        parseSection(body.section),
      ),
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: NextRequest): Promise<NextResponse> {
  try {
    const session = await resolveSession();
    if (!session) return NextResponse.json({ error: "no intake session" }, { status: 404 });
    const denied = requireRole(session, "profile.edit");
    if (denied) return denied;
    const body = (await request.json()) as {
      question_id?: string;
      count?: number;
      rows?: Record<string, unknown>[];
      section?: unknown;
    };
    if (!body.question_id) {
      return NextResponse.json({ error: "question_id required" }, { status: 400 });
    }
    if (Array.isArray(body.rows)) {
      return NextResponse.json(
        await submitEntities(
          session.account_id,
          session.profile_id,
          body.question_id,
          body.rows,
          parseSection(body.section),
        ),
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
