// Field<T> ⇄ field_records row codec — the "no loss" half of P0-25.
//
// Writing is Session E's job (supersession lives there); this module owns
// the pure mapping between the in-memory Field<T> (§3.1) and its storage
// row, revalidating on the way out so a corrupt row cannot re-enter the
// system wearing a Field's type.

import type { Field } from "../core/field";
import { createField } from "../core/field";
import type { FieldStatus } from "../core/field-status";
import { isFieldStatus } from "../core/field-status";
import { fieldId } from "../core/ids";
import { isoDateTime } from "../core/iso";
import type { SourceRef } from "../core/source-ref";
import type { ProfileSection } from "./sections";
import { sectionOfFieldKey } from "./sections";

/** Shape of an INSERT into field_records (drizzle's $inferInsert, stated explicitly). */
export interface FieldRecordRow {
  profile_id: string;
  section: ProfileSection;
  field_key: string;
  value: unknown;
  status: FieldStatus;
  confidence: string; // numeric(4,3) travels as a string through pg
  source: unknown;
  observed_at: string;
  recorded_at: string;
  note: string | null;
}

export class FieldCodecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FieldCodecError";
  }
}

/** Prepare a Field<T> for insertion under a profile. Section derives from the key. */
export function fieldToRow<T>(profileId: string, field: Field<T>): FieldRecordRow {
  return {
    profile_id: profileId,
    section: sectionOfFieldKey(field.id),
    field_key: field.id,
    value: field.value,
    status: field.status,
    confidence: field.confidence.toFixed(3),
    source: field.source,
    observed_at: field.observed_at,
    recorded_at: field.recorded_at,
    note: field.note,
  };
}

/**
 * Rebuild a Field<T> from a stored row, re-running every invariant.
 * Postgres normalises timestamptz to its own text form; the instant is
 * the datum, so timestamps come back as UTC ISO strings.
 */
export function rowToField<T>(row: FieldRecordRow): Field<T> {
  if (!isFieldStatus(row.status)) {
    throw new FieldCodecError(`row carries unknown status "${row.status}"`);
  }
  const parsedConfidence = Number(row.confidence);
  return createField<T>({
    id: fieldId(row.field_key),
    value: row.value as T | null,
    status: row.status,
    confidence: parsedConfidence,
    source: row.source as SourceRef,
    observed_at: isoDateTime(new Date(row.observed_at).toISOString()),
    recorded_at: isoDateTime(new Date(row.recorded_at).toISOString()),
    note: row.note,
  });
}
