// /site — website changes, preview-first (Session F).
//
// The audit tab reads the owner's last recorded site check (the
// presence.site_checks fact, written by the blindspots check) — read
// only, on the server; this page never fetches the site itself.

import type { Metadata } from "next";
import { resolveAccess } from "../../lib/auth/access";
import { SITE_CHECKS_KEY, type SiteChecks, checkLabel } from "../../lib/blindspots/checks";
import { readCurrentField } from "../../lib/profile/field-store";
import { type SiteAudit, SiteScreen } from "../../components/site/SiteScreen";

export const metadata: Metadata = { title: "Your site — Ledgerline" };
export const dynamic = "force-dynamic";

async function lastAudit(): Promise<SiteAudit | null> {
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
        label: checkLabel(code),
        found_on: foundOn,
      })),
      unreadable: checks.unreadable ?? [],
    };
  } catch {
    // The audit tab is a courtesy; the screen works without it.
    return null;
  }
}

export default async function SitePage() {
  return <SiteScreen audit={await lastAudit()} />;
}
