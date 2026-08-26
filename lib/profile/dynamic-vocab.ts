// Dynamic vocabularies — "__offers__", "__channels__" and friends.
//
// Some bank questions ask the owner to pick among THEIR OWN entities
// ("which channel is primary?"), so the option list cannot live in the
// static vocabulary tables: it is the profile's own spine rows, labelled
// with whatever the owner already told us about each one.
//
// Found by the P0-52 harness: only "__offers__" was implemented, so a
// real owner with two or more channels reaching 7.3a hit an empty
// vocabulary and crashed the intake. Every dynamic vocabulary the bank
// references is resolved here, in one place, for every caller.

import { and, eq, isNull, like } from "drizzle-orm";
import { db } from "../../db";
import {
  channels,
  competitors,
  costItems,
  customerSegments,
  fieldRecords,
  goals,
  offers,
  staffRoles,
  suppliers,
} from "../../db/schema";

interface SpineSpec {
  table:
    | typeof offers
    | typeof suppliers
    | typeof channels
    | typeof competitors
    | typeof staffRoles
    | typeof costItems
    | typeof customerSegments
    | typeof goals;
  /** Entity sub-fields to try, in order, for a human label. */
  labelKeys: readonly string[];
  /** "Product 1", "Channel 2" — when the owner named nothing yet. */
  fallback: string;
}

/** vocabulary_id → how to resolve it. Keys match the bank's "__x__" ids. */
const DYNAMIC: Record<string, SpineSpec> = {
  __offers__: { table: offers, labelKeys: ["name"], fallback: "Product" },
  __channels__: { table: channels, labelKeys: ["platform", "type"], fallback: "Channel" },
  __suppliers__: { table: suppliers, labelKeys: ["name"], fallback: "Supplier" },
  __competitors__: { table: competitors, labelKeys: ["name"], fallback: "Competitor" },
  __staff_roles__: { table: staffRoles, labelKeys: ["role_title"], fallback: "Role" },
  __cost_items__: { table: costItems, labelKeys: ["label"], fallback: "Cost" },
  __customer_segments__: { table: customerSegments, labelKeys: ["name"], fallback: "Segment" },
  __goals__: { table: goals, labelKeys: ["statement"], fallback: "Goal" },
};

export function isDynamicVocabulary(vocabularyId: string): boolean {
  return Object.hasOwn(DYNAMIC, vocabularyId);
}

/** A stored value rendered as a label: plain strings and enum codes. */
function labelOf(value: unknown): string | null {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  if (value !== null && typeof value === "object") {
    const code = (value as { code?: unknown }).code;
    if (typeof code === "string" && code !== "") {
      return code.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
    }
  }
  return null;
}

/**
 * The owner's own entities as {code: entity_id, label}. Empty when the
 * profile has no rows yet — callers must treat that as "no options",
 * never as an error (the bank gates these questions on spine length,
 * so an empty list means the gate has not fired yet).
 */
export async function dynamicVocabularyOptions(
  profileId: string,
  vocabularyId: string,
): Promise<{ code: string; label: string }[]> {
  const spec = DYNAMIC[vocabularyId];
  if (!spec) return [];
  const prefix = vocabularyId.slice(2, -2); // "__channels__" → "channels"

  const [rows, records] = await Promise.all([
    db.select({ id: spec.table.id }).from(spec.table).where(eq(spec.table.profile_id, profileId)),
    db
      .select({ key: fieldRecords.field_key, value: fieldRecords.value })
      .from(fieldRecords)
      .where(
        and(
          eq(fieldRecords.profile_id, profileId),
          like(fieldRecords.field_key, `${prefix}.%`),
          isNull(fieldRecords.superseded_at),
          eq(fieldRecords.status, "answered"),
        ),
      ),
  ]);

  const byEntity = new Map<string, Map<string, unknown>>();
  for (const record of records) {
    const rest = record.key.slice(prefix.length + 1);
    const dot = rest.indexOf(".");
    if (dot < 0) continue;
    const entityId = rest.slice(0, dot);
    const bucket = byEntity.get(entityId) ?? new Map<string, unknown>();
    bucket.set(rest.slice(dot + 1), record.value);
    byEntity.set(entityId, bucket);
  }

  return rows.map((row, index) => {
    const fields = byEntity.get(row.id);
    for (const key of spec.labelKeys) {
      const label = fields ? labelOf(fields.get(key)) : null;
      if (label !== null) return { code: row.id, label };
    }
    return { code: row.id, label: `${spec.fallback} ${index + 1}` };
  });
}
