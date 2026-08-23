// Validation engine — P0-78/81 (steps 32-33).
//
// Runs on EVERY field write, never as a batch: field-store calls
// runValidationForWrite after each committed write (dynamic import there
// breaks the module cycle — this module reads back through the store).
// Only rules whose trigger prefixes match the written key re-evaluate,
// so an unrelated write costs nothing.
//
// Lifecycle per rule: firing with no open finding → insert; clean with
// an open finding → auto-resolve; firing while already open → leave the
// original detection in place (first detection is the honest timestamp).
// Resolved findings accumulate as history — the open-uniqueness partial
// index allows the same rule to fire again later.

import { and, eq, isNull, like, sql } from "drizzle-orm";
import { db } from "../../db";
import { fieldRecords, offers, suppliers, validationFindings } from "../../db/schema";
import type { RuleContext } from "./rules";
import { RULES, RULES_VERSION } from "./rules";

const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface FindingResolution {
  resolved_at: string;
  method: "owner_corrected" | "owner_confirmed" | "auto_resolved" | "dismissed";
  note: string | null;
}

function contextFor(profileId: string): RuleContext {
  return {
    async scalar(key) {
      const rows = await db
        .select({ value: fieldRecords.value, status: fieldRecords.status })
        .from(fieldRecords)
        .where(
          and(
            eq(fieldRecords.profile_id, profileId),
            eq(fieldRecords.field_key, key),
            isNull(fieldRecords.superseded_at),
          ),
        );
      const row = rows[0];
      return row && row.status === "answered" ? row.value : null;
    },
    async observedAt(key) {
      const rows = await db
        .select({ observed_at: fieldRecords.observed_at, status: fieldRecords.status })
        .from(fieldRecords)
        .where(
          and(
            eq(fieldRecords.profile_id, profileId),
            eq(fieldRecords.field_key, key),
            isNull(fieldRecords.superseded_at),
          ),
        );
      const row = rows[0];
      return row && row.status === "answered" ? row.observed_at : null;
    },
    async entities(spine) {
      const rows = await db
        .select({ key: fieldRecords.field_key, value: fieldRecords.value })
        .from(fieldRecords)
        .where(
          and(
            eq(fieldRecords.profile_id, profileId),
            like(fieldRecords.field_key, `${spine}.%`),
            isNull(fieldRecords.superseded_at),
            eq(fieldRecords.status, "answered"),
          ),
        );
      const byEntity = new Map<string, Record<string, unknown>>();
      for (const row of rows) {
        // spine.<uuid>.<subKey...> — scalar keys under the same prefix
        // (e.g. costs.gross_margin) have no uuid segment and are skipped.
        const rest = row.key.slice(spine.length + 1);
        const dot = rest.indexOf(".");
        if (dot < 0) continue;
        const entityId = rest.slice(0, dot);
        if (!UUID_SEGMENT.test(entityId)) continue;
        const subKey = rest.slice(dot + 1);
        const bucket = byEntity.get(entityId) ?? {};
        bucket[subKey] = row.value;
        byEntity.set(entityId, bucket);
      }
      return byEntity;
    },
    async entityCount(spine) {
      const table = spine === "offers" ? offers : suppliers;
      const rows = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(table)
        .where(eq(table.profile_id, profileId));
      return rows[0]?.n ?? 0;
    },
    now: () => new Date(),
  };
}

/**
 * Re-evaluate every rule triggered by a write to `fieldKey` and reconcile
 * the open-findings table with the result. Failures are contained — a
 * validation bug must never turn into a failed profile write.
 */
export async function runValidationForWrite(profileId: string, fieldKey: string): Promise<void> {
  const triggered = RULES.filter((r) => r.triggers.some((t) => fieldKey.startsWith(t)));
  if (triggered.length === 0) return;
  const ctx = contextFor(profileId);
  for (const rule of triggered) {
    try {
      const firing = await rule.evaluate(ctx);
      const open = await db
        .select({ id: validationFindings.id })
        .from(validationFindings)
        .where(
          and(
            eq(validationFindings.profile_id, profileId),
            eq(validationFindings.rule_id, rule.id),
            isNull(validationFindings.resolution),
          ),
        );
      if (firing && open.length === 0) {
        await db
          .insert(validationFindings)
          .values({
            profile_id: profileId,
            kind: rule.kind,
            severity: rule.severity,
            field_keys: firing.field_keys,
            rule_id: rule.id,
            rule_version: RULES_VERSION,
            message: { en: firing.message },
          })
          // A racing writer may have inserted the same open finding; the
          // partial unique index arbitrates and losing is fine.
          .onConflictDoNothing();
      } else if (!firing && open.length > 0) {
        const resolution: FindingResolution = {
          resolved_at: new Date().toISOString(),
          method: "auto_resolved",
          note: null,
        };
        await db
          .update(validationFindings)
          .set({ resolution })
          .where(eq(validationFindings.id, open[0]!.id));
      }
    } catch (error) {
      // Contained by design; the write has already committed.
      console.error(
        JSON.stringify({
          msg: "validation rule failed",
          profile_id: profileId,
          rule_id: rule.id,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
}

/** Open findings for a profile, newest first. */
export async function openFindings(profileId: string) {
  return db
    .select()
    .from(validationFindings)
    .where(
      and(eq(validationFindings.profile_id, profileId), isNull(validationFindings.resolution)),
    )
    .orderBy(sql`${validationFindings.detected_at} DESC`);
}

/** Persist a resolution on an open finding (P0-84). */
export async function resolveFinding(
  findingId: string,
  method: FindingResolution["method"],
  note: string | null,
): Promise<void> {
  const resolution: FindingResolution = {
    resolved_at: new Date().toISOString(),
    method,
    note,
  };
  await db
    .update(validationFindings)
    .set({ resolution })
    .where(and(eq(validationFindings.id, findingId), isNull(validationFindings.resolution)));
}
