// Day zero — P3-43 (Session J, alert mode).
//
// The moment a business enters SYB's care is the "before" every
// later judgement compares against: where the business stood, what it
// wanted, what it held. It is recorded once, at the first mode decision,
// as a frozen snapshot (rule 3 makes that a list of record ids, not a
// copy) plus a `takeover` entry in the append-only decision log whose
// hash covers the snapshot's content hash — so "this is where you
// started" is a claim anyone can check, months later.

import { createHash } from "node:crypto";
import { and, asc, desc, eq } from "drizzle-orm";
import { db } from "../../db";
import { decisionLog, goals, modeDecisions } from "../../db/schema";
import { takeSnapshot } from "../profile/snapshot";

/** Canonical sha256 of a takeover entry. Key order fixed by construction. */
export function hashTakeoverPayload(payload: {
  profile_id: string;
  decision_id: string;
  snapshot_id: string;
  content_hash: string;
  goal_ids: string[];
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        kind: "takeover",
        profile_id: payload.profile_id,
        decision_id: payload.decision_id,
        snapshot_id: payload.snapshot_id,
        content_hash: payload.content_hash,
        goal_ids: [...payload.goal_ids].sort(),
      }),
    )
    .digest("hex");
}

/**
 * Record day zero for a profile entering care. Idempotent: a profile has
 * exactly one day zero, and a second call returns the first.
 */
export async function recordDayZero(
  profileId: string,
  decisionId: string,
): Promise<{ snapshot_id: string; at: string }> {
  const [existing] = await db
    .select({ ref_id: decisionLog.ref_id, at: decisionLog.at })
    .from(decisionLog)
    .where(and(eq(decisionLog.profile_id, profileId), eq(decisionLog.kind, "takeover")))
    .limit(1);
  if (existing) return { snapshot_id: existing.ref_id, at: existing.at };

  const snapshot = await takeSnapshot(profileId, "day_zero");
  const goalRows = await db
    .select({ id: goals.id })
    .from(goals)
    .where(eq(goals.profile_id, profileId));
  const [entry] = await db
    .insert(decisionLog)
    .values({
      profile_id: profileId,
      actor: "system",
      kind: "takeover",
      ref_id: snapshot.id,
      payload_hash: hashTakeoverPayload({
        profile_id: profileId,
        decision_id: decisionId,
        snapshot_id: snapshot.id,
        content_hash: snapshot.content_hash,
        goal_ids: goalRows.map((g) => g.id),
      }),
    })
    .returning({ at: decisionLog.at });
  return { snapshot_id: snapshot.id, at: entry?.at ?? snapshot.taken_at };
}

export interface CareState {
  /** When care began. */
  day_zero: string;
  /** The frozen "before"; null for profiles that entered care before P3-43. */
  snapshot_id: string | null;
  /** True when a takeover entry exists; false when inferred from the first decision. */
  recorded: boolean;
  /** When the current watching period ends (rule 15); null when not watching. */
  watch_ends_at: string | null;
}

/** Where care began and whether watching mode still holds. Null: never entered care. */
export async function careState(profileId: string): Promise<CareState | null> {
  const [takeover] = await db
    .select({ ref_id: decisionLog.ref_id, at: decisionLog.at })
    .from(decisionLog)
    .where(and(eq(decisionLog.profile_id, profileId), eq(decisionLog.kind, "takeover")))
    .limit(1);
  const [first] = await db
    .select({ decided_at: modeDecisions.decided_at })
    .from(modeDecisions)
    .where(eq(modeDecisions.profile_id, profileId))
    .orderBy(asc(modeDecisions.decided_at))
    .limit(1);
  if (!takeover && !first) return null;
  const [latest] = await db
    .select({ mode: modeDecisions.mode, review_at: modeDecisions.review_at })
    .from(modeDecisions)
    .where(eq(modeDecisions.profile_id, profileId))
    .orderBy(desc(modeDecisions.decided_at))
    .limit(1);
  return {
    day_zero: takeover?.at ?? (first?.decided_at as string),
    snapshot_id: takeover?.ref_id ?? null,
    recorded: takeover !== undefined,
    watch_ends_at: latest?.mode === "watching" ? latest.review_at : null,
  };
}
