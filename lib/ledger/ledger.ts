// The Proof Ledger, Session A's cut — architecture-v2 (hard rules 1–3, I1,
// I2, D10–D12). SUPERSEDED on 2026-11-10 by the v1 build spec §3: the engine
// now writes measurement_plans and ledger_entries (./plans, ./close,
// ./chain, ./counter). This module and its proof_ledger table are kept as
// they were, not deleted; nothing in the product writes here any more.
//
// Every agent action gets a measurement plan BEFORE it runs
// (openMeasurement), and the engine refuses to run without one
// (requireOpen). At the window's end the plan is closed with a score in
// money — or unscored, with the reason — and a later re-score is a
// correction row naming the close. Nothing here updates or deletes: the
// table's trigger (migration 0098) refuses both, so the ledger can't be
// rewritten even by code that tries.
//
// A plan's own id is its measurement_id, and its state is read from the
// rows: open exactly while no close names it.

import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import { db } from "../../db";
import { proofLedger } from "../../db/schema";
import type { Confidence } from "../core/confidence";
import type { Grade } from "../core/grade";
import { derivedGrade } from "../core/grade";
import type { Money } from "../core/money";
import { money } from "../core/money";

/** D12: the window when a capability's measurer names no other. */
export const DEFAULT_WINDOW_DAYS = 28;

export type LedgerEntry = typeof proofLedger.$inferSelect;

export class LedgerError extends Error {
  readonly status: number;
  constructor(message: string, status = 409) {
    super(message);
    this.name = "LedgerError";
    this.status = status;
  }
}

/** A scored result. Its grade is the weakest input's (hard rule 3). */
export interface ScoreResult {
  euro: Money;
  inputs: readonly Confidence[];
  against: "holdout" | "before_after" | "none";
}

export type CloseResult = ScoreResult | { unscored: string };

export type Measurer = (plan: LedgerEntry) => Promise<CloseResult>;

function hashOf(entry: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(entry)).digest("hex");
}

function scoreFields(result: CloseResult): {
  euro_minor: number | null;
  currency: string | null;
  grade: Grade | null;
  scored_against: string | null;
  verified: boolean;
  note: string | null;
} {
  if ("unscored" in result) {
    return {
      euro_minor: null,
      currency: null,
      grade: null,
      scored_against: null,
      verified: false,
      note: result.unscored,
    };
  }
  const grade = derivedGrade(result.inputs);
  return {
    euro_minor: result.euro.amount_minor,
    currency: result.euro.currency,
    grade,
    scored_against: result.against,
    // D10: a holdout comparison graded A or B — nothing weaker is "verified".
    verified: result.against === "holdout" && (grade === "A" || grade === "B"),
    note: null,
  };
}

async function planRow(measurementId: string): Promise<LedgerEntry | null> {
  const [row] = await db
    .select()
    .from(proofLedger)
    .where(and(eq(proofLedger.id, measurementId), eq(proofLedger.kind, "plan")));
  return row ?? null;
}

async function closeRow(measurementId: string): Promise<LedgerEntry | null> {
  const [row] = await db
    .select()
    .from(proofLedger)
    .where(and(eq(proofLedger.measurement_id, measurementId), eq(proofLedger.kind, "close")));
  return row ?? null;
}

/**
 * ProofLedger.open_measurement — written before execution. One plan per
 * proposal: a retried execution reads the plan it already has.
 */
export async function openMeasurement(args: {
  profileId: string;
  accountId: string;
  capability: string;
  metric: string;
  /** How the action's effect will be told apart from everything else, or null. */
  holdout: string | null;
  proposalId?: string;
  windowDays?: number;
  now?: Date;
}): Promise<{ measurement_id: string; window_ends_at: string; reused: boolean }> {
  if (args.proposalId) {
    const [existing] = await db
      .select()
      .from(proofLedger)
      .where(and(eq(proofLedger.proposal_id, args.proposalId), eq(proofLedger.kind, "plan")));
    if (existing) {
      return {
        measurement_id: existing.id,
        window_ends_at: new Date(existing.window_ends_at!).toISOString(),
        reused: true,
      };
    }
  }
  const now = args.now ?? new Date();
  const windowDays = args.windowDays ?? DEFAULT_WINDOW_DAYS;
  const windowEnds = new Date(now.getTime() + windowDays * 86_400_000).toISOString();
  const id = randomUUID();
  const plan = { metric: args.metric, holdout: args.holdout, window_days: windowDays };
  const [row] = await db
    .insert(proofLedger)
    .values({
      id,
      profile_id: args.profileId,
      account_id: args.accountId,
      kind: "plan",
      measurement_id: id,
      proposal_id: args.proposalId ?? null,
      capability: args.capability,
      at: now.toISOString(),
      window_ends_at: windowEnds,
      plan,
      payload_hash: hashOf({ kind: "plan", id, capability: args.capability, plan, windowEnds }),
    })
    .onConflictDoNothing()
    .returning();
  if (row) return { measurement_id: row.id, window_ends_at: windowEnds, reused: false };
  // Two runs opened at once: the unique index kept one, and this one reads it.
  return openMeasurement(args);
}

export async function isOpen(measurementId: string): Promise<boolean> {
  return (await planRow(measurementId)) !== null && (await closeRow(measurementId)) === null;
}

/** Execution without an open plan is a hard error (hard rule 1). */
export async function requireOpen(measurementId: string): Promise<void> {
  if (!(await isOpen(measurementId))) {
    throw new LedgerError(
      "there is no open measurement plan for this action: nothing runs without one",
    );
  }
}

/** SHADOW (step 4): what would have been done is recorded against the plan, once. */
export async function recordCounterfactual(measurementId: string, note: string): Promise<void> {
  const plan = await planRow(measurementId);
  if (!plan) throw new LedgerError("a counterfactual needs its measurement plan", 404);
  await db
    .insert(proofLedger)
    .values({
      id: randomUUID(),
      profile_id: plan.profile_id,
      account_id: plan.account_id,
      kind: "counterfactual",
      measurement_id: measurementId,
      proposal_id: plan.proposal_id,
      capability: plan.capability,
      note,
      payload_hash: hashOf({ kind: "counterfactual", measurementId, note }),
    })
    .onConflictDoNothing();
}

/** ProofLedger.close_measurement — the score, or unscored with the reason. Once. */
export async function closeMeasurement(
  measurementId: string,
  result: CloseResult,
  now: Date = new Date(),
): Promise<LedgerEntry> {
  const plan = await planRow(measurementId);
  if (!plan) throw new LedgerError("no measurement plan by that id", 404);
  const fields = scoreFields(result);
  const [row] = await db
    .insert(proofLedger)
    .values({
      id: randomUUID(),
      profile_id: plan.profile_id,
      account_id: plan.account_id,
      kind: "close",
      measurement_id: measurementId,
      proposal_id: plan.proposal_id,
      capability: plan.capability,
      at: now.toISOString(),
      ...fields,
      payload_hash: hashOf({ kind: "close", measurementId, ...fields }),
    })
    .onConflictDoNothing()
    .returning();
  if (!row) throw new LedgerError("this measurement is already closed");
  return row;
}

/** A re-score: a NEW entry naming the close (or correction) it replaces (I2). */
export async function correctMeasurement(
  entryId: string,
  args: { result: CloseResult; reason: string; now?: Date },
): Promise<LedgerEntry> {
  const [original] = await db.select().from(proofLedger).where(eq(proofLedger.id, entryId));
  if (!original || (original.kind !== "close" && original.kind !== "correction")) {
    throw new LedgerError("only a closed measurement's score can be corrected", 404);
  }
  const fields = scoreFields(args.result);
  const [row] = await db
    .insert(proofLedger)
    .values({
      id: randomUUID(),
      profile_id: original.profile_id,
      account_id: original.account_id,
      kind: "correction",
      measurement_id: original.measurement_id,
      proposal_id: original.proposal_id,
      capability: original.capability,
      at: (args.now ?? new Date()).toISOString(),
      ...fields,
      corrects_id: original.id,
      note: args.reason,
      payload_hash: hashOf({
        kind: "correction",
        corrects: original.id,
        reason: args.reason,
        ...fields,
      }),
    })
    .returning();
  return row!;
}

/**
 * The business's verified-euro counter (D10): per measurement, its latest
 * score (a correction replaces what it names); the verified ones summed per
 * currency, never converted (rule 1).
 */
export async function verifiedEuro(profileId: string): Promise<Money[]> {
  const rows = await db
    .select()
    .from(proofLedger)
    .where(
      and(
        eq(proofLedger.profile_id, profileId),
        inArray(proofLedger.kind, ["close", "correction"]),
      ),
    )
    .orderBy(asc(proofLedger.at));
  const latest = new Map<string, LedgerEntry>();
  for (const r of rows) {
    const held = latest.get(r.measurement_id);
    // A correction always supersedes the close it follows, even at the same instant.
    if (!held || r.kind === "correction" || held.kind !== "correction")
      latest.set(r.measurement_id, r);
  }
  const totals = new Map<string, number>();
  for (const r of latest.values()) {
    if (!r.verified || r.euro_minor === null || r.currency === null) continue;
    totals.set(r.currency, (totals.get(r.currency) ?? 0) + r.euro_minor);
  }
  return [...totals].map(([currency, amount]) => money(amount, currency));
}

/** Plans whose window has ended and that no close names yet. */
export async function dueMeasurements(now: Date, only?: readonly string[]): Promise<LedgerEntry[]> {
  const closes = db
    .select({ measurement_id: proofLedger.measurement_id })
    .from(proofLedger)
    .where(eq(proofLedger.kind, "close"));
  return db
    .select()
    .from(proofLedger)
    .where(
      and(
        eq(proofLedger.kind, "plan"),
        lte(proofLedger.window_ends_at, now.toISOString()),
        sql`${proofLedger.id} not in (${closes})`,
        only ? inArray(proofLedger.id, [...only]) : undefined,
      ),
    )
    .orderBy(asc(proofLedger.window_ends_at));
}

/**
 * ProofLedger.close_measurement at window end, for every due plan (D11):
 * through its capability's measurer, or unscored with the reason when the
 * capability has none yet. A measurer that throws leaves its plan open for
 * the next run rather than closing it with a guess.
 */
export async function closeDueMeasurements(args: {
  now?: Date;
  measurers: Readonly<Record<string, Measurer>>;
  /** Step 6: TrustLadder.record_outcome, for each close. */
  onClosed?: (entry: LedgerEntry) => Promise<void>;
  /** Restrict to these plans (tests share one database). */
  only?: readonly string[];
}): Promise<{ closed: number; left_open: number }> {
  const now = args.now ?? new Date();
  let closed = 0;
  let leftOpen = 0;
  for (const plan of await dueMeasurements(now, args.only)) {
    const measurer = args.measurers[plan.capability];
    let result: CloseResult;
    try {
      result = measurer
        ? await measurer(plan)
        : { unscored: `no measurer for ${plan.capability} yet` };
    } catch (error) {
      leftOpen += 1;
      console.error(
        JSON.stringify({
          event: "measurement_measurer_failed",
          account_id: plan.account_id,
          measurement_id: plan.id,
          capability: plan.capability,
          name: error instanceof Error ? error.name : "unknown",
        }),
      );
      continue;
    }
    let entry: LedgerEntry;
    try {
      entry = await closeMeasurement(plan.id, result, now);
    } catch (error) {
      if (error instanceof LedgerError) continue; // another run closed it first
      throw error;
    }
    closed += 1;
    await args.onClosed?.(entry);
  }
  return { closed, left_open: leftOpen };
}
