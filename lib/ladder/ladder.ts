// The Trust Ladder — architecture-v2 (D2, D9, I3, I6), completed by the v1
// build spec §4 (Phase 2): new businesses start in shadow for 30 days, a
// station is raised only on the ledger's evidence (./promotion.ts), station
// 4 acts within the owner's caps (./caps.ts), two consecutive losses demote
// one station with the owner told, and a station never passes the business's
// segment ceiling or, once payments are armed, its tier's (D49).
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

import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "../../db";
import type { DbOrTx } from "../../db";
import {
  businessProfiles,
  capabilityStations,
  executionHalts,
  ladderEvents,
  ownerNotices,
  subscriptions,
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

/** The v1 spec §4.2: a new business's first days, every capability in shadow. */
export const NEW_BUSINESS_SHADOW_DAYS = 30;

/** Start a business's shadow period (D35: called where its intake starts in the app). */
export async function startShadowPeriod(profileId: string, now: Date = new Date()): Promise<void> {
  await db
    .update(businessProfiles)
    .set({
      shadow_until: new Date(now.getTime() + NEW_BUSINESS_SHADOW_DAYS * 86_400_000).toISOString(),
    })
    .where(eq(businessProfiles.id, profileId));
}

/** The tier's ladder ceiling (v1 spec §8.3), enforced only once payments are armed (D19). */
export const TIER_CEILING: Readonly<Record<string, Station>> = {
  watch: 2,
  act: 3,
  autonomous: 4,
};

function paymentsArmed(): boolean {
  return typeof process.env.STRIPE_SECRET_KEY === "string" && process.env.STRIPE_SECRET_KEY !== "";
}

async function tierCeiling(profileId: string): Promise<Station> {
  if (!paymentsArmed()) return 4;
  const [sub] = await db
    .select({ tier: subscriptions.tier, parent: subscriptions.parent_subscription_id })
    .from(subscriptions)
    .where(and(eq(subscriptions.profile_id, profileId), eq(subscriptions.status, "active")))
    .limit(1);
  // No subscription: the station-3 behaviour every business had before (D18, D49).
  if (!sub) return 3;
  // §8.3: an extra business is on its parent's tier; with no live parent, Watch's.
  if (sub.tier === "extra_business") {
    if (!sub.parent) return TIER_CEILING.watch!;
    const [parent] = await db
      .select({ tier: subscriptions.tier })
      .from(subscriptions)
      .where(and(eq(subscriptions.id, sub.parent), eq(subscriptions.status, "active")));
    return parent ? (TIER_CEILING[parent.tier] ?? TIER_CEILING.watch!) : TIER_CEILING.watch!;
  }
  return TIER_CEILING[sub.tier] ?? 3;
}

/** Every ceiling over this business: its segment's and its tier's. */
export async function stationCeiling(profileId: string): Promise<Station> {
  const segment = segmentStationCeiling((await segmentOf(profileId)).segment);
  const tier = await tierCeiling(profileId);
  return (segment < tier ? segment : tier) as Station;
}

export async function stationOf(
  profileId: string,
  capability: string,
  executor: DbOrTx = db,
  now: Date = new Date(),
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
  let raw: Station;
  if (row && isStation(row.station)) {
    raw = row.station;
  } else {
    const [p] = await executor
      .select({ shadow_until: businessProfiles.shadow_until })
      .from(businessProfiles)
      .where(eq(businessProfiles.id, profileId));
    raw = p?.shadow_until && Date.parse(p.shadow_until) > now.getTime() ? 2 : DEFAULT_STATION;
  }
  // The multi-market spec §C and the tier (D49): ceilings hold whatever is
  // stored — no path, the owner's, a partner's or the engine's, passes them.
  const ceiling = await stationCeiling(profileId);
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

/**
 * The ladder's one writer, audited. Never while the stop is on (I6), never
 * past the business's ceiling. Callers that RAISE a station come through
 * ./promotion.ts, which checks the ledger's evidence first; the public
 * setStation below only lowers.
 */
export async function setStationUnchecked(args: {
  profileId: string;
  capability: string;
  station: number;
  by: string | null;
  reason?: string;
  kind?: "set" | "auto_demotion" | "connector_demotion";
}): Promise<void> {
  if (!Number.isInteger(args.station) || !isStation(args.station)) {
    throw new LadderError(`station ${args.station} doesn't exist — stations run 1 to 4`, 422);
  }
  if (args.station > 1 && (await profileHalted(args.profileId))) {
    throw new LadderError("the emergency stop is on — every station stays at 1 until you resume");
  }
  const ceiling = await stationCeiling(args.profileId);
  if (args.station > ceiling) {
    throw new LadderError(await ceilingWords(args.profileId, ceiling), 409);
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
      kind: args.kind ?? "set",
      from_station: from,
      to_station: station,
      by: args.by,
      reason: args.reason ?? null,
    });
  });
}

async function ceilingWords(profileId: string, ceiling: number): Promise<string> {
  const segment = (await segmentOf(profileId)).segment;
  return `a ${segment === "micro_sole" ? "sole trader's" : "business's"} capabilities stay at station ${ceiling} or below`;
}

/**
 * Set one capability's station — LOWERING only, or keeping it. A raise needs
 * the ledger's evidence (v1 spec §4.3) and goes through changeStation /
 * requestPromotion in ./promotion.ts; the API refuses it here even if a UI
 * is bypassed.
 */
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
  if (await profileHalted(args.profileId)) {
    throw new LadderError("the emergency stop is on — every station stays at 1 until you resume");
  }
  const current = await stationOf(args.profileId, args.capability);
  if (args.station > current) {
    const ceiling = await stationCeiling(args.profileId);
    if (args.station > ceiling)
      throw new LadderError(await ceilingWords(args.profileId, ceiling), 409);
    throw new LadderError(
      args.station === 4
        ? "station 4 needs its limits and a separate confirmation, on the ledger's evidence"
        : "a station is raised only on the ledger's evidence — ask for the promotion",
      409,
    );
  }
  await setStationUnchecked({ ...args, reason: args.reason ?? "lowered by the owner" });
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
    // What each capability stood at, the shadow period and ceilings included,
    // so a resume restores exactly that (D9).
    const effective = new Map<string, Station>();
    for (const capability of CAPABILITIES) {
      const stored = held.get(capability);
      effective.set(
        capability,
        stored && isStation(stored.station)
          ? stored.station
          : await stationOf(profileId, capability, executor),
      );
    }
    await executor
      .insert(capabilityStations)
      .values(
        CAPABILITIES.map((capability) => ({
          profile_id: profileId,
          capability,
          station: 1,
          pre_stop_station: effective.get(capability) ?? DEFAULT_STATION,
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
    const moved = CAPABILITIES.filter((c) => (effective.get(c) ?? DEFAULT_STATION) !== 1);
    if (moved.length > 0) {
      await executor.insert(ladderEvents).values(
        moved.map((capability) => ({
          profile_id: profileId,
          capability,
          kind: "stop" as const,
          from_station: effective.get(capability) ?? DEFAULT_STATION,
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
  /** The ledger entry that scored it (the v1 spec §3.2), for the owner's notice. */
  entry_id?: string;
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

/** The v1 spec §4.3: this many consecutive loss verdicts drop a capability one station. */
export const AUTO_DEMOTE_AFTER_LOSSES = 2;

/**
 * TrustLadder.record_outcome — step 6, from a closed measurement. Then the
 * v1 spec §4.3's auto-demotion (D37): when the last two outcomes recorded
 * since the capability's last station change are both losses, it drops one
 * station, and the owner is told with both entries attached — never silently.
 */
export async function recordOutcome(args: {
  profileId: string;
  capability: string;
  measurementId: string;
  outcome: LadderOutcome;
}): Promise<{ demoted: { from: Station; to: Station } | null }> {
  await db.insert(ladderEvents).values({
    profile_id: args.profileId,
    capability: args.capability,
    kind: "outcome",
    measurement_id: args.measurementId,
    outcome: args.outcome,
  });
  if (args.outcome.verdict !== "loss") return { demoted: null };

  const events = await db
    .select()
    .from(ladderEvents)
    .where(
      and(
        eq(ladderEvents.profile_id, args.profileId),
        eq(ladderEvents.capability, args.capability),
      ),
    )
    .orderBy(desc(ladderEvents.at), desc(ladderEvents.id));
  const since: (typeof events)[number][] = [];
  for (const e of events) {
    if (e.kind !== "outcome") break; // the last station change ends the run
    since.push(e);
  }
  const lastTwo = since.slice(0, AUTO_DEMOTE_AFTER_LOSSES);
  const losses = lastTwo.filter((e) => (e.outcome as LadderOutcome | null)?.verdict === "loss");
  if (losses.length < AUTO_DEMOTE_AFTER_LOSSES) return { demoted: null };

  const from = await stationOf(args.profileId, args.capability);
  if (from <= 1) return { demoted: null };
  const to = (from - 1) as Station;
  await setStationUnchecked({
    profileId: args.profileId,
    capability: args.capability,
    station: to,
    by: null,
    reason: `two consecutive losses (${losses.map((e) => e.measurement_id).join(", ")})`,
    kind: "auto_demotion",
  });
  await db.insert(ownerNotices).values({
    profile_id: args.profileId,
    kind: "auto_demotion",
    payload: {
      capability: args.capability,
      from,
      to,
      plan_ids: losses.map((e) => e.measurement_id),
      entry_ids: losses.map((e) => (e.outcome as LadderOutcome | null)?.entry_id ?? null),
    },
  });
  return { demoted: { from, to } };
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
      "superseded by the v1 spec §4.3: ask lib/ladder/promotion.ts eligibility() for a capability's evidence",
    outcomes: { total: rows.length, verified },
  };
}
