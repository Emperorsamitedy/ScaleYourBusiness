// The weekly summary's on/off switch and its one-click stop — idea 42.
//
// The switch is the owner's own users.notification_prefs (data-model §4's
// NotificationPrefs, typed here now that a notification exists):
//   weekly_summary: true | false | absent.
// Absent means the default: ON once the business has a mode decision
// (watching, or acting right away) — before that there is no week of work
// to report. An explicit false is the owner's word and always wins; an
// explicit true still sends nothing until there is a mode decision.
//
// The stop link is a signed token, `<user id>.<HMAC>`, keyed by a purpose
// label over CONNECTOR_KEY (lib/core/derived-key's stableKey), so a link
// in an old email keeps working for ever, the way unsubscribe links do.
// It is NOT lib/unsubscribe's token: that one is minted per customer send
// and fenced to the suppression list; the owner is not a contact. The
// token is the whole credential — no cookie is read — and it can do one
// thing only: switch this owner's summary off.

import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../../db";
import { users } from "../../db/schema";
import { stableKey } from "../core/derived-key";

export const SUMMARY_PREF_KEY = "weekly_summary";

/** What the owner said, if anything: true, false, or null for "never said". */
export function summaryPref(prefs: unknown): boolean | null {
  if (prefs === null || typeof prefs !== "object") return null;
  const value = (prefs as Record<string, unknown>)[SUMMARY_PREF_KEY];
  return typeof value === "boolean" ? value : null;
}

/** Whether this week's email goes out: in care, and not switched off. */
export function summaryOn(pref: boolean | null, hasModeDecision: boolean): boolean {
  return hasModeDecision && pref !== false;
}

/** The account's owner: who the summary goes to and whose switch it is. */
export async function accountOwner(
  accountId: string,
): Promise<{ id: string; email: string; prefs: unknown } | null> {
  const [row] = await db
    .select({ id: users.id, email: users.email, prefs: users.notification_prefs })
    .from(users)
    .where(and(eq(users.account_id, accountId), eq(users.role, "owner")))
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

/* ---------- the stop link ---------- */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** `<uuid>.<43 base64url chars>`. Checked before anything else. */
export const STOP_TOKEN_RE = /^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/i;

const stopMac = (userId: string) =>
  createHmac("sha256", stableKey("syb-weekly-summary-stop-v1"))
    .update(`weekly-summary-stop:${userId.toLowerCase()}`)
    .digest("base64url");

export function stopToken(userId: string): string {
  return `${userId.toLowerCase()}.${stopMac(userId)}`;
}

/** The user a stop token was minted for, or null for anything SYB didn't sign. */
export function verifyStopToken(token: string): string | null {
  if (!STOP_TOKEN_RE.test(token)) return null;
  const dot = token.indexOf(".");
  const userId = token.slice(0, dot);
  if (!UUID_RE.test(userId)) return null;
  const want = Buffer.from(stopMac(userId));
  const got = Buffer.from(token.slice(dot + 1));
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  return userId.toLowerCase();
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
