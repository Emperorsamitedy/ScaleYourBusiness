// Warnings sent at once: the email's switch, written. The rule is pure, in
// ./switch; the owner row is read by lib/summary/prefs accountOwner (the same
// owner the weekly summary goes to). This sets the one key, keeping every
// other preference.

import { eq, sql } from "drizzle-orm";
import { db } from "../../db";
import { users } from "../../db/schema";
import { WARNING_PREF_KEY } from "./switch";

/** Set the switch. Returns the account, or null for no such user. */
export async function setWarningPref(userId: string, enabled: boolean): Promise<string | null> {
  const rows = await db
    .update(users)
    .set({
      notification_prefs: sql`${users.notification_prefs} || jsonb_build_object(${WARNING_PREF_KEY}::text, ${enabled}::boolean)`,
    })
    .where(eq(users.id, userId))
    .returning({ account_id: users.account_id });
  return rows[0]?.account_id ?? null;
}
