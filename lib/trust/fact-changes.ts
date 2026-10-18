// The facts-changed half of the history ledger — read-only. Every
// field record that was superseded (rule 3), paired with the record that
// replaced it, newest first. Nothing here writes.

import { desc, eq } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "../../db";
import { fieldRecords } from "../../db/schema";
import type { FactChange } from "./fact-change-view";
import { describeChange } from "./fact-change-view";

export type { FactChange } from "./fact-change-view";

export async function factChanges(profileId: string, limit = 200): Promise<FactChange[]> {
  const successor = alias(fieldRecords, "successor");
  const rows = await db
    .select({
      retired: {
        id: fieldRecords.id,
        field_key: fieldRecords.field_key,
        value: fieldRecords.value,
        status: fieldRecords.status,
        source: fieldRecords.source,
        recorded_at: fieldRecords.recorded_at,
      },
      successor: {
        id: successor.id,
        field_key: successor.field_key,
        value: successor.value,
        status: successor.status,
        source: successor.source,
        recorded_at: successor.recorded_at,
      },
    })
    .from(fieldRecords)
    .innerJoin(successor, eq(fieldRecords.superseded_by, successor.id))
    .where(eq(fieldRecords.profile_id, profileId))
    .orderBy(desc(successor.recorded_at))
    .limit(limit);
  return rows.map((r) => describeChange(r.retired, r.successor));
}
