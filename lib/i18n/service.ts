// Storing the language and currency choices — L-1 (TASKS-LANGUAGES.md).
//
// None of these is a fact about the business (rule 2's Field<T>): they say
// how SYB speaks and which currency it labels figures in. Changing the
// currency converts nothing (rule 1): every money value already recorded
// carries its own currency and keeps it, and the economics layer still
// refuses to add one currency to another.

import { and, eq, isNull } from "drizzle-orm";
import { db } from "../../db";
import { accounts, businessProfiles, users } from "../../db/schema";
import { isIsoCurrency } from "../core/currencies";
import type { AppLocale } from "./locales";
import { isAppLocale } from "./locales";

export class LocaleError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "LocaleError";
  }
}

/** The person's own language, on their users row. */
export async function setOwnLanguage(userId: string, language: AppLocale): Promise<void> {
  await db.update(users).set({ language }).where(eq(users.id, userId));
}

/**
 * At sign-in: a person who never chose takes the browser's choice; one who
 * did keeps theirs. Returns the language the person now has (null = none).
 */
export async function adoptLanguage(
  userId: string,
  browserChoice: string | null | undefined,
): Promise<AppLocale | null> {
  if (isAppLocale(browserChoice)) {
    await db
      .update(users)
      .set({ language: browserChoice })
      .where(and(eq(users.id, userId), isNull(users.language)));
  }
  const [row] = await db
    .select({ language: users.language })
    .from(users)
    .where(eq(users.id, userId));
  return isAppLocale(row?.language) ? row.language : null;
}

export interface BusinessLocale {
  language: AppLocale;
  currency: string;
  /** True once the owner chose the currency (it is no longer the default). */
  currency_chosen: boolean;
}

export async function businessLocale(profileId: string): Promise<BusinessLocale | null> {
  const [row] = await db
    .select({
      language: businessProfiles.language,
      currency: accounts.reporting_currency,
      chosen_at: accounts.reporting_currency_chosen_at,
    })
    .from(businessProfiles)
    .innerJoin(accounts, eq(accounts.id, businessProfiles.account_id))
    .where(eq(businessProfiles.id, profileId));
  if (!row) return null;
  return {
    language: isAppLocale(row.language) ? row.language : "en",
    currency: row.currency,
    currency_chosen: row.chosen_at !== null,
  };
}

/**
 * The business's language and/or currency. The caller has checked the role
 * (business.locale) and the language gate; this checks the values again.
 */
export async function setBusinessLocale(
  access: { account_id: string; profile_id: string },
  change: { language?: AppLocale | undefined; currency?: string | undefined },
): Promise<BusinessLocale> {
  if (change.language !== undefined && !isAppLocale(change.language)) {
    throw new LocaleError("that language isn't one SYB speaks", 422);
  }
  if (change.currency !== undefined && !isIsoCurrency(change.currency)) {
    throw new LocaleError("that isn't an ISO 4217 currency code", 422);
  }
  await db.transaction(async (tx) => {
    if (change.language !== undefined) {
      await tx
        .update(businessProfiles)
        .set({ language: change.language })
        .where(
          and(
            eq(businessProfiles.id, access.profile_id),
            eq(businessProfiles.account_id, access.account_id),
          ),
        );
    }
    if (change.currency !== undefined) {
      await tx
        .update(accounts)
        .set({
          reporting_currency: change.currency,
          reporting_currency_chosen_at: new Date().toISOString(),
        })
        .where(eq(accounts.id, access.account_id));
    }
  });
  const now = await businessLocale(access.profile_id);
  if (!now) throw new LocaleError("that business is no longer here", 404);
  return now;
}
