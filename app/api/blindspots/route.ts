// GET /api/blindspots — what potential customers look for that the
// business doesn't show them (Phase 2 Session G, P2-32..37). Read-only:
// fixing one goes through the approval queue like everything else.
//
// The owner's own site is (re)checked when it never was or the last check
// is older than 30 days — up to five pages of their own origin, GET only.

import { resolveAccess } from "../../../lib/auth/access";
import { NextResponse } from "next/server";
import type { SiteChecks } from "../../../lib/blindspots/checks";
import { SITE_CHECKS_KEY, runSiteChecks } from "../../../lib/blindspots/checks";
import { buildBlindspots } from "../../../lib/blindspots/finder";
import { readCurrentField } from "../../../lib/profile/field-store";

const RECHECK_DAYS = 30;

async function resolveProfile(): Promise<string | null> {
  // The one door (lib/auth/access): a signed cookie, and an owned business only for its own account.
  return (await resolveAccess())?.profile_id ?? null;
}

export async function GET(): Promise<NextResponse> {
  const profileId = await resolveProfile();
  if (!profileId) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  try {
    let siteNote: string | null = null;
    const last = (await readCurrentField<SiteChecks>(profileId, SITE_CHECKS_KEY))?.value;
    if (!last || Date.now() - Date.parse(last.checked_at) > RECHECK_DAYS * 86_400_000) {
      const checked = await runSiteChecks(profileId).catch((error: unknown) => ({
        reason: error instanceof Error ? error.message : String(error),
      }));
      if ("reason" in checked) siteNote = checked.reason;
    }
    const report = await buildBlindspots(profileId);
    return NextResponse.json({ ...report, site_note: siteNote });
  } catch (error) {
    console.error(JSON.stringify({ event: "blindspots_failed", message: String(error) }));
    return NextResponse.json({ error: "something went wrong on our side" }, { status: 500 });
  }
}
