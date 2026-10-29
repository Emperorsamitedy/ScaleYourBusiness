// Compared with similar businesses — the database side (idea 44, I-44.4).
// Reads the profile's current facts the comparison needs, each with its
// provenance, and nothing else. Read-only: it writes no row and no Field,
// calls no model and nothing outside the database; the Eurostat side is
// the committed snapshot (lib/benchmarks/snapshot.ts).

import { and, eq, inArray, isNull, like, or } from "drizzle-orm";
import { db } from "../../db";
import { costItems, fieldRecords, offers } from "../../db/schema";
import { codesOf, costLines, countFactOf, moneyFactOf, offerLines } from "../cash/inputs";
import type { Facts } from "../cash/inputs";
import { ORDERS_MONTHLY_KEY } from "../cash/keys";
import type { Field } from "../core/field";
import { isSizeBand } from "../core/size-features";
import { COUNTRY_KEY, countryCode } from "../hours/timezone";
import type { FieldRecordRow } from "../profile/field-codec";
import { rowToField } from "../profile/field-codec";
import { SIZE_BAND_KEY, TEAM_SIZE_KEY } from "../profile/size-band";
import type { BenchInputs, StaffLine } from "./compare";

export const TYPE_KEY = "identity.business_type";
export const REVENUE_KEY = "revenue.monthly_revenue";
export const GROSS_MARGIN_KEY = "costs.gross_margin";
export const STAFF_KEY = "operations.staff";

const VALUE_BEARING = new Set(["answered", "inferred"]);

async function currentFacts(profileId: string): Promise<Map<string, Field<unknown>>> {
  const rows = await db
    .select()
    .from(fieldRecords)
    .where(
      and(
        eq(fieldRecords.profile_id, profileId),
        isNull(fieldRecords.superseded_at),
        or(
          like(fieldRecords.field_key, "costs.%"),
          like(fieldRecords.field_key, "offers.%"),
          like(fieldRecords.field_key, "operations.%"),
          inArray(fieldRecords.field_key, [
            TYPE_KEY,
            COUNTRY_KEY,
            TEAM_SIZE_KEY,
            SIZE_BAND_KEY,
            REVENUE_KEY,
            ORDERS_MONTHLY_KEY,
          ]),
        ),
      ),
    );
  const facts = new Map<string, Field<unknown>>();
  for (const row of rows) {
    facts.set(row.field_key, rowToField<unknown>(row as unknown as FieldRecordRow));
  }
  return facts;
}

/** Pure: 9.2's rows, or null when the team list was never given. */
export function staffLines(facts: Facts): StaffLine[] | null {
  const marker = facts.get(STAFF_KEY);
  if (!marker || !VALUE_BEARING.has(marker.status) || marker.value === null) return null;
  const ids = (marker.value as { entity_ids?: unknown }).entity_ids;
  if (!Array.isArray(ids)) return null;
  return ids
    .filter((id): id is string => typeof id === "string")
    .map((id) => ({
      key: `operations.${id}`,
      engagement: codesOf(facts.get(`operations.${id}.engagement`))?.[0] ?? null,
      cost: moneyFactOf(facts.get(`operations.${id}.cost_monthly`)),
    }));
}

/** Pure: the comparison's inputs from a profile's current facts and its cost and offer rows. */
export function benchInputsOf(
  facts: Facts,
  items: readonly { id: string; bucket: "fixed" | "variable" }[],
  offerIds: readonly string[],
  asOf: string,
): BenchInputs {
  const typeField = facts.get(TYPE_KEY);
  const country = facts.get(COUNTRY_KEY);
  const countryRaw =
    country && VALUE_BEARING.has(country.status) && typeof country.value === "string"
      ? country.value.trim()
      : "";
  const band = codesOf(facts.get(SIZE_BAND_KEY))?.[0] ?? null;
  const stated = facts.get(SIZE_BAND_KEY)?.status === "answered";
  return {
    as_of: asOf,
    business_type: typeField?.status === "answered" ? typeField.value : null,
    country: countryRaw === "" ? null : { raw: countryRaw, iso: countryCode(countryRaw) },
    team_size: countFactOf(facts.get(TEAM_SIZE_KEY)),
    size_band: stated && band !== null && isSizeBand(band) ? band : null,
    revenue: moneyFactOf(facts.get(REVENUE_KEY)),
    orders_month: countFactOf(facts.get(ORDERS_MONTHLY_KEY)),
    gross_margin: countFactOf(facts.get(GROSS_MARGIN_KEY)),
    offers: offerLines(facts, offerIds),
    costs: costLines(facts, items),
    staff: staffLines(facts),
  };
}

/** Everything the comparison needs for one business, as of `now`. */
export async function loadBenchInputs(
  profileId: string,
  now: Date = new Date(),
): Promise<BenchInputs> {
  const [facts, items, offerRows] = await Promise.all([
    currentFacts(profileId),
    db
      .select({ id: costItems.id, bucket: costItems.bucket })
      .from(costItems)
      .where(eq(costItems.profile_id, profileId)),
    db.select({ id: offers.id }).from(offers).where(eq(offers.profile_id, profileId)),
  ]);
  return benchInputsOf(
    facts,
    items,
    offerRows.map((o) => o.id),
    now.toISOString().slice(0, 10),
  );
}
