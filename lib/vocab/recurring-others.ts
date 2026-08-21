// Recurring "other" report — §3.4 / step 16 (P0-32).
//
// When owners keep typing the same thing into "other", that wording is a
// missing vocabulary entry. This report surfaces them for promotion —
// "how the business-type dropdown gets better over time instead of
// ossifying". Read-only over CURRENT records; superseded history and
// unanswered statuses don't vote.

import { and, eq, isNull, or, sql } from "drizzle-orm";
import { db } from "../../db";
import { fieldRecords } from "../../db/schema";
import type { EnumValue } from "../core/enum-value";
import { OTHER_CODE } from "../core/enum-value";

export interface RecurringOther {
  /** Entity ids folded to "*" — five offers' "problems" answers count together. */
  field_key: string;
  /** Case/whitespace-folded grouping key. */
  normalized: string;
  /** A representative original wording (first seen). */
  label_raw: string;
  count: number;
}

const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** "offers.7f3a….problems" → "offers.*.problems" — the conceptual question. */
export function foldEntityIds(fieldKey: string): string {
  return fieldKey
    .split(".")
    .map((segment) => (UUID_SEGMENT.test(segment) ? "*" : segment))
    .join(".");
}

function collectOthers(value: unknown): string[] {
  const values: EnumValue[] = Array.isArray(value) ? (value as EnumValue[]) : [value as EnumValue];
  return values
    .filter((v) => v !== null && typeof v === "object" && v.code === OTHER_CODE)
    .map((v) => v.label_raw)
    .filter((raw): raw is string => typeof raw === "string" && raw.trim() !== "");
}

/**
 * Tally label_raw wordings across current answered records, grouped by
 * field_key + folded wording. minCount=2 by default: a wording is
 * "recurring" the second time anyone types it.
 */
export async function recurringOthers(minCount = 2): Promise<RecurringOther[]> {
  // jsonb containment matches both value shapes: a single EnumValue object
  // or a multi-select array of them.
  const rows = await db
    .select({ field_key: fieldRecords.field_key, value: fieldRecords.value })
    .from(fieldRecords)
    .where(
      and(
        isNull(fieldRecords.superseded_at),
        eq(fieldRecords.status, "answered"),
        or(
          sql`${fieldRecords.value} @> '{"code": "other"}'::jsonb`,
          sql`${fieldRecords.value} @> '[{"code": "other"}]'::jsonb`,
        ),
      ),
    );

  const tally = new Map<string, RecurringOther>();
  for (const row of rows) {
    const folded = foldEntityIds(row.field_key);
    for (const raw of collectOthers(row.value)) {
      const normalized = raw.trim().toLowerCase();
      const key = `${folded} ${normalized}`;
      const existing = tally.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        tally.set(key, { field_key: folded, normalized, label_raw: raw.trim(), count: 1 });
      }
    }
  }
  return [...tally.values()]
    .filter((entry) => entry.count >= minCount)
    .sort((a, b) => b.count - a.count);
}
