// A fact change, as the history ledger shows it (the owner's History
// design, 2026-10-17). Rule 3 keeps every retired value; this turns one
// retired record and its successor into a ledger line: which fact, the
// old value, the new value, when the successor was recorded and where it
// came from. Pure — the query lives in fact-changes.ts.

import { displaySourceKind } from "../connectors/measured";
import { repr } from "../profile/factsheet";

export interface FactChange {
  /** The successor record's id — the entry the ledger points at. */
  id: string;
  /** The stable field key, e.g. "offers.<uuid>.price". */
  key: string;
  /** The retired value, as words; null when it was a gap. */
  from: string | null;
  /** The successor's value, as words; null when it is now a gap. */
  to: string | null;
  /** The successor's status: "known", "estimated", "unknown"… */
  to_status: string;
  /** When the successor was recorded. */
  at: string;
  /** The successor's source kind: "owner_input", "connector", "inferred"… */
  by: string;
}

export interface RecordShape {
  id: string;
  field_key: string;
  value: unknown;
  status: string;
  source: unknown;
  recorded_at: string;
}

/** One supersession, retired → successor. */
export function describeChange(retired: RecordShape, successor: RecordShape): FactChange {
  return {
    id: successor.id,
    key: successor.field_key,
    from: repr(retired.value),
    to: repr(successor.value),
    to_status: successor.status,
    at: successor.recorded_at,
    by: displaySourceKind(successor.source),
  };
}
