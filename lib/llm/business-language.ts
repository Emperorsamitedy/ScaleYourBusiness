// The business's own language for its customers — L-5, rule 5's
// customer-facing half. Its own file, reading the one column directly, so
// the support tier (rule 21's module gate, lib/support/structure.test.ts)
// reaches nothing beyond the database and the pure list of languages.

import { eq } from "drizzle-orm";
import { db } from "../../db";
import { businessProfiles } from "../../db/schema";
import type { AppLocale } from "../i18n/locales";
import { DEFAULT_LOCALE, isAppLocale } from "../i18n/locales";

/** The business's setting (business_profiles.language), not gated: it is for its customers. */
export async function businessLanguage(profileId: string): Promise<AppLocale> {
  const [row] = await db
    .select({ language: businessProfiles.language })
    .from(businessProfiles)
    .where(eq(businessProfiles.id, profileId));
  return isAppLocale(row?.language) ? row.language : DEFAULT_LOCALE;
}
