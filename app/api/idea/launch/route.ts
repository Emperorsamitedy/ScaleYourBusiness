// POST /api/idea/launch — TASKS-IDEAS I-50: the idea is trading. The
// profile becomes an operating business, one way; the stated plan stays as
// it was, to be set beside what gets measured (I-51). Owners only.

import { type NextRequest, NextResponse } from "next/server";
import { resolveAccess } from "../../../../lib/auth/access";
import { requireRole } from "../../../../lib/auth/roles";
import { appOriginOf, isSameOriginPost } from "../../../../lib/auth/same-origin";
import { logSafeError } from "../../../../lib/core/log-safe";
import { IdeaError } from "../../../../lib/ideas/check";
import { launchIdea } from "../../../../lib/ideas/keep";

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!isSameOriginPost(request.headers, appOriginOf(request.url))) {
    return NextResponse.json({ error: "use the form on our page" }, { status: 403 });
  }
  const access = await resolveAccess();
  if (!access?.session) return NextResponse.json({ error: "sign in first" }, { status: 401 });
  const denied = requireRole(access, "profile.edit");
  if (denied) return denied;
  try {
    const out = await launchIdea({ profileId: access.profile_id, userId: access.session.user_id });
    console.log(
      JSON.stringify({
        event: "idea_launched",
        account_id: access.account_id,
        connector: out.connector,
      }),
    );
    return NextResponse.json(out);
  } catch (error) {
    if (error instanceof IdeaError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error(
      JSON.stringify({
        event: "idea_launch_failed",
        account_id: access.account_id,
        ...logSafeError(error),
      }),
    );
    return NextResponse.json({ error: "something went wrong on our side" }, { status: 500 });
  }
}
