// Mode decision service — Session H (P1-42/44). Persists rulings with
// their exact inputs, serves the latest, and enforces the asymmetric
// override: extending the watch is one click; shortening requires an
// acknowledgement that is stored with the user id and timestamp.

import { desc, eq } from "drizzle-orm";
import { db } from "../../db";
import { modeDecisions, watchActivity } from "../../db/schema";
import { assembleInputs } from "./inputs";
import type { DeferredRuling, ModeRuling } from "./decide";
import { decideMode } from "./decide";

export class ModeError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "ModeError";
    this.status = status;
  }
}

export interface OwnerOverride {
  kind: "extend" | "shorten";
  from_weeks: number;
  to_weeks: number;
  at: string;
  /** Required for shorten: who acknowledged the risk, and when. */
  acknowledgement: { user_id: string; text: string; at: string } | null;
}

export interface ModeDecisionRow {
  id: string;
  profile_id: string;
  mode: "instant" | "watching";
  watch_weeks: number | null;
  decided_at: string;
  inputs: unknown;
  reasons: string[];
  reasoning: string;
  confidence: number;
  owner_override: OwnerOverride | null;
  review_at: string;
}

function toRow(r: typeof modeDecisions.$inferSelect): ModeDecisionRow {
  const stored = r.inputs as { reasons?: string[] };
  return {
    id: r.id,
    profile_id: r.profile_id,
    mode: r.mode,
    watch_weeks: r.watch_weeks,
    decided_at: r.decided_at,
    inputs: r.inputs,
    reasons: Array.isArray(stored.reasons) ? stored.reasons : [],
    reasoning: r.reasoning,
    confidence: Number(r.confidence),
    owner_override: (r.owner_override as OwnerOverride | null) ?? null,
    review_at: r.review_at,
  };
}

export async function latestDecision(profileId: string): Promise<ModeDecisionRow | null> {
  const [row] = await db
    .select()
    .from(modeDecisions)
    .where(eq(modeDecisions.profile_id, profileId))
    .orderBy(desc(modeDecisions.decided_at))
    .limit(1);
  return row ? toRow(row) : null;
}

export type DecisionOutcome =
  | { kind: "decided"; decision: ModeDecisionRow }
  | { kind: "deferred"; reasoning: string; completeness: number };

/**
 * Decide (or re-decide) the mode from the profile's current state.
 * Repeat calls append — a decision is a dated fact, and a profile that
 * changed deserves a fresh ruling with fresh inputs on record.
 */
export async function decideForProfile(profileId: string): Promise<DecisionOutcome> {
  const { inputs, ad_spend_minor } = await assembleInputs(profileId);
  const ruling = decideMode(inputs, ad_spend_minor);

  if ("deferred" in ruling) {
    const deferred: DeferredRuling = ruling;
    return { kind: "deferred", reasoning: deferred.reasoning, completeness: deferred.completeness };
  }

  const decided: ModeRuling = ruling;
  const now = Date.now();
  const reviewAt = new Date(
    now + (decided.watch_weeks ?? 1) * 7 * 86_400_000,
  ).toISOString();

  const [row] = await db
    .insert(modeDecisions)
    .values({
      profile_id: profileId,
      mode: decided.mode,
      watch_weeks: decided.watch_weeks,
      inputs: { ...inputs, ad_spend_minor, reasons: decided.reasons },
      reasoning: decided.reasoning,
      confidence: decided.confidence.toFixed(3),
      review_at: reviewAt,
    })
    .returning();
  if (!row) throw new ModeError("could not record the decision", 500);

  if (decided.mode === "watching") {
    await db.insert(watchActivity).values({
      profile_id: profileId,
      kind: "watch_started",
      detail: `Started watching: ${decided.watch_weeks} weeks, reviewing ${reviewAt.slice(0, 10)}.`,
      meta: { decision_id: row.id },
    });
  }
  return { kind: "decided", decision: toRow(row) };
}

/**
 * P1-44: the asymmetric override. Extending needs nothing. Shortening
 * needs an explicit acknowledgement, stored with the user who gave it.
 */
export async function overrideWatch(args: {
  profileId: string;
  toWeeks: 4 | 6 | 8;
  userId: string | null;
  acknowledgementText?: string;
}): Promise<ModeDecisionRow> {
  const current = await latestDecision(args.profileId);
  if (!current) throw new ModeError("no decision to override", 404);
  if (current.mode !== "watching" || current.watch_weeks === null) {
    throw new ModeError("only a watching decision can be overridden", 409);
  }
  if (args.toWeeks === current.watch_weeks) {
    throw new ModeError("that is already the watch length", 409);
  }

  const shortening = args.toWeeks < current.watch_weeks;
  if (shortening) {
    if (!args.acknowledgementText || args.acknowledgementText.trim() === "") {
      throw new ModeError(
        "shortening the watch needs an explicit acknowledgement of the risk",
        422,
      );
    }
    if (!args.userId) {
      throw new ModeError("shortening the watch requires being signed in", 401);
    }
  }

  const at = new Date().toISOString();
  const override: OwnerOverride = {
    kind: shortening ? "shorten" : "extend",
    from_weeks: current.watch_weeks,
    to_weeks: args.toWeeks,
    at,
    acknowledgement: shortening
      ? { user_id: args.userId as string, text: (args.acknowledgementText as string).trim(), at }
      : null,
  };

  const decidedAtMs = Date.parse(current.decided_at);
  const reviewAt = new Date(decidedAtMs + args.toWeeks * 7 * 86_400_000).toISOString();

  const [row] = await db
    .update(modeDecisions)
    .set({ watch_weeks: args.toWeeks, owner_override: override, review_at: reviewAt })
    .where(eq(modeDecisions.id, current.id))
    .returning();
  if (!row) throw new ModeError("could not record the override", 500);

  await db.insert(watchActivity).values({
    profile_id: args.profileId,
    kind: shortening ? "watch_shortened" : "watch_extended",
    detail: shortening
      ? `Watch shortened to ${args.toWeeks} weeks — acknowledged by the owner.`
      : `Watch extended to ${args.toWeeks} weeks at the owner's request.`,
    meta: { decision_id: current.id },
  });

  return toRow(row);
}
