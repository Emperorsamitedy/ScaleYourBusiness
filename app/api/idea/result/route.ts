// POST /api/idea/result — TASKS-IDEAS I-32: record what the idea's test
// showed. Read against the lines kept with the test (rule 41); append-only.

import { type NextRequest, NextResponse } from "next/server";
import { resolveAccess } from "../../../../lib/auth/access";
import { requireRole } from "../../../../lib/auth/roles";
import { appOriginOf, isSameOriginPost } from "../../../../lib/auth/same-origin";
import { logSafeError } from "../../../../lib/core/log-safe";
import { IdeaError } from "../../../../lib/ideas/check";
import { recordTestResult } from "../../../../lib/ideas/keep";

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!isSameOriginPost(request.headers, appOriginOf(request.url))) {
    return NextResponse.json({ error: "use the form on our page" }, { status: 403 });
  }
  const access = await resolveAccess();
  if (!access?.session) return NextResponse.json({ error: "sign in first" }, { status: 401 });
  const denied = requireRole(access, "profile.edit");
  if (denied) return denied;
  let body: { observed?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  if (typeof body.observed !== "number") {
    return NextResponse.json({ error: "a result is a whole number from zero" }, { status: 422 });
  }
  try {
    const reading = await recordTestResult({
      profileId: access.profile_id,
      userId: access.session.user_id,
      observed: body.observed,
    });
    return NextResponse.json({ reading });
  } catch (error) {
    if (error instanceof IdeaError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error(
      JSON.stringify({
        event: "idea_result_failed",
        account_id: access.account_id,
        ...logSafeError(error),
      }),
    );
    return NextResponse.json({ error: "something went wrong on our side" }, { status: 500 });
  }
}
