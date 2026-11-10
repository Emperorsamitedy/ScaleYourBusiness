// Phone answering's country flag — architecture-v2 hard rule 6, D6.
//
// PHONE_ANSWERING_COUNTRIES is a comma list of ISO alpha-2 codes. Empty —
// the default — blocks every country: AI phone answering (and the call
// recording beside it) is regulated country by country, so a country is
// switched on deliberately, never by omission. A business whose country
// can't be read is blocked too.
//
// This file sits inside the phone line's import fence
// (lib/support/structure.test.ts): the database, its schema and the pure
// country map only. ComplianceGate reads the same function, so the line and
// the gate can't disagree.

import { and, eq, isNull } from "drizzle-orm";
import { db } from "../../db";
import { fieldRecords } from "../../db/schema";
import { countryCode } from "../core/country";

export const PHONE_COUNTRIES_KEY = "PHONE_ANSWERING_COUNTRIES";

type EnvSource = Readonly<Record<string, string | undefined>>;

/** The ISO codes switched on. Anything that isn't two letters is ignored, never guessed. */
export function phoneAnsweringCountries(source: EnvSource = process.env): Set<string> {
  const raw = source[PHONE_COUNTRIES_KEY] ?? "";
  return new Set(
    raw
      .split(",")
      .map((c) => c.trim().toUpperCase())
      .filter((c) => /^[A-Z]{2}$/.test(c)),
  );
}

export function phoneAnsweringAllowed(
  countryIso: string | null,
  source: EnvSource = process.env,
): boolean {
  return countryIso !== null && phoneAnsweringCountries(source).has(countryIso.toUpperCase());
}

/** The business's country as an ISO code, from legal.country as the owner typed it. */
export async function businessCountryIso(profileId: string): Promise<string | null> {
  const [row] = await db
    .select({ value: fieldRecords.value })
    .from(fieldRecords)
    .where(
      and(
        eq(fieldRecords.profile_id, profileId),
        eq(fieldRecords.field_key, "legal.country"),
        isNull(fieldRecords.superseded_at),
      ),
    );
  return typeof row?.value === "string" ? countryCode(row.value) : null;
}

/** Whether this business's line may answer at all (hard rule 6). */
export async function phoneAllowedFor(profileId: string): Promise<boolean> {
  return phoneAnsweringAllowed(await businessCountryIso(profileId));
}
