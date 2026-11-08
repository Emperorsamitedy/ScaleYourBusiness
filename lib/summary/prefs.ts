// The weekly summary's switch, read and written — idea 42. The rules and
// the stop token are pure, in ./switch; this is the database side: the
// owner row, the preference write, and the stop link's page and POST.

import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { db } from "../../db";
import { users } from "../../db/schema";
import type { SummaryChannel } from "./switch";
import { SUMMARY_CHANNEL_KEY, SUMMARY_PREF_KEY, summaryPref, verifyStopToken } from "./switch";

export {
  STOP_TOKEN_RE,
  isSummaryChannel,
  stopToken,
  summaryChannel,
  summaryOn,
  summaryPref,
  verifyStopToken,
  wantsEmail,
  wantsWhatsApp,
} from "./switch";
export type { SummaryChannel } from "./switch";

/** The account's owner: who the summary goes to and whose switch it is. */
export async function accountOwner(
  accountId: string,
): Promise<{ id: string; email: string; prefs: unknown; language: string | null } | null> {
  const [row] = await db
    .select({
      id: users.id,
      email: users.email,
      prefs: users.notification_prefs,
      language: users.language,
    })
    .from(users)
    .where(and(eq(users.account_id, accountId), eq(users.role, "owner"), isNull(users.removed_at)))
    .orderBy(asc(users.created_at))
    .limit(1);
  return row ?? null;
}

/** Set the switch, keeping every other preference. Returns the account, or null for no such user. */
export async function setSummaryPref(userId: string, enabled: boolean): Promise<string | null> {
  const rows = await db
    .update(users)
    .set({
      notification_prefs: sql`${users.notification_prefs} || jsonb_build_object(${SUMMARY_PREF_KEY}::text, ${enabled}::boolean)`,
    })
    .where(eq(users.id, userId))
    .returning({ account_id: users.account_id });
  return rows[0]?.account_id ?? null;
}

/** The page's read: null = not a link SYB minted. Writes nothing. */
export async function viewStop(token: string): Promise<{ stopped: boolean } | null> {
  const userId = verifyStopToken(token);
  if (!userId) return null;
  const [row] = await db
    .select({ prefs: users.notification_prefs })
    .from(users)
    .where(eq(users.id, userId));
  if (!row) return null;
  return { stopped: summaryPref(row.prefs) === false };
}

/** The POST: switch it off, now. Idempotent. Null = not a link SYB minted. */
export async function stopSummaries(token: string): Promise<{ stopped: true } | null> {
  const userId = verifyStopToken(token);
  if (!userId) return null;
  const accountId = await setSummaryPref(userId, false);
  if (!accountId) return null;
  // Ids only — never the address.
  console.log(
    JSON.stringify({
      event: "weekly_summary_switched",
      account_id: accountId,
      on: false,
      via: "link",
    }),
  );
  return { stopped: true };
}

/** P6-07: set the channel — email, WhatsApp or both — keeping every other preference. */
export async function setSummaryChannel(
  userId: string,
  channel: SummaryChannel,
): Promise<string | null> {
  const rows = await db
    .update(users)
    .set({
      notification_prefs: sql`${users.notification_prefs} || jsonb_build_object(${SUMMARY_CHANNEL_KEY}::text, ${channel}::text)`,
    })
    .where(eq(users.id, userId))
    .returning({ account_id: users.account_id });
  return rows[0]?.account_id ?? null;
}
