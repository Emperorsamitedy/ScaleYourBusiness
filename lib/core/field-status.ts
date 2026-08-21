// FieldStatus — data-model-v1.md §3.1.
//
// Six distinct statuses, and the distinctions are load-bearing (rule 5:
// "I don't know" is a real answer). Collapsing any two of these loses a
// finding the diagnosis depends on:
//
//   answered        The owner or a connector supplied a value.
//   unknown         The owner explicitly said they don't know. A finding in
//                   itself — "I don't know my churn rate" tells you the
//                   business has no retention visibility. Never re-asked as
//                   if it were merely missing.
//   not_applicable  A condition made the question irrelevant (services-only
//                   business, inventory question). Not a gap at all.
//   skipped         The owner declined or deferred. Ask again later.
//   inferred        The system derived it; the SourceRef names the inputs
//                   and the formula (rule 6 — no unexplainable numbers).
//   unasked         Never presented. The interviewer hasn't judged it
//                   relevant yet — says nothing about the owner.

export const FIELD_STATUSES = [
  "answered",
  "unknown",
  "not_applicable",
  "skipped",
  "inferred",
  "unasked",
] as const;

export type FieldStatus = (typeof FIELD_STATUSES)[number];

export function isFieldStatus(value: string): value is FieldStatus {
  return (FIELD_STATUSES as readonly string[]).includes(value);
}

/** Statuses whose records carry a value. All others must have value: null. */
export const VALUE_BEARING_STATUSES: ReadonlySet<FieldStatus> = new Set(["answered", "inferred"]);
