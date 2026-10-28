// The site audit — Phase 5 Session C (P5-11..13).
//
//   GET  /api/site/audit   the latest measured audit, or null
//   POST /api/site/audit   run one now: read the site like a visitor and ask
//                          PageSpeed Insights about its key pages
//
// Running one is the signed-in owner's (a session for this profile's
// account) and must come from SYB's own page (isSameOriginPost): it reads
// the owner's server and spends the site's weekly PageSpeed calls. The run
// itself reads only — rule 30 — and calls no model.

import { type NextRequest, NextResponse } from "next/server";
import { resolveAccess } from "../../../../lib/auth/access";
import { appOriginOf, isSameOriginPost } from "../../../../lib/auth/same-origin";
import { logSafeError } from "../../../../lib/core/log-safe";
import { latestSiteAudit, runSiteAudit } from "../../../../lib/site/audit/service";

/** Google loads up to ten pages in its own browser; give it time. */
export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const access = await resolveAccess();
  if (!access) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  return NextResponse.json({ audit: await latestSiteAudit(access.profile_id) });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!isSameOriginPost(request.headers, appOriginOf(request.url))) {
    return NextResponse.json({ error: "this has to come from SYB's own page" }, { status: 403 });
  }
  const access = await resolveAccess();
  if (!access) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  if (!access.session) {
    return NextResponse.json({ error: "auditing your site needs you signed in" }, { status: 401 });
  }
  try {
    const outcome = await runSiteAudit({ profileId: access.profile_id });
    if (outcome.status === "read") return NextResponse.json({ audit: outcome.audit });
    return NextResponse.json(
      { error: outcome.why, audit: await latestSiteAudit(access.profile_id) },
      { status: outcome.status === "refused" ? 409 : 422 },
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "site_audit_error",
        account_id: access.account_id,
        profile_id: access.profile_id,
        ...logSafeError(error),
      }),
    );
    return NextResponse.json({ error: "something went wrong on our side" }, { status: 500 });
  }
}
