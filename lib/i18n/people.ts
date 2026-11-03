// Whose language a message is written in, read from the database — L-6 of
// TASKS-LANGUAGES.md. The rules are pure, in ./recipient; this file only
// reads the rows they need. Reads only.

import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { db } from "../../db";
import { businessProfiles, users } from "../../db/schema";
import type { AppLocale } from "./locales";
import { DEFAULT_LOCALE, resolveLanguage } from "./locales";
import { customerLocale, personLocale } from "./recipient";
import { isLanguageReviewer } from "./review";

/** Lower case and trimmed, as sign-in stores an address. */
const normalise = (raw: string) => raw.trim().toLowerCase();

/** One person (a users row), in their own language through the gate. */
export async function userLocale(userId: string): Promise<AppLocale> {
  const [row] = await db
    .select({ language: users.language, email: users.email, account_id: users.account_id })
    .from(users)
    .where(eq(users.id, userId));
  return row ? personLocale(row.language, row) : DEFAULT_LOCALE;
}

/**
 * The language of a message to an address — a sign-in link, an invite.
 * The person's own language when any of their accounts holds one (the
 * newest), else `fallback`: the language the sign-in link carries
 * (login_tokens.language) or the one the inviter is using. Open to them
 * only if they are a named reviewer by address, or through any account
 * they belong to, or through `accountId` (the business inviting them).
 */
export async function addressLocale(
  rawEmail: string,
  fallback: string | null | undefined,
  accountId: string | null = null,
): Promise<AppLocale> {
  const email = normalise(rawEmail);
  const rows = await db
    .select({ language: users.language, account_id: users.account_id })
    .from(users)
    .where(and(eq(users.email, email), isNull(users.removed_at)))
    .orderBy(desc(users.created_at));
  const own = rows.find((r) => r.language !== null)?.language ?? null;
  const accounts = [...rows.map((r) => r.account_id), ...(accountId ? [accountId] : [])];
  const reviewer =
    isLanguageReviewer({ account_id: "", email }) ||
    accounts.some((account_id) => isLanguageReviewer({ account_id, email }));
  return resolveLanguage(own ?? fallback, reviewer);
}

/** The account's owner: their address and language, or null for an account with no owner. */
export async function ownerOf(
  accountId: string,
): Promise<{ email: string; language: string | null } | null> {
  const [row] = await db
    .select({ email: users.email, language: users.language })
    .from(users)
    .where(and(eq(users.account_id, accountId), eq(users.role, "owner"), isNull(users.removed_at)))
    .orderBy(asc(users.created_at))
    .limit(1);
  return row ?? null;
}

/** The language the business's customers read (business_profiles.language, through the gate). */
export async function businessCustomerLocale(profileId: string): Promise<AppLocale> {
  const [row] = await db
    .select({ language: businessProfiles.language, account_id: businessProfiles.account_id })
    .from(businessProfiles)
    .where(eq(businessProfiles.id, profileId));
  if (!row) return DEFAULT_LOCALE;
  const owner = await ownerOf(row.account_id);
  return customerLocale(row.language, {
    account_id: row.account_id,
    owner_email: owner?.email ?? null,
  });
}
