// Profile snapshots — P1-01..05 / build-sequence step 37.
//
// A report must be reproducible from the exact state that produced it.
// Without that, "your margin was 23%" stops being falsifiable the moment
// a fact changes, and every report the owner ever received quietly
// rewrites itself behind them.
//
// The storage exploits rule 3 rather than duplicating data: field records
// are immutable and never deleted, so a snapshot records only WHICH
// records were current. The values need no copying and cannot drift.
//
// The content hash is over the facts' CONTENT, never their ids — so
// re-snapshotting an unchanged profile yields the same hash, and one
// changed value changes it. That is what makes a snapshot id a claim
// anyone can check.

import { createHash } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../../db";
import {
  channels,
  competitors,
  costItems,
  customerSegments,
  fieldRecords,
  goals,
  offers,
  profileSnapshots,
  snapshotRecords,
  staffRoles,
  suppliers,
} from "../../db/schema";
import type { Field } from "../core/field";
import type { FieldRecordRow } from "./field-codec";
import { rowToField } from "./field-codec";

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotError";
  }
}

/** Entity spines whose rows are part of a profile's state. */
const SPINES = [
  ["offers", offers],
  ["suppliers", suppliers],
  ["channels", channels],
  ["competitors", competitors],
  ["staff_roles", staffRoles],
  ["cost_items", costItems],
  ["customer_segments", customerSegments],
  ["goals", goals],
] as const;

export interface SnapshotEntity {
  spine: string;
  id: string;
  /** Offers carry a kind; the other spines have none. */
  kind: string | null;
}

/** Why a snapshot was taken. "day_zero" is P3-43: the business entering care. */
export type SnapshotReason = "report" | "watching_weekly" | "manual" | "day_zero";

export interface SnapshotSummary {
  id: string;
  profile_id: string;
  taken_at: string;
  content_hash: string;
  fact_count: number;
  entity_count: number;
  reason: string;
}

/**
 * Canonical hash input: one line per fact, sorted by field key, plus one
 * line per entity. Record ids are deliberately absent — two profiles
 * holding identical facts hash identically, which is what makes this
 * content addressing rather than a checksum over storage.
 */
function contentHash(
  facts: readonly {
    field_key: string;
    value: unknown;
    status: string;
    confidence: string;
    source: unknown;
    observed_at: string;
    note: string | null;
  }[],
  entities: readonly SnapshotEntity[],
): string {
  const factLines = facts
    .map((f) =>
      [
        f.field_key,
        f.status,
        f.confidence,
        JSON.stringify(f.value ?? null),
        JSON.stringify(f.source ?? null),
        f.observed_at,
        f.note ?? "",
      ].join(""),
    )
    .sort();
  const entityLines = entities.map((e) => ["entity", e.spine, e.id, e.kind ?? ""].join("")).sort();
  return createHash("sha256")
    .update([...factLines, ...entityLines].join("\n"))
    .digest("hex");
}

/** Every entity row alive on this profile right now. */
async function liveEntities(profileId: string): Promise<SnapshotEntity[]> {
  const out: SnapshotEntity[] = [];
  for (const [spine, table] of SPINES) {
    if (spine === "offers") {
      const rows = await db
        .select({ id: offers.id, kind: offers.kind })
        .from(offers)
        .where(eq(offers.profile_id, profileId));
      out.push(...rows.map((r) => ({ spine, id: r.id, kind: r.kind as string })));
      continue;
    }
    if (spine === "cost_items") {
      // The fixed/variable bucket is structural (spine column, §5.4), and
      // Session B's break-even needs it — freeze it as the entity kind.
      const rows = await db
        .select({ id: costItems.id, kind: costItems.bucket })
        .from(costItems)
        .where(eq(costItems.profile_id, profileId));
      out.push(...rows.map((r) => ({ spine, id: r.id, kind: r.kind as string })));
      continue;
    }
    const rows = await db
      .select({ id: table.id })
      .from(table)
      .where(eq(table.profile_id, profileId));
    out.push(...rows.map((r) => ({ spine, id: r.id, kind: null })));
  }
  return out;
}

/**
 * The snapshot to render from right now: the latest one if the profile
 * has not moved since it was taken, a fresh one if it has. Content-hash
 * comparison, so a fact sheet viewed twenty times creates one snapshot,
 * not twenty.
 */
export async function ensureSnapshot(
  profileId: string,
  reason: SnapshotReason = "manual",
): Promise<SnapshotSummary> {
  const current = await db
    .select()
    .from(fieldRecords)
    .where(and(eq(fieldRecords.profile_id, profileId), isNull(fieldRecords.superseded_at)));
  const entities = await liveEntities(profileId);
  const hash = contentHash(
    current.map((r) => ({
      field_key: r.field_key,
      value: r.value,
      status: r.status,
      confidence: r.confidence,
      source: r.source,
      observed_at: r.observed_at,
      note: r.note,
    })),
    entities,
  );

  const [latest] = await listSnapshots(profileId);
  if (latest && latest.content_hash === hash) return latest;
  return takeSnapshot(profileId, reason);
}

/**
 * Freeze the profile as it stands. Returns the summary; the snapshot is
 * immutable from here — nothing in this module ever updates one.
 */
export async function takeSnapshot(
  profileId: string,
  reason: SnapshotReason = "manual",
): Promise<SnapshotSummary> {
  const current = await db
    .select()
    .from(fieldRecords)
    .where(and(eq(fieldRecords.profile_id, profileId), isNull(fieldRecords.superseded_at)));
  const entities = await liveEntities(profileId);
  const hash = contentHash(
    current.map((r) => ({
      field_key: r.field_key,
      value: r.value,
      status: r.status,
      confidence: r.confidence,
      source: r.source,
      observed_at: r.observed_at,
      note: r.note,
    })),
    entities,
  );

  const [snapshot] = await db
    .insert(profileSnapshots)
    .values({
      profile_id: profileId,
      content_hash: hash,
      fact_count: current.length,
      entity_count: entities.length,
      reason,
      entities,
    })
    .returning();
  if (!snapshot) throw new SnapshotError("snapshot insert failed");

  if (current.length > 0) {
    await db
      .insert(snapshotRecords)
      .values(current.map((r) => ({ snapshot_id: snapshot.id, record_id: r.id })));
  }

  return {
    id: snapshot.id,
    profile_id: snapshot.profile_id,
    taken_at: snapshot.taken_at,
    content_hash: snapshot.content_hash,
    fact_count: snapshot.fact_count,
    entity_count: snapshot.entity_count,
    reason: snapshot.reason,
  };
}

export interface SnapshotView {
  summary: SnapshotSummary;
  /** field_key → the Field exactly as it stood. */
  facts: Map<string, Field<unknown>>;
  entities: SnapshotEntity[];
}

/**
 * Rebuild the profile view a snapshot captured, ignoring everything
 * written since. This is the read a report renders from.
 */
export async function readSnapshot(snapshotId: string): Promise<SnapshotView> {
  const [snapshot] = await db
    .select()
    .from(profileSnapshots)
    .where(eq(profileSnapshots.id, snapshotId));
  if (!snapshot) throw new SnapshotError(`no snapshot ${snapshotId}`);

  const members = await db
    .select({ record_id: snapshotRecords.record_id })
    .from(snapshotRecords)
    .where(eq(snapshotRecords.snapshot_id, snapshotId));

  const facts = new Map<string, Field<unknown>>();
  if (members.length > 0) {
    const rows = await db
      .select()
      .from(fieldRecords)
      .where(
        inArray(
          fieldRecords.id,
          members.map((m) => m.record_id),
        ),
      );
    for (const row of rows) {
      facts.set(row.field_key, rowToField<unknown>(row as unknown as FieldRecordRow));
    }
  }

  return {
    summary: {
      id: snapshot.id,
      profile_id: snapshot.profile_id,
      taken_at: snapshot.taken_at,
      content_hash: snapshot.content_hash,
      fact_count: snapshot.fact_count,
      entity_count: snapshot.entity_count,
      reason: snapshot.reason,
    },
    facts,
    entities: snapshot.entities as SnapshotEntity[],
  };
}

export interface SnapshotDiff {
  /** Same content on both sides — the profile did not move. */
  identical: boolean;
  added: string[];
  removed: string[];
  changed: {
    field_key: string;
    before: unknown;
    after: unknown;
    before_status: string;
    after_status: string;
  }[];
  entities_added: SnapshotEntity[];
  entities_removed: SnapshotEntity[];
}

/**
 * What moved between two snapshots. The watching module's weekly note is
 * this diff in words; the report's "what changed since" is the same call.
 * `before` is the older snapshot regardless of the argument order.
 */
export async function diffSnapshots(aId: string, bId: string): Promise<SnapshotDiff> {
  const [x, y] = await Promise.all([readSnapshot(aId), readSnapshot(bId)]);
  const [before, after] =
    Date.parse(x.summary.taken_at) <= Date.parse(y.summary.taken_at) ? [x, y] : [y, x];

  const added: string[] = [];
  const removed: string[] = [];
  const changed: SnapshotDiff["changed"] = [];

  for (const [key, field] of after.facts) {
    const was = before.facts.get(key);
    if (!was) {
      added.push(key);
      continue;
    }
    const moved =
      JSON.stringify(was.value ?? null) !== JSON.stringify(field.value ?? null) ||
      was.status !== field.status;
    if (moved) {
      changed.push({
        field_key: key,
        before: was.value,
        after: field.value,
        before_status: was.status,
        after_status: field.status,
      });
    }
  }
  for (const key of before.facts.keys()) {
    if (!after.facts.has(key)) removed.push(key);
  }

  const keyOf = (e: SnapshotEntity) => `${e.spine}:${e.id}`;
  const beforeIds = new Set(before.entities.map(keyOf));
  const afterIds = new Set(after.entities.map(keyOf));

  return {
    identical: before.summary.content_hash === after.summary.content_hash,
    added: added.sort(),
    removed: removed.sort(),
    changed: changed.sort((a, b) => a.field_key.localeCompare(b.field_key)),
    entities_added: after.entities.filter((e) => !beforeIds.has(keyOf(e))),
    entities_removed: before.entities.filter((e) => !afterIds.has(keyOf(e))),
  };
}

/** Snapshots for a profile, newest first. */
export async function listSnapshots(profileId: string): Promise<SnapshotSummary[]> {
  const rows = await db
    .select()
    .from(profileSnapshots)
    .where(eq(profileSnapshots.profile_id, profileId));
  return rows
    .map((r) => ({
      id: r.id,
      profile_id: r.profile_id,
      taken_at: r.taken_at,
      content_hash: r.content_hash,
      fact_count: r.fact_count,
      entity_count: r.entity_count,
      reason: r.reason,
    }))
    .sort((a, b) => Date.parse(b.taken_at) - Date.parse(a.taken_at));
}
