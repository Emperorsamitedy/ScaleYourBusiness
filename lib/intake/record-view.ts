// The intake's record sheet — what is on file right now, newest first.
//
// Read from the current field_records (the very rows the fact sheet
// snapshots) and humanised with the fact sheet's own repr(), so the two
// screens can never describe one fact two ways. It is not a snapshot on
// purpose: the intake state is re-read after every answer, and taking a
// snapshot per answer would write a frozen copy of the profile each time
// for a view nobody needs to reproduce later. The fact sheet and the
// report keep snapshotting as before.
//
// Pure functions: rows in, view out. The service does the reading.

import { displaySourceKind, measuredProvider } from "../connectors/measured";
import { repr } from "../profile/factsheet";
import type { IntakeRecord, RecordFact } from "./types";

export interface CurrentRow {
  field_key: string;
  status: string;
  value: unknown;
  source: unknown;
  note: string | null;
  confidence: string | number;
  observed_at: string;
  recorded_at: string;
}

/** How many rows the record sheet carries; the fact sheet holds the rest. */
export const RECORD_ROWS = 40;
/** How many derived facts the "already says" block shows. */
export const DERIVED_ROWS = 3;

const ENTITY_KEY =
  /^([a-z_]+)\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(.+)$/;

/** Statuses the record sheet lists: facts, and the gaps the owner chose (rule 5). */
const LISTED = new Set(["answered", "inferred", "unknown", "skipped"]);
const VALUE_BEARING = new Set(["answered", "inferred"]);

/** An entity marker ({ entity_ids: [...] }) reads as a count, not JSON. */
function textOf(value: unknown): string | null {
  if (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { entity_ids?: unknown }).entity_ids)
  ) {
    const n = (value as { entity_ids: unknown[] }).entity_ids.length;
    return `${n} on file`;
  }
  return repr(value);
}

function methodOf(source: unknown): string | null {
  if (typeof source !== "object" || source === null) return null;
  const m = (source as { method?: unknown }).method;
  return typeof m === "string" ? m : null;
}

export interface RecordInput {
  rows: readonly CurrentRow[];
  /** writes_to → the applicable question that writes it. */
  questionIdByKey: ReadonlyMap<string, string>;
  /** Provider id → owner-facing name ("shopify" → "Shopify"). */
  providerLabel: (id: string) => string;
}

export function toRecordFact(
  row: CurrentRow,
  input: RecordInput,
  names: ReadonlyMap<string, string>,
): RecordFact {
  const entity = ENTITY_KEY.exec(row.field_key);
  const provider = measuredProvider(row.source);
  return {
    key: row.field_key,
    entity: entity ? (names.get(`${entity[1]}.${entity[2]}`) ?? null) : null,
    field: entity ? (entity[3] ?? row.field_key) : row.field_key,
    value: VALUE_BEARING.has(row.status) ? row.value : null,
    text: VALUE_BEARING.has(row.status) ? textOf(row.value) : null,
    status: row.status,
    source_kind: displaySourceKind(row.source),
    provider: provider === null ? null : input.providerLabel(provider),
    note: row.note,
    confidence: Number(row.confidence),
    observed_at: row.observed_at,
    recorded_at: row.recorded_at,
    method: methodOf(row.source),
    question_id: input.questionIdByKey.get(row.field_key) ?? null,
  };
}

/** Entity names, from each entity's own `name` field: "offers.<id>" → "Mug". */
function entityNames(rows: readonly CurrentRow[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const row of rows) {
    const m = ENTITY_KEY.exec(row.field_key);
    if (!m || m[3] !== "name" || !VALUE_BEARING.has(row.status)) continue;
    const text = repr(row.value);
    if (text) names.set(`${m[1]}.${m[2]}`, text);
  }
  return names;
}

// Ordinal, not locale, comparison: every timestamp comes from the same
// database in the same text form, so code-unit order is time order.
const ordinal = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);
const newestFirst = (a: RecordFact, b: RecordFact): number =>
  ordinal(b.recorded_at, a.recorded_at) || ordinal(a.key, b.key);

/** Every listed fact and recorded gap, newest first, uncapped. */
export function listFacts(input: RecordInput): RecordFact[] {
  const names = entityNames(input.rows);
  return input.rows
    .filter((r) => LISTED.has(r.status))
    .map((r) => toRecordFact(r, input, names))
    .sort(newestFirst);
}

/** The record sheet's view of a listFacts() result. */
export function buildRecord(listed: readonly RecordFact[]): IntakeRecord {
  const facts = listed.filter((f) => VALUE_BEARING.has(f.status));
  const sources = new Map<string, { kind: string; provider: string | null; count: number }>();
  for (const f of facts) {
    const id = `${f.source_kind}:${f.provider ?? ""}`;
    const entry = sources.get(id) ?? { kind: f.source_kind, provider: f.provider, count: 0 };
    entry.count += 1;
    sources.set(id, entry);
  }

  // displaySourceKind() already calls a measurement "connector", so
  // "inferred" here is only ever a derivation from the owner's own facts.
  const derived = facts.filter((f) => f.source_kind === "inferred").slice(0, DERIVED_ROWS);

  return {
    fact_count: facts.length,
    sources: [...sources.values()].sort(
      (a, b) => b.count - a.count || a.kind.localeCompare(b.kind),
    ),
    not_known: listed.filter((f) => f.status === "unknown").length,
    skipped: listed.filter((f) => f.status === "skipped").length,
    facts: listed.slice(0, RECORD_ROWS),
    more: Math.max(0, listed.length - RECORD_ROWS),
    derived,
  };
}

/**
 * A measurement already on record for a question: the current measured
 * fact at its writes_to key, or the newest one beneath it. Null when the
 * record holds none — the "already read" box is never invented.
 */
export function alreadyRead(writesTo: string, record: readonly RecordFact[]): RecordFact | null {
  const hits = record.filter(
    (f) =>
      f.source_kind === "connector" &&
      f.provider !== null &&
      f.text !== null &&
      (f.key === writesTo || f.key.startsWith(`${writesTo}.`)),
  );
  return hits.find((f) => f.key === writesTo) ?? hits[0] ?? null;
}

/** How many rows the area's record card carries. */
export const AREA_ROWS = 6;

/**
 * The record card's view of one area: its facts and recorded gaps, newest
 * first (capped), and how many value-bearing facts it holds in all. A
 * fact's area is the section of the question that writes it — the area
 * the owner would answer it in — else its key's home section; the caller
 * supplies that mapping.
 */
export function areaRecord(
  listed: readonly RecordFact[],
  section: string,
  sectionOf: (fact: RecordFact) => string | null,
  cap: number = AREA_ROWS,
): { section: string; facts: RecordFact[]; fact_count: number } {
  const inArea = listed.filter((f) => sectionOf(f) === section);
  return {
    section,
    facts: inArea.slice(0, cap),
    fact_count: inArea.filter((f) => VALUE_BEARING.has(f.status)).length,
  };
}
