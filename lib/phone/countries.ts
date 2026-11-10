// Phone answering's country flag — hard rule 6; the v1 build spec §9.2.
//
// Since 2026-11-10 the flag is the country compliance matrix
// (lib/compliance/matrix.ts): a table changed without a deploy, every change
// audit-logged, a country unblocked only with counsel's dated sign-off. A
// country with no row — the default — is blocked, and so is a business
// whose country can't be read. phoneAllowedFor reads the matrix, and
// ComplianceGate reads the same row, so the line and the gate can't
// disagree.
//
// PHONE_ANSWERING_COUNTRIES (architecture-v2 D6) was the first cut: an
// environment list that needed a deploy to change. Its parser is kept below,
// but nothing obeys it any more.
//
// This file sits inside the phone line's import fence
// (lib/support/structure.test.ts): the database, its schema, the pure
// country map and the matrix reader only.

import { and, eq, isNull } from "drizzle-orm";
import { db } from "../../db";
import { fieldRecords } from "../../db/schema";
import { countryCode } from "../core/country";
import { countryRule, inboundPhoneAllowed } from "../compliance/matrix";

export const PHONE_COUNTRIES_KEY = "PHONE_ANSWERING_COUNTRIES";

type EnvSource = Readonly<Record<string, string | undefined>>;

/** Superseded (see above). The ISO codes the old list named; junk is ignored, never guessed. */
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

/** Whether this business's line may answer at all (hard rule 6): its country's matrix row. */
export async function phoneAllowedFor(profileId: string): Promise<boolean> {
  return inboundPhoneAllowed(await countryRule(await businessCountryIso(profileId)));
}
