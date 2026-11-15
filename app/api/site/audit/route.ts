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
import { requireRole } from "../../../../lib/auth/roles";
import type { AppLocale } from "../../../../lib/i18n/locales";
import { requestTr } from "../../../../lib/i18n/request-tr";
import type { Tr } from "../../../../lib/i18n/tr";
import type { SiteAuditView } from "../../../../lib/site/audit/view";
import { localizeSiteAudit } from "../../../../lib/site/localize";
import { SITE_WORDS, sayStored } from "../../../../lib/site/say";

/** Google loads up to ten pages in its own browser; give it time. */
export const maxDuration = 300;
export const dynamic = "force-dynamic";

/** L-4c: a stored audit in the reader's language; the row keeps its English. */
async function shown(audit: SiteAuditView | null, tr: Tr, locale: AppLocale) {
  return audit && localizeSiteAudit(audit, tr, locale);
}

export async function GET(): Promise<NextResponse> {
  const access = await resolveAccess();
  if (!access) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  const { tr, locale } = await requestTr(SITE_WORDS);
  return NextResponse.json({
    audit: await shown(await latestSiteAudit(access.profile_id), tr, locale),
  });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!isSameOriginPost(request.headers, appOriginOf(request.url))) {
    return NextResponse.json({ error: "this has to come from ScaleX's own page" }, { status: 403 });
  }
  const access = await resolveAccess();
  if (!access) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  const { tr, locale } = await requestTr(SITE_WORDS);
  if (!access.session) {
    return NextResponse.json({ error: tr("error.auditSignedIn") }, { status: 401 });
  }
  const denied = requireRole(access, "site.audit");
  if (denied) return denied;
  try {
    const outcome = await runSiteAudit({ profileId: access.profile_id });
    if (outcome.status === "read") {
      return NextResponse.json({ audit: await shown(outcome.audit, tr, locale) });
    }
    return NextResponse.json(
      {
        error: sayStored(outcome.why, tr, locale),
        audit: await shown(await latestSiteAudit(access.profile_id), tr, locale),
      },
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
