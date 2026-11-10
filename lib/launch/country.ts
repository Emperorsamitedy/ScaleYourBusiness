// Opening a country — the multi-market spec §D.2's seeded-launch rule.
//
// A country can't be marked publicly open until at least 7 live,
// contributing businesses exist in at least one (NACE, segment) pair there.
// This is a check on the operation itself, not a runbook step: openCountry
// refuses below it, and the row it writes names the cohort that allowed it.
//
// "Live, contributing" here: a live peer-benchmark consent and at least one
// connected measuring source (a cohort is built from measured values, the
// v1 spec §5.3) — counted per business, never per row.

import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import { db } from "../../db";
import {
  businessProfiles,
  connections,
  countryLaunches,
  fieldRecords,
  peerBenchmarkConsents,
} from "../../db/schema";
import { typeEntry, isMapped } from "../benchmarks/map";
import { countryCode } from "../core/country";
import { PEER_K } from "../peers/aggregate";
import { segmentOf } from "../segments/read";

export class LaunchError extends Error {
  readonly status: number;
  constructor(message: string, status = 409) {
    super(message);
    this.name = "LaunchError";
    this.status = status;
  }
}

export interface CohortCount {
  nace: string;
  segment: string;
  businesses: number;
}

/** Live, contributing businesses in a country, counted by (NACE, segment). */
export async function contributingCohorts(country: string): Promise<CohortCount[]> {
  const iso = country.toUpperCase();
  const consented = await db
    .select({
      profile_id: peerBenchmarkConsents.profile_id,
      account_id: businessProfiles.account_id,
    })
    .from(peerBenchmarkConsents)
    .innerJoin(businessProfiles, eq(businessProfiles.id, peerBenchmarkConsents.profile_id))
    .where(isNull(peerBenchmarkConsents.withdrawn_at));
  if (consented.length === 0) return [];
  const measured = new Set(
    (
      await db
        .select({ account_id: connections.account_id })
        .from(connections)
        .where(
          and(
            inArray(
              connections.account_id,
              consented.map((c) => c.account_id),
            ),
            eq(connections.status, "connected"),
            ne(connections.purpose, "execute"),
          ),
        )
    ).map((r) => r.account_id),
  );
  const facts = await db
    .select({
      profile_id: fieldRecords.profile_id,
      key: fieldRecords.field_key,
      value: fieldRecords.value,
    })
    .from(fieldRecords)
    .where(
      and(
        inArray(
          fieldRecords.profile_id,
          consented.map((c) => c.profile_id),
        ),
        inArray(fieldRecords.field_key, ["legal.country", "identity.business_type"]),
        isNull(fieldRecords.superseded_at),
      ),
    );
  const byProfile = new Map<string, { country?: string | null; nace?: string }>();
  for (const f of facts) {
    const held = byProfile.get(f.profile_id) ?? {};
    if (f.key === "legal.country" && typeof f.value === "string")
      held.country = countryCode(f.value);
    if (f.key === "identity.business_type") {
      const e = typeEntry(f.value);
      if (isMapped(e)) held.nace = e.nace;
    }
    byProfile.set(f.profile_id, held);
  }
  const counts = new Map<string, Set<string>>();
  for (const c of consented) {
    const p = byProfile.get(c.profile_id);
    if (p?.country !== iso || !p.nace || !measured.has(c.account_id)) continue;
    const segment = (await segmentOf(c.profile_id)).segment;
    if (segment === null) continue;
    const key = `${p.nace}|${segment}`;
    const set = counts.get(key) ?? new Set<string>();
    set.add(c.profile_id);
    counts.set(key, set);
  }
  return [...counts]
    .map(([k, set]) => {
      const [nace, segment] = k.split("|");
      return { nace: nace!, segment: segment!, businesses: set.size };
    })
    .sort((a, b) => b.businesses - a.businesses);
}

export async function isCountryOpen(country: string): Promise<boolean> {
  const [row] = await db
    .select({ country: countryLaunches.country })
    .from(countryLaunches)
    .where(eq(countryLaunches.country, country.toUpperCase()));
  return row !== undefined;
}

/** §D.2: mark a country publicly open — refused below 7 contributing businesses in one pair. */
export async function openCountry(country: string, by: string): Promise<CohortCount> {
  const iso = country.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(iso)) throw new LaunchError("a country is two letters", 422);
  if (by.trim() === "") throw new LaunchError("say who is opening the country", 422);
  const cohorts = await contributingCohorts(iso);
  const qualifying = cohorts.find((c) => c.businesses >= PEER_K);
  if (!qualifying) {
    const best = cohorts[0];
    throw new LaunchError(
      `${iso} can't open yet: it needs ${PEER_K} live, contributing businesses in one sector and size — the most in any is ${best?.businesses ?? 0}`,
    );
  }
  await db
    .insert(countryLaunches)
    .values({ country: iso, opened_by: by.trim(), qualifying_cohort: qualifying })
    .onConflictDoNothing();
  return qualifying;
}
