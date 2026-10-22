// What a signed-in screen calls the owner's business: "your salon",
// "your gym", "your shop" — from the profile's business_type answer
// (identity.business_type, the bank's `business_type` vocabulary).
//
// The mapping is data, a table keyed by vocabulary code (CLAUDE.md
// rule 4) — never an if-chain. A code the table does not name, "other",
// a malformed value or a missing answer all read "your business", which
// is true of everyone. business-noun.test.ts holds every key to the bank.

import { enumCode } from "./enum-value";

export const FALLBACK_NOUN = "business";

/** business_type code → the plain noun an owner would use for it. */
export const BUSINESS_NOUN: Readonly<Record<string, string>> = {
  retail_shop: "shop",
  ecommerce_store: "shop",
  restaurant: "restaurant",
  cafe: "café",
  bar: "bar",
  food_production: "kitchen",
  salon_beauty: "salon",
  barber: "barbershop",
  gym_fitness: "gym",
  wellness_spa: "spa",
  clinic_health: "clinic",
  construction: "firm",
  automotive: "garage",
  professional_services: "practice",
  consulting: "practice",
  agency_marketing: "agency",
  it_services: "firm",
  software_saas: "company",
  education_training: "school",
  childcare: "nursery",
  real_estate: "agency",
  logistics: "company",
  manufacturing: "company",
  wholesale: "company",
  agriculture: "farm",
  photography_creative: "studio",
  transport: "company",
  nonprofit: "organisation",
};

/**
 * "your salon" for a stored business_type answer — an EnumValue
 * ({code}), a bare code string, or nothing at all.
 */
export function businessNoun(value: unknown): string {
  const code = enumCode(value);
  const noun =
    code !== null && Object.hasOwn(BUSINESS_NOUN, code) ? BUSINESS_NOUN[code] : undefined;
  return `your ${noun ?? FALLBACK_NOUN}`;
}
