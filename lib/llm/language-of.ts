// Whose language a model call writes in, read from the database — L-5.
// The instructions themselves are pure, in ./language.ts.

import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "../../db";
import { users } from "../../db/schema";
import type { AppLocale } from "../i18n/locales";
import { DEFAULT_LOCALE, isAppLocale, resolveLanguage } from "../i18n/locales";
import { isLanguageReviewer } from "../i18n/review";

export { businessLanguage } from "./business-language";

/**
 * The person's language for work no one is waiting on (a weekly check, a
 * goal review): the business's first owner's own choice, re-checked
 * against the gate (rule 6) as every request is. English when they never
 * chose, or the language is in review and they aren't a named reviewer.
 */
export async function ownerLanguage(accountId: string): Promise<AppLocale> {
  const [owner] = await db
    .select({ language: users.language, email: users.email, account_id: users.account_id })
    .from(users)
    .where(and(eq(users.account_id, accountId), eq(users.role, "owner"), isNull(users.removed_at)))
    .orderBy(asc(users.created_at))
    .limit(1);
  if (!owner || !isAppLocale(owner.language)) return DEFAULT_LOCALE;
  return resolveLanguage(owner.language, isLanguageReviewer(owner));
}
