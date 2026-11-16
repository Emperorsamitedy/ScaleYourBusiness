// POST /api/idea/testpage — gap 5 (TASKS-IDEAS): make the kept idea's test
// page, its lines set now (rule 41). Owners only; one page per idea.

import { type NextRequest, NextResponse } from "next/server";
import { resolveAccess } from "../../../../lib/auth/access";
import { requireRole } from "../../../../lib/auth/roles";
import { appOriginOf, isSameOriginPost } from "../../../../lib/auth/same-origin";
import { logSafeError } from "../../../../lib/core/log-safe";
import { IdeaError } from "../../../../lib/ideas/check";
import { createTestPage } from "../../../../lib/ideas/testpage";

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!isSameOriginPost(request.headers, appOriginOf(request.url))) {
    return NextResponse.json({ error: "use the form on our page" }, { status: 403 });
  }
  const access = await resolveAccess();
  if (!access?.session) return NextResponse.json({ error: "sign in first" }, { status: 401 });
  const denied = requireRole(access, "profile.edit");
  if (denied) return denied;
  let body: { pitch?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  try {
    const page = await createTestPage(access.profile_id, body.pitch);
    return NextResponse.json({ slug: page.slug });
  } catch (error) {
    if (error instanceof IdeaError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error(
      JSON.stringify({
        event: "idea_testpage_failed",
        account_id: access.account_id,
        ...logSafeError(error),
      }),
    );
    return NextResponse.json({ error: "something went wrong on our side" }, { status: 500 });
  }
}
