// Stated vs measured — rule 11, P2-11, extended to per-offer volume (P2-16).
//
// "You estimated $8,300 a month; Stripe measured $6,910." When a connector
// supersedes an owner's figure, the report shows both rather than silently
// swapping. The pair is found by walking the supersession chain backwards
// from the record a SNAPSHOT froze, past any earlier measurements, to the
// last thing a person said. History rows are immutable and never deleted
// (rule 3), so the answer is as reproducible as the report itself: a
// year-old report finds the same estimate it found on the day.

import { and, eq, inArray, like, or } from "drizzle-orm";
import { db } from "../../db";
import { fieldRecords, profileSnapshots, snapshotRecords } from "../../db/schema";
import { COST_PER_PURCHASE_KEY, DERIVATIONS, ENTITY_MEASURE_KEY } from "./derive";
import type { StatedVsMeasured } from "./measured";
import { displaySourceKind, isMeasuredSource, measuredProvider } from "./measured";
import { BOOKING_STATED_KEYS } from "../bookings/store";
import { NON_CONNECTOR_SOURCE_LABELS } from "../bookings/source";
import { getProvider } from "./registry";
import { isProviderId } from "./scopes";

const round1 = (n: number): number => Math.round(n * 10) / 10;

function asMoney(v: unknown): { amount_minor: number; currency: string } | null {
  if (v === null || typeof v !== "object") return null;
  const m = v as { amount_minor?: unknown; currency?: unknown };
  return typeof m.amount_minor === "number" && typeof m.currency === "string"
    ? { amount_minor: m.amount_minor, currency: m.currency }
    : null;
}

/** measured − stated, or null when the two cannot honestly be compared. */
export function measuredDelta(stated: unknown, measured: unknown): StatedVsMeasured["delta"] {
  if (
    typeof stated === "number" &&
    typeof measured === "number" &&
    Number.isFinite(stated) &&
    Number.isFinite(measured)
  ) {
    return {
      amount: measured - stated,
      currency: null,
      pct: stated === 0 ? null : round1(((measured - stated) / stated) * 100),
    };
  }
  const s = asMoney(stated);
  const m = asMoney(measured);
  // Two currencies is a refusal, not a conversion (rule 1).
  if (!s || !m || s.currency !== m.currency) return null;
  const amount = m.amount_minor - s.amount_minor;
  return {
    amount,
    currency: m.currency,
    pct: s.amount_minor === 0 ? null : round1((amount / s.amount_minor) * 100),
  };
}

const toIso = (timestamp: string): string => new Date(timestamp).toISOString();

/**
 * Every measured fact in the snapshot that replaced something the owner
 * said, paired with that statement: business-wide figures first, in
 * derivation order, then per-offer volumes. Facts a connector wrote into an
 * empty field have no pair and are left out.
 */
export async function statedVsMeasured(snapshotId: string): Promise<StatedVsMeasured[]> {
  const [snapshot] = await db
    .select({ profile_id: profileSnapshots.profile_id })
    .from(profileSnapshots)
    .where(eq(profileSnapshots.id, snapshotId));
  if (!snapshot) return [];

  const businessKeys = [
    ...DERIVATIONS.map((d) => d.field_key),
    COST_PER_PURCHASE_KEY,
    // Bookings (specs/bookings.md §4): the owner's words on no-shows and
    // their repeat-customer estimate, against the booking system.
    ...BOOKING_STATED_KEYS,
  ];
  const frozen = await db
    .select({
      id: fieldRecords.id,
      field_key: fieldRecords.field_key,
      value: fieldRecords.value,
      source: fieldRecords.source,
      observed_at: fieldRecords.observed_at,
    })
    .from(snapshotRecords)
    .innerJoin(fieldRecords, eq(fieldRecords.id, snapshotRecords.record_id))
    .where(
      and(
        eq(snapshotRecords.snapshot_id, snapshotId),
        or(
          inArray(fieldRecords.field_key, businessKeys),
          like(fieldRecords.field_key, "offers.%.volume_period"),
          like(fieldRecords.field_key, "channels.%.monthly_sessions"),
        ),
      ),
    );

  const volumeKeys = frozen
    .map((r) => r.field_key)
    .filter((key) => ENTITY_MEASURE_KEY.test(key))
    .sort();

  const out: StatedVsMeasured[] = [];
  for (const key of [...businessKeys, ...volumeKeys]) {
    const current = frozen.find((r) => r.field_key === key);
    if (!current || !isMeasuredSource(current.source)) continue;

    const history = await db
      .select({
        id: fieldRecords.id,
        value: fieldRecords.value,
        status: fieldRecords.status,
        source: fieldRecords.source,
        observed_at: fieldRecords.observed_at,
        note: fieldRecords.note,
        superseded_by: fieldRecords.superseded_by,
      })
      .from(fieldRecords)
      .where(
        and(eq(fieldRecords.profile_id, snapshot.profile_id), eq(fieldRecords.field_key, key)),
      );

    type HistoryRow = (typeof history)[number];
    const predecessorOf = new Map<string, HistoryRow>();
    for (const row of history) {
      if (row.superseded_by !== null) predecessorOf.set(row.superseded_by, row);
    }

    let stated: HistoryRow | null = null;
    let at = current.id;
    const seen = new Set<string>();
    while (!seen.has(at)) {
      seen.add(at);
      const previous = predecessorOf.get(at);
      if (previous === undefined) break;
      if (!isMeasuredSource(previous.source)) {
        stated = previous;
        break;
      }
      at = previous.id;
    }
    if (stated === null) continue;

    const providerId = measuredProvider(current.source);
    const method = (current.source as { method?: unknown } | null)?.method;
    out.push({
      field_key: key,
      provider:
        providerId !== null && isProviderId(providerId)
          ? getProvider(providerId).label
          : (NON_CONNECTOR_SOURCE_LABELS[providerId ?? ""] ?? providerId ?? "a connector"),
      stated: {
        value: stated.value,
        status: stated.status,
        source_kind: displaySourceKind(stated.source),
        observed_at: toIso(stated.observed_at),
        note: stated.note,
      },
      measured: {
        value: current.value,
        method: typeof method === "string" ? method : "",
        observed_at: toIso(current.observed_at),
      },
      delta: stated.value === null ? null : measuredDelta(stated.value, current.value),
    });
  }
  return out;
}
