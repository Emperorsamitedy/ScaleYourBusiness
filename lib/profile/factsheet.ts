// The fact sheet — P1-59/60. Everything the owner has told us, with its
// provenance, and everything they haven't, with what answering it buys.
//
// Reads from a SNAPSHOT (ensureSnapshot dedupes by content hash), so
// what the owner sees is a stable, reproducible view — the same read a
// report will render from — never a live query that can shift under
// them mid-scroll. Gaps come from the applicability resolver: a
// services-only business is not "missing" inventory questions that do
// not exist for it. All of it is deterministic arithmetic; no model is
// consulted to describe the owner's own data.

import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { db } from "../../db";
import { fieldRecords } from "../../db/schema";
import { PRIORITY_WEIGHTS, computeCompleteness } from "../scorer/completeness";
import type { ApplicableQuestion } from "../resolver/applicability";
import { applicableQuestions } from "../resolver/applicability";
import { displaySourceKind } from "../connectors/measured";
import type { Field } from "../core/field";
import { ensureSnapshot, readSnapshot } from "./snapshot";
import type { ProfileSection } from "./sections";
import { isProfileSection } from "./sections";

/* ── the view ── */

export interface FactRow {
  key: string;
  /** Humanised value — money as an amount + currency, enums by label. */
  value: string | null;
  status: string;
  confidence: number;
  source_kind: string;
  /** URL, question id, or derivation formula — whatever the source names. */
  source_detail: string | null;
  observed_at: string;
  /** When the record was written — what "changed this month" is measured on. */
  recorded_at: string;
  note: string | null;
}

/**
 * One superseded record (rule 3): a value the field held until something
 * better came in. Kept forever; shown struck through, never erased.
 */
export interface SupersededFact {
  key: string;
  value: string | null;
  status: string;
  source_kind: string;
  source_detail: string | null;
  observed_at: string;
  recorded_at: string;
  /** When its successor replaced it. */
  superseded_at: string;
  note: string | null;
}

/** field_key → its superseded records, newest first. */
export type FactHistory = Record<string, SupersededFact[]>;

export interface EntityGroup {
  /** "competitors.<id>" — the field-key prefix the rows share. */
  id: string;
  spine: string;
  /** The entity's own name field, when it has one. */
  name: string | null;
  facts: FactRow[];
}

export interface GapRow {
  question_id: string;
  prompt: string;
  section: ProfileSection;
  priority: ApplicableQuestion["priority"];
  /** Why answering is worth it — deterministic copy, never a model's. */
  buys: string;
  /** True when this gap alone holds the diagnosis back. */
  blocking: boolean;
}

export interface FactSheet {
  profile_id: string;
  snapshot_id: string;
  taken_at: string;
  fact_count: number;
  completeness: {
    overall: number;
    core_complete: boolean;
    by_section: { section: ProfileSection; score: number }[];
  };
  /** Counts by source kind — where the 214 came from. */
  provenance: { kind: string; count: number }[];
  /** Scalar facts, grouped by profile section. */
  sections: { section: ProfileSection; facts: FactRow[] }[];
  /** Entity facts (offers, competitors, …), grouped per entity. */
  entities: EntityGroup[];
  gaps: GapRow[];
  /** Superseded records for the facts above, by full field_key (rule 3). */
  history: FactHistory;
  /** Start of the current calendar month (UTC) — what "changed this month" counts from. */
  changed_since: string;
  /** Keys whose value was replaced since `changed_since`. */
  changed: string[];
}

/** Pure: the first instant of `now`'s calendar month, UTC. */
export function monthStart(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

/* ── humanising values: deterministic, no model ── */

const isMoney = (v: unknown): v is { amount_minor: number; currency: string } =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as { amount_minor?: unknown }).amount_minor === "number" &&
  typeof (v as { currency?: unknown }).currency === "string";

const MINOR_UNITS: Record<string, number> = { HUF: 2, EUR: 2, USD: 2, GBP: 2, JPY: 0 };

export function repr(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  // A bare vocabulary code ("social_organic") reads as words; anything
  // with spaces, capitals or punctuation is owner text and stays verbatim.
  if (typeof value === "string")
    return /^[a-z0-9]+(_[a-z0-9]+)+$/.test(value) ? value.replace(/_/g, " ") : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (isMoney(value)) {
    const digits = MINOR_UNITS[value.currency] ?? 2;
    const major = value.amount_minor / 10 ** digits;
    return `${major.toLocaleString("en-US").replace(/,/g, " ")} ${value.currency}`;
  }
  if (Array.isArray(value)) {
    const parts = value.map(repr).filter((p): p is string => p !== null);
    return parts.length > 0 ? parts.join(", ") : null;
  }
  if (typeof value === "object") {
    const o = value as { label_raw?: unknown; code?: unknown; value?: unknown };
    if (typeof o.label_raw === "string" && o.label_raw !== "") return o.label_raw;
    if (typeof o.code === "string") return o.code.replace(/_/g, " ");
    if (typeof o.value === "string") return o.value;
    return JSON.stringify(value).slice(0, 120);
  }
  return String(value);
}

const WEEK = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const isPeriod = (p: unknown): p is { open: string; close: string } =>
  typeof p === "object" &&
  p !== null &&
  typeof (p as { open?: unknown }).open === "string" &&
  typeof (p as { close?: unknown }).close === "string";

/**
 * An opening schedule (lib/hours/schedule.ts OpeningSchedule) in words:
 * "Mon closed · Tue 20:00–01:00 · …". A day the answer never mentioned
 * says "not stated" — unknown is not closed (rule 5). Null for anything
 * that is not a schedule.
 */
export function scheduleWords(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const days = (value as { days?: unknown }).days;
  if (typeof days !== "object" || days === null || Array.isArray(days)) return null;
  const map = days as Record<string, unknown>;
  if (!WEEK.some((d) => Array.isArray(map[d]))) return null;
  const unstated = new Set(
    Array.isArray((value as { unstated?: unknown }).unstated)
      ? ((value as { unstated: unknown[] }).unstated.filter(
          (d) => typeof d === "string",
        ) as string[])
      : [],
  );
  const name = (d: string) => d.charAt(0).toUpperCase() + d.slice(1);
  return WEEK.map((d) => {
    const periods = map[d];
    if (unstated.has(d) || !Array.isArray(periods)) return `${name(d)} not stated`;
    const ok = periods.filter(isPeriod);
    if (ok.length === 0) return `${name(d)} closed`;
    return `${name(d)} ${ok.map((p) => `${p.open}–${p.close}`).join(", ")}`;
  }).join(" · ");
}

/**
 * The value as the fact sheet and the report print it: repr(), except a
 * schedule reads as days and hours. Display only — repr() itself stays
 * byte-for-byte what the diagnosis evidence was written from.
 */
export function displayValue(value: unknown): string | null {
  return scheduleWords(value) ?? repr(value);
}

export function sourceDetail(source: unknown): string | null {
  if (typeof source !== "object" || source === null) return null;
  const s = source as {
    researched_url?: unknown;
    question_id?: unknown;
    method?: unknown;
    derived_from?: unknown;
  };
  if (typeof s.researched_url === "string") return s.researched_url;
  if (typeof s.method === "string") return s.method;
  if (typeof s.question_id === "string") return s.question_id;
  return null;
}

function toRow(key: string, field: Field<unknown>): FactRow {
  return {
    key,
    value: displayValue(field.value),
    status: field.status,
    confidence: field.confidence,
    // "connector" for a measured fact, so its pill says "measured" (P2-10).
    source_kind: displaySourceKind(field.source),
    source_detail: sourceDetail(field.source),
    observed_at: field.observed_at,
    recorded_at: field.recorded_at,
    note: field.note ?? null,
  };
}

/* ── history: the superseded records, read-only ── */

/** The raw columns of a field_records row the history view needs. */
export interface SupersededRowInput {
  field_key: string;
  value: unknown;
  status: string;
  source: unknown;
  observed_at: string;
  recorded_at: string;
  superseded_at: string | null;
  note: string | null;
}

const isoOf = (t: string): string => {
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? t : d.toISOString();
};

/** Pure: a stored row as a history line. Null for a row that is still current. */
export function toSupersededFact(row: SupersededRowInput): SupersededFact | null {
  if (row.superseded_at === null) return null;
  return {
    key: row.field_key,
    value: displayValue(row.value),
    status: row.status,
    source_kind: displaySourceKind(row.source),
    source_detail: sourceDetail(row.source),
    observed_at: isoOf(row.observed_at),
    recorded_at: isoOf(row.recorded_at),
    superseded_at: isoOf(row.superseded_at),
    note: row.note,
  };
}

/** Pure: group history lines by key, newest supersession first, at most `perKey` each. */
export function groupHistory(facts: readonly SupersededFact[], perKey = 12): FactHistory {
  const out: FactHistory = {};
  const sorted = [...facts].sort(
    (a, b) =>
      b.superseded_at.localeCompare(a.superseded_at) || b.recorded_at.localeCompare(a.recorded_at),
  );
  for (const f of sorted) {
    const list = (out[f.key] ??= []);
    if (list.length < perKey) list.push(f);
  }
  return out;
}

/** Pure: the keys whose value was replaced at or after `sinceIso` — "changed this month". */
export function changedSince(history: FactHistory, sinceIso: string): Set<string> {
  const since = Date.parse(sinceIso);
  const keys = new Set<string>();
  for (const [key, list] of Object.entries(history)) {
    if (list.some((f) => Date.parse(f.superseded_at) >= since)) keys.add(key);
  }
  return keys;
}

/** Hard cap on history rows read per profile — the view is a record, not an export. */
const HISTORY_ROW_CAP = 2000;

/**
 * Every superseded record of a profile (optionally only for `keys`),
 * grouped by key. Read-only: it selects, it never writes.
 */
export async function readSupersededFacts(
  profileId: string,
  keys?: readonly string[],
): Promise<FactHistory> {
  if (keys !== undefined && keys.length === 0) return {};
  const where = and(
    eq(fieldRecords.profile_id, profileId),
    isNotNull(fieldRecords.superseded_at),
    ...(keys !== undefined ? [inArray(fieldRecords.field_key, [...keys])] : []),
  );
  const rows = await db
    .select({
      field_key: fieldRecords.field_key,
      value: fieldRecords.value,
      status: fieldRecords.status,
      source: fieldRecords.source,
      observed_at: fieldRecords.observed_at,
      recorded_at: fieldRecords.recorded_at,
      superseded_at: fieldRecords.superseded_at,
      note: fieldRecords.note,
    })
    .from(fieldRecords)
    .where(where)
    .orderBy(desc(fieldRecords.superseded_at))
    .limit(HISTORY_ROW_CAP);
  return groupHistory(rows.map(toSupersededFact).filter((f): f is SupersededFact => f !== null));
}

/** "competitors.<uuid>.name" → the entity prefix and trailing field. */
const ENTITY_KEY =
  /^(offers|competitors|suppliers|channels|staff_roles|locations)\.([0-9a-f-]{36})\.(.+)$/;

/* ── what a gap buys: priority-derived copy, never inference ── */

export function gapBuys(q: Pick<ApplicableQuestion, "priority" | "unlocks">): string {
  const unlockCount = Array.isArray(q.unlocks) ? q.unlocks.length : 0;
  const followUps =
    unlockCount > 0 ? ` and opens ${unlockCount} follow-up${unlockCount === 1 ? "" : "s"}` : "";
  switch (q.priority) {
    case "core":
      return `part of the core set — the diagnosis will not run without it${followUps}`;
    case "important":
      return `sharpens the findings that touch it${followUps}`;
    case "deep":
      return `adds precision once the core picture exists${followUps}`;
    default:
      return `context, when you feel like it${followUps}`;
  }
}

/* ── the read ── */

export async function buildFactSheet(profileId: string): Promise<FactSheet> {
  const summary = await ensureSnapshot(profileId, "manual");
  const [view, completeness, applicable, history] = await Promise.all([
    readSnapshot(summary.id),
    computeCompleteness(profileId),
    applicableQuestions(profileId),
    readSupersededFacts(profileId),
  ]);
  const since = monthStart(new Date());

  const sections = new Map<ProfileSection, FactRow[]>();
  const entities = new Map<string, EntityGroup>();
  const provenance = new Map<string, number>();

  for (const [key, field] of view.facts) {
    const row = toRow(key, field);
    provenance.set(row.source_kind, (provenance.get(row.source_kind) ?? 0) + 1);

    const entity = ENTITY_KEY.exec(key);
    if (entity) {
      const [, spine, id, fieldName] = entity as unknown as [string, string, string, string];
      const groupId = `${spine}.${id}`;
      const group = entities.get(groupId) ?? { id: groupId, spine, name: null, facts: [] };
      group.facts.push({ ...row, key: fieldName });
      if (fieldName === "name" && row.value !== null) group.name = row.value;
      entities.set(groupId, group);
      continue;
    }

    const section = key.split(".")[0] ?? "";
    if (!isProfileSection(section)) continue;
    const rows = sections.get(section) ?? [];
    rows.push(row);
    sections.set(section, rows);
  }

  for (const rows of sections.values()) rows.sort((a, b) => a.key.localeCompare(b.key));
  for (const group of entities.values()) group.facts.sort((a, b) => a.key.localeCompare(b.key));

  // Gaps: applicable questions the snapshot holds no response for. The
  // scorer's definition of "responded" is the one that counts — an
  // explicit unknown is an answer, not a gap (rule 5).
  const respondedKeys = new Set(
    [...view.facts.entries()]
      .filter(
        ([, f]) => f.status === "answered" || f.status === "inferred" || f.status === "unknown",
      )
      .map(([key]) => key),
  );
  const blocking = new Set(completeness.blocking_gaps);
  const gaps: GapRow[] = applicable
    .filter((q) => !respondedKeys.has(q.writes_to))
    .map((q) => ({
      question_id: q.id,
      prompt:
        typeof (q.prompt as { en?: unknown })?.en === "string"
          ? (q.prompt as { en: string }).en
          : q.id,
      section: q.section,
      priority: q.priority,
      buys: gapBuys(q),
      blocking: blocking.has(q.writes_to),
    }))
    .sort(
      (a, b) =>
        PRIORITY_WEIGHTS[b.priority] - PRIORITY_WEIGHTS[a.priority] ||
        a.question_id.localeCompare(b.question_id),
    );

  return {
    profile_id: profileId,
    snapshot_id: summary.id,
    taken_at: summary.taken_at,
    fact_count: summary.fact_count,
    completeness: {
      overall: completeness.overall,
      core_complete: completeness.core_complete,
      by_section: [...completeness.by_section.entries()]
        .map(([section, score]) => ({ section, score }))
        .sort((a, b) => a.section.localeCompare(b.section)),
    },
    provenance: [...provenance.entries()]
      .map(([kind, count]) => ({ kind, count }))
      .sort((a, b) => b.count - a.count),
    sections: [...sections.entries()]
      .map(([section, facts]) => ({ section, facts }))
      .sort((a, b) => a.section.localeCompare(b.section)),
    entities: [...entities.values()].sort((a, b) => a.spine.localeCompare(b.spine)),
    gaps,
    history,
    changed_since: since,
    changed: [...changedSince(history, since)].sort(),
  };
}
