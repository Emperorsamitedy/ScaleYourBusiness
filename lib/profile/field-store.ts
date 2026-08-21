// The supersession write path — rule 3, data-model-v1.md §3.1, step 15.
//
// Facts are superseded, never overwritten. The ONLY update this module
// ever issues touches superseded_at / superseded_by on the outgoing
// record; a value, once written, is immutable for the life of the
// database. Price history, trend detection and contradiction detection
// all fall out of that for free — and it cannot be retrofitted.
//
// Concurrency: the partial unique index field_records_current_idx
// guarantees at most one current record per (profile, key). Two racing
// writers both mark the old record, but only one insert lands; the loser
// fails the unique index and can retry against the new state. The
// database is the arbiter, not application locking.

import { createHash } from "node:crypto";
import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "../../db";
import { decisionLog, fieldRecords } from "../../db/schema";
import type { Field } from "../core/field";
import { fieldRecordId } from "../core/ids";
import type { FieldRecordRow } from "./field-codec";
import { fieldToRow, rowToField } from "./field-codec";

/**
 * Canonical sha256 of what was written — the decision log stores the hash
 * so later tampering with a field record is detectable against the log.
 * Key order is fixed by construction; do not spread `field` here.
 */
export function hashFieldPayload<T>(profileId: string, field: Field<T>): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        profile_id: profileId,
        field_key: field.id,
        value: field.value,
        status: field.status,
        confidence: field.confidence,
        source: field.source,
        observed_at: field.observed_at,
        note: field.note,
      }),
    )
    .digest("hex");
}

export interface HistoricalFieldRecord<T> {
  /** Storage id of this record — what superseded_by chains point at. */
  record_id: string;
  field: Field<T>;
  /** null on the current record, set the moment a successor replaced it. */
  superseded_at: string | null;
}

/**
 * Write a field: mark the current record (if any) superseded and insert
 * the new one, atomically. Returns the new record's storage id.
 */
export async function writeField<T>(profileId: string, field: Field<T>): Promise<string> {
  const newId = crypto.randomUUID();
  await db.transaction(async (tx) => {
    // 1. Retire the current record. superseded_at frees the partial unique
    //    index for the incoming insert; superseded_by must wait until the
    //    successor row exists (self-FK).
    const retired = await tx
      .update(fieldRecords)
      .set({ superseded_at: new Date().toISOString() })
      .where(
        and(
          eq(fieldRecords.profile_id, profileId),
          eq(fieldRecords.field_key, field.id),
          isNull(fieldRecords.superseded_at),
        ),
      )
      .returning({ id: fieldRecords.id });
    // 2. Insert the successor.
    await tx.insert(fieldRecords).values({
      ...(fieldToRow(profileId, field) as typeof fieldRecords.$inferInsert),
      id: newId,
    });
    // 3. Chain the retired record forward.
    const previous = retired[0];
    if (previous) {
      await tx
        .update(fieldRecords)
        .set({ superseded_by: newId })
        .where(eq(fieldRecords.id, previous.id));
    }
    // 4. Every profile change writes a decision-log entry (rule 7), in the
    //    same transaction: a fact without its log entry cannot exist.
    await tx.insert(decisionLog).values({
      profile_id: profileId,
      actor:
        field.source.kind === "owner_input" || field.source.kind === "conversation"
          ? "owner"
          : "system",
      kind: "profile_change",
      ref_id: newId,
      payload_hash: hashFieldPayload(profileId, field),
    });
  });
  return newId;
}

/**
 * The default read: the newest non-superseded record, rebuilt as a typed
 * Field. History is opt-in via readFieldHistory — nothing downstream
 * accidentally reasons from a stale value.
 */
export async function readCurrentField<T>(
  profileId: string,
  fieldKey: string,
): Promise<Field<T> | null> {
  const rows = await db
    .select()
    .from(fieldRecords)
    .where(
      and(
        eq(fieldRecords.profile_id, profileId),
        eq(fieldRecords.field_key, fieldKey),
        isNull(fieldRecords.superseded_at),
      ),
    );
  const row = rows[0];
  return row ? rowToField<T>(row as unknown as FieldRecordRow) : null;
}

/**
 * The full dated chain for a field, oldest first: every value it has ever
 * held, when each was observed and recorded, and which record replaced
 * it. The last entry is the current one (superseded_at null).
 */
export async function readFieldHistory<T>(
  profileId: string,
  fieldKey: string,
): Promise<HistoricalFieldRecord<T>[]> {
  const rows = await db
    .select()
    .from(fieldRecords)
    .where(and(eq(fieldRecords.profile_id, profileId), eq(fieldRecords.field_key, fieldKey)))
    .orderBy(asc(fieldRecords.recorded_at));
  return rows.map((row) => ({
    record_id: row.id,
    field: {
      // createField pins superseded_by to null (a new record is never born
      // superseded); a stored record legitimately carries its successor.
      ...rowToField<T>(row as unknown as FieldRecordRow),
      superseded_by: row.superseded_by === null ? null : fieldRecordId(row.superseded_by),
    },
    superseded_at: row.superseded_at,
  }));
}
