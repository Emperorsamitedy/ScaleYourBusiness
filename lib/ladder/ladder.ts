// The Trust Ladder — architecture-v2 (D2, D9, I3, I6).
//
// Each business holds a station per capability (an execution provider id):
//   1 BLOCKED · 2 SHADOW · 3 NEEDS_APPROVAL · 4 AUTHORIZED
// No recorded row is station 3 — exactly how SYB worked before the ladder.
// Nothing reaches 4 until the owner defines promotion rules (D2), and rule
// 12 holds at every station: the engine still runs only approved proposals.
//
// The stop (I6) lives with the engine's halt: stopAll runs in the halt's
// own transaction and sets every capability to 1, keeping the station it
// replaced; resumeAll puts them back (D9). Every change is an append-only
// ladder_events row (migration 0098).

import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "../../db";
import type { DbOrTx } from "../../db";
import {
  businessProfiles,
  capabilityStations,
  executionHalts,
  ladderEvents,
} from "../../db/schema";
import { EXECUTION_SCOPE_REGISTRY } from "../execution/scopes";
import { segmentOf } from "../segments/read";
import { segmentStationCeiling } from "../segments/segment";

export type LadderState = "BLOCKED" | "SHADOW" | "NEEDS_APPROVAL" | "AUTHORIZED";
export type Station = 1 | 2 | 3 | 4;

export const STATION_STATE: Readonly<Record<Station, LadderState>> = {
  1: "BLOCKED",
  2: "SHADOW",
  3: "NEEDS_APPROVAL",
  4: "AUTHORIZED",
};

/** D2: no recorded station is today's behaviour — every action waits for the owner's yes. */
export const DEFAULT_STATION: Station = 3;

/** Every capability the stop must reach: each registered execution provider. */
export const CAPABILITIES: readonly string[] = Object.keys(EXECUTION_SCOPE_REGISTRY);

export class LadderError extends Error {
  readonly status: number;
  constructor(message: string, status = 409) {
    super(message);
    this.name = "LadderError";
    this.status = status;
  }
}

function isStation(n: number): n is Station {
  return n === 1 || n === 2 || n === 3 || n === 4;
}

export async function stationOf(
  profileId: string,
  capability: string,
  executor: DbOrTx = db,
): Promise<Station> {
  const [row] = await executor
    .select({ station: capabilityStations.station })
    .from(capabilityStations)
    .where(
      and(
        eq(capabilityStations.profile_id, profileId),
        eq(capabilityStations.capability, capability),
      ),
    );
  const raw = row && isStation(row.station) ? row.station : DEFAULT_STATION;
  // The multi-market spec §C: a sole operation's ceiling holds whatever is
  // stored — no path, the owner's, a partner's or the engine's, passes it.
  const ceiling = segmentStationCeiling((await segmentOf(profileId)).segment);
  return (raw > ceiling ? ceiling : raw) as Station;
}

/** TrustLadder.authorize — step 1 of every agent action. */
export async function authorize(
  profileId: string,
  capability: string,
): Promise<{ state: LadderState; station: Station }> {
  const station = await stationOf(profileId, capability);
  return { state: STATION_STATE[station], station };
}

async function profileHalted(profileId: string): Promise<boolean> {
  const [row] = await db
    .select({ account_id: executionHalts.account_id })
    .from(executionHalts)
    .innerJoin(businessProfiles, eq(businessProfiles.account_id, executionHalts.account_id))
    .where(eq(businessProfiles.id, profileId));
  return row !== undefined;
}

/** Set one capability's station, audited. Never 4 (D2); never while the stop is on (I6). */
export async function setStation(args: {
  profileId: string;
  capability: string;
  station: number;
  by: string | null;
  reason?: string;
}): Promise<void> {
  if (!Number.isInteger(args.station) || !isStation(args.station)) {
    throw new LadderError(`station ${args.station} doesn't exist — stations run 1 to 4`, 422);
  }
  if (args.station === 4) {
    throw new LadderError(
      "promotion rules aren't defined yet, so nothing reaches station 4 (architecture-v2 D2)",
    );
  }
  if (await profileHalted(args.profileId)) {
    throw new LadderError("the emergency stop is on — every station stays at 1 until you resume");
  }
  const segment = (await segmentOf(args.profileId)).segment;
  if (args.station > segmentStationCeiling(segment)) {
    throw new LadderError(
      `a ${segment === "micro_sole" ? "sole trader's" : "business's"} capabilities stay at station ${segmentStationCeiling(segment)} or below`,
      409,
    );
  }
  const station = args.station;
  await db.transaction(async (tx) => {
    const from = await stationOf(args.profileId, args.capability, tx);
    await tx
      .insert(capabilityStations)
      .values({
        profile_id: args.profileId,
        capability: args.capability,
        station,
        updated_by: args.by,
      })
      .onConflictDoUpdate({
        target: [capabilityStations.profile_id, capabilityStations.capability],
        set: { station, updated_by: args.by, updated_at: sql`now()` },
      });
    await tx.insert(ladderEvents).values({
      profile_id: args.profileId,
      capability: args.capability,
      kind: "set",
      from_station: from,
      to_station: station,
      by: args.by,
      reason: args.reason ?? null,
    });
  });
}

/**
 * I6: every capability of these businesses to station 1, in the caller's
 * transaction (the halt's), keeping the station each one replaced. A second
 * press keeps the first press's record, so a resume still restores it.
 */
export async function stopAll(
  executor: DbOrTx,
  args: { profileIds: readonly string[]; by: string | null; reason?: string | null },
): Promise<void> {
  for (const profileId of args.profileIds) {
    const current = await executor
      .select()
      .from(capabilityStations)
      .where(eq(capabilityStations.profile_id, profileId));
    const held = new Map(current.map((r) => [r.capability, r]));
    await executor
      .insert(capabilityStations)
      .values(
        CAPABILITIES.map((capability) => ({
          profile_id: profileId,
          capability,
          station: 1,
          pre_stop_station: DEFAULT_STATION,
          updated_by: args.by,
        })),
      )
      .onConflictDoUpdate({
        target: [capabilityStations.profile_id, capabilityStations.capability],
        set: {
          station: 1,
          pre_stop_station: sql`coalesce(${capabilityStations.pre_stop_station}, ${capabilityStations.station})`,
          updated_by: args.by,
          updated_at: sql`now()`,
        },
      });
    const moved = CAPABILITIES.filter((c) => (held.get(c)?.station ?? DEFAULT_STATION) !== 1);
    if (moved.length > 0) {
      await executor.insert(ladderEvents).values(
        moved.map((capability) => ({
          profile_id: profileId,
          capability,
          kind: "stop" as const,
          from_station: held.get(capability)?.station ?? DEFAULT_STATION,
          to_station: 1,
          by: args.by,
          reason: args.reason ?? null,
        })),
      );
    }
  }
}

/** D9: the stop's release puts back each station it replaced. */
export async function resumeAll(
  executor: DbOrTx,
  args: { profileIds: readonly string[]; by: string | null },
): Promise<void> {
  if (args.profileIds.length === 0) return;
  const restored = await executor
    .update(capabilityStations)
    .set({
      station: sql`${capabilityStations.pre_stop_station}`,
      pre_stop_station: null,
      updated_by: args.by,
      updated_at: sql`now()`,
    })
    .where(
      and(
        inArray(capabilityStations.profile_id, [...args.profileIds]),
        isNotNull(capabilityStations.pre_stop_station),
      ),
    )
    .returning();
  if (restored.length > 0) {
    await executor.insert(ladderEvents).values(
      restored.map((r) => ({
        profile_id: r.profile_id,
        capability: r.capability,
        kind: "resume" as const,
        from_station: 1,
        to_station: r.station,
        by: args.by,
      })),
    );
  }
}

export interface LadderOutcome {
  /** The ledger entry's verdict (the v1 spec §3.2); absent on Session A outcomes. */
  verdict?: "verified_gain" | "no_effect" | "loss" | "inconclusive";
  verified: boolean;
  /** Net of the action's cost, signed, integer minor units. */
  euro_minor: number | null;
  currency: string | null;
  grade: string | null;
  /** A shadow plan's outcome: what would have happened. Nothing ran. */
  shadow?: boolean;
}

/** TrustLadder.record_outcome — step 6, from a closed measurement. */
export async function recordOutcome(args: {
  profileId: string;
  capability: string;
  measurementId: string;
  outcome: LadderOutcome;
}): Promise<void> {
  await db.insert(ladderEvents).values({
    profile_id: args.profileId,
    capability: args.capability,
    kind: "outcome",
    measurement_id: args.measurementId,
    outcome: args.outcome,
  });
}

/**
 * Promotion eligibility. D2: the owner hasn't defined promotion rules, so
 * the answer is no — with the outcome counts a rule will read.
 */
export async function promotionEligibility(
  profileId: string,
  capability: string,
): Promise<{ eligible: false; reason: string; outcomes: { total: number; verified: number } }> {
  const rows = await db
    .select({ outcome: ladderEvents.outcome })
    .from(ladderEvents)
    .where(
      and(
        eq(ladderEvents.profile_id, profileId),
        eq(ladderEvents.capability, capability),
        eq(ladderEvents.kind, "outcome"),
      ),
    );
  const verified = rows.filter(
    (r) => (r.outcome as LadderOutcome | null)?.verified === true,
  ).length;
  return {
    eligible: false,
    reason:
      "promotion rules aren't defined yet, so no capability is eligible for station 4 (architecture-v2 D2)",
    outcomes: { total: rows.length, verified },
  };
}
