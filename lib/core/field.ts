// Field<T> — data-model-v1.md §3.1. The atomic unit of the profile.
//
// Rule 2: no bare values. A number without provenance is not usable by the
// diagnosis, so the wrapper carries value, status, confidence, source and
// both timestamps — and createField() refuses the combinations that would
// quietly lie:
//
//   · a value on a status that denies having one (unknown with a number
//     attached is two contradictory claims)
//   · no value on a status that promises one (answered with null is a
//     bare gap wearing an answer's status)
//   · status "inferred" without an inferred source, or an inferred source
//     under any other status — provenance and status must tell one story
//     (rule 6)
//
// This is why Field<T> "looks trivial and isn't": the type alone can't
// enforce any of that; the constructor is the contract.

import type { Confidence } from "./confidence";
import { confidence } from "./confidence";
import type { FieldStatus } from "./field-status";
import { VALUE_BEARING_STATUSES } from "./field-status";
import type { FieldId, FieldRecordId } from "./ids";
import type { ISODateTime } from "./iso";
import type { SourceRef } from "./source-ref";
import { validateSourceRef } from "./source-ref";

export interface Field<T> {
  /** Stable path, e.g. "revenue.monthly_current". */
  id: FieldId;
  value: T | null;
  status: FieldStatus;
  confidence: Confidence;
  source: SourceRef;
  /** When this was true — not when it was recorded. */
  observed_at: ISODateTime;
  recorded_at: ISODateTime;
  /** Set by supersession (Session E), never at creation. */
  superseded_by: FieldRecordId | null;
  /** Owner's free-text qualifier, e.g. "roughly, before VAT". */
  note: string | null;
}

export class FieldInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FieldInvariantError";
  }
}

export interface CreateFieldInput<T> {
  id: FieldId;
  value: T | null;
  status: FieldStatus;
  /** Raw number — validated and branded here. */
  confidence: number;
  source: SourceRef;
  observed_at: ISODateTime;
  recorded_at: ISODateTime;
  note?: string | null;
}

/**
 * The only sanctioned way to build a Field<T>. New records are never born
 * superseded — supersession is Session E's write path marking the previous
 * record, not something a constructor can claim.
 */
export function createField<T>(input: CreateFieldInput<T>): Field<T> {
  const bearsValue = VALUE_BEARING_STATUSES.has(input.status);

  if (bearsValue && input.value === null) {
    throw new FieldInvariantError(
      `status "${input.status}" promises a value but value is null — a gap must say unknown, skipped or unasked (rule 5)`,
    );
  }
  if (!bearsValue && input.value !== null) {
    throw new FieldInvariantError(
      `status "${input.status}" denies having a value but one was supplied — two contradictory claims in one record`,
    );
  }
  if (input.status === "inferred" && input.source.kind !== "inferred") {
    throw new FieldInvariantError(
      `status "inferred" requires an inferred source naming derived_from and method (rule 6), got source kind "${input.source.kind}"`,
    );
  }
  if (input.status !== "inferred" && input.source.kind === "inferred") {
    throw new FieldInvariantError(
      `an inferred source under status "${input.status}" hides a derivation — inferred values are marked as such (rule 6)`,
    );
  }

  return {
    id: input.id,
    value: input.value,
    status: input.status,
    confidence: confidence(input.confidence),
    source: validateSourceRef(input.source),
    observed_at: input.observed_at,
    recorded_at: input.recorded_at,
    superseded_by: null,
    note: input.note ?? null,
  };
}
