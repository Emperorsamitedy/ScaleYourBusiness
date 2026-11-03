// /site — website changes, preview-first (Session F).
//
// The audit tab reads the owner's last recorded site check (the
// presence.site_checks fact, written by the blindspots check) — read
// only, on the server; this page never fetches the site itself.
// P5-13: the measured tab reads the latest stored site audit
// (lib/site/audit); running a new one is POST /api/site/audit.
// L-4c: the checks' labels, the audit's sentences and the reasons are said
// in the reader's language here, at presentation (lib/site/localize.ts);
// the stored rows stay as written.

import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { resolveAccess } from "../../lib/auth/access";
import { SITE_CHECKS_KEY, type SiteChecks } from "../../lib/blindspots/checks";
import type { AppLocale } from "../../lib/i18n/locales";
import { requestTr } from "../../lib/i18n/request-tr";
import type { Tr } from "../../lib/i18n/tr";
import { readCurrentField } from "../../lib/profile/field-store";
import { lastSiteAuditFailure, latestSiteAudit } from "../../lib/site/audit/service";
import { checkWords, localizeFailure, localizeSiteAudit } from "../../lib/site/localize";
import { SITE_WORDS, sayStored } from "../../lib/site/say";
import { type MeasuredAudit, type SiteAudit, SiteScreen } from "../../components/site/SiteScreen";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("site.meta");
  return { title: t("title") };
}
export const dynamic = "force-dynamic";

async function lastAudit(tr: Tr, locale: AppLocale): Promise<SiteAudit | null> {
  try {
    const access = await resolveAccess();
    if (!access) return null;
    const field = await readCurrentField<SiteChecks>(access.profile_id, SITE_CHECKS_KEY);
    const checks = field?.value;
    if (!checks || typeof checks !== "object" || !checks.results) return null;
    return {
      checked_at: checks.checked_at,
      pages: checks.pages,
      notes: Object.entries(checks.results).map(([code, foundOn]) => ({
        code,
        label: checkWords(code, tr, locale),
        found_on: foundOn,
      })),
      unreadable: (checks.unreadable ?? []).map((u) => ({
        ...u,
        reason: sayStored(u.reason, tr, locale),
      })),
    };
  } catch {
    // The audit tab is a courtesy; the screen works without it.
    return null;
  }
}

async function measuredAudit(tr: Tr, locale: AppLocale): Promise<MeasuredAudit> {
  try {
    const access = await resolveAccess();
    if (!access) return { audit: null, failure: null };
    const [audit, failure] = await Promise.all([
      latestSiteAudit(access.profile_id),
      lastSiteAuditFailure(access.profile_id),
    ]);
    return {
      audit: audit && localizeSiteAudit(audit, tr, locale),
      failure: localizeFailure(failure, tr, locale),
    };
  } catch {
    // Like the checks tab: a courtesy, never a reason for the screen to fail.
    return { audit: null, failure: null };
  }
}

export default async function SitePage() {
  const { tr, locale } = await requestTr(SITE_WORDS);
  const [audit, measured] = await Promise.all([lastAudit(tr, locale), measuredAudit(tr, locale)]);
  return <SiteScreen audit={audit} measured={measured} />;
}
