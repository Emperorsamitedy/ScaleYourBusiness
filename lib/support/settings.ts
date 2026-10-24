// Support settings, the stranger-facing READ — Phase 4 Session B (P4-07).
//
// The widget identifies itself with a public site key. The key scopes a
// conversation to one business; it authenticates nothing, which is why
// it may sit in a <script> tag on a public page. This module reads the
// row and nothing else: creating or rotating a key is the owner's act
// and lives in lib/crm/support-settings.ts, on the trusted side of the
// line (rule 21 — lib/support imports no profile, proposal or execution
// path; the structural test holds it to that).

import { eq } from "drizzle-orm";
import { db } from "../../db";
import { supportSettings } from "../../db/schema";

export type SupportSettingsRow = typeof supportSettings.$inferSelect;

/** What the assistant calls the business until the owner names it. Never shown as a title. */
export const DEFAULT_BUSINESS_NAME = "this business";

/** 16 random bytes as hex. Checked before any query so junk never reaches the database. */
export const SITE_KEY_RE = /^[0-9a-f]{32}$/;

/** The script tag an owner pastes into their site: public by design, as the site key is. */
export function widgetSnippet(origin: string, siteKey: string): string {
  return `<script src="${origin}/support-widget.js" data-site-key="${siteKey}" async></script>`;
}

export async function settingsBySiteKey(siteKey: string): Promise<SupportSettingsRow | null> {
  if (!SITE_KEY_RE.test(siteKey)) return null;
  const [row] = await db
    .select()
    .from(supportSettings)
    .where(eq(supportSettings.site_key, siteKey));
  return row ?? null;
}

export async function settingsForProfile(profileId: string): Promise<SupportSettingsRow | null> {
  const [row] = await db
    .select()
    .from(supportSettings)
    .where(eq(supportSettings.profile_id, profileId));
  return row ?? null;
}
