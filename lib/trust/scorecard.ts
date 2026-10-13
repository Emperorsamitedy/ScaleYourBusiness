// The agent scorecard — Phase 3 Session E (P3-26).
//
// The Glass Business scoring itself in public: suggestions made,
// approved, and — for everything that ran — helped, did nothing, or
// backfired, judged by the deterministic readback and rendered with
// the arithmetic. The numbers say whatever they say; a scorecard that
// can't show a zero in "helped" or a two in "backfired" is marketing,
// not measurement. Gate 2 (P3-37) reads its approval rate from the
// same arithmetic this shows per profile.

import { eq } from "drizzle-orm";
import { db } from "../../db";
import { proposals } from "../../db/schema";
import type { ProposalRow } from "../proposals/service";
import type { OutcomeVerdict, ProposalOutcome } from "./readback";
import { readbackForProposal } from "./readback";
import { HOURS_MODULE, trialOutcome } from "../hours/trials";

export interface Scorecard {
  made: number;
  /** Written and then withheld by the owner's own limits (restraint). */
  blocked: number;
  pending: number;
  approved: number;
  rejected: number;
  expired: number;
  executed: number;
  /** Of everything the owner actually decided or let lapse. */
  approval_rate: { numerator: number; denominator: number; value: number | null };
  outcomes: Record<OutcomeVerdict, number>;
  /** The approval-rate arithmetic, spelled out. */
  arithmetic: string;
}

export interface ScoredProposal {
  proposal: ProposalRow;
  outcome: ProposalOutcome | null;
}

export interface TrustView {
  scorecard: Scorecard;
  /** Every proposal ever made, newest first, executed ones with outcomes. */
  history: ScoredProposal[];
}

/** The whole trust surface in one deterministic read. */
export async function buildTrustView(
  profileId: string,
  now: Date = new Date(),
): Promise<TrustView> {
  const rows = await db
    .select()
    .from(proposals)
    .where(eq(proposals.profile_id, profileId))
    .orderBy(proposals.created_at);

  const outcomes: Record<OutcomeVerdict, number> = {
    helped: 0,
    did_nothing: 0,
    backfired: 0,
    too_early: 0,
    unmeasured: 0,
  };
  const history: ScoredProposal[] = [];
  const counts = { blocked: 0, pending: 0, approved: 0, rejected: 0, expired: 0, executed: 0 };

  for (const row of rows) {
    if (row.status in counts) counts[row.status as keyof typeof counts] += 1;
    let outcome: ProposalOutcome | null = null;
    if (row.status === "executed") {
      outcome = await readbackForProposal(row, now);
      outcomes[outcome.verdict] += 1;
    } else if (row.status === "approved" && row.module === HOURS_MODULE) {
      // P3-41: an hours trial is carried out by the owner, so it stays
      // approved; it is judged on its weekday's takings all the same.
      outcome = await trialOutcome(row, now);
      outcomes[outcome.verdict] += 1;
    }
    history.push({ proposal: row, outcome });
  }
  history.reverse();

  const rate = approvalRate(counts);
  return {
    scorecard: {
      made: rows.length,
      ...counts,
      approval_rate: rate.approval_rate,
      outcomes,
      arithmetic: rate.arithmetic,
    },
    history,
  };
}

export interface StatusCounts {
  blocked: number;
  pending: number;
  approved: number;
  rejected: number;
  expired: number;
  executed: number;
}

/**
 * Approval rate: of everything put to the owner that reached an end
 * state (approved, executed, rejected, expired) — how much got a yes.
 * Blocked never reached them; pending hasn't ended. One definition,
 * shared by the per-profile scorecard and Gate 2's cross-customer rate.
 */
export function approvalRate(counts: StatusCounts): {
  approval_rate: Scorecard["approval_rate"];
  arithmetic: string;
} {
  const numerator = counts.approved + counts.executed;
  const denominator = numerator + counts.rejected + counts.expired;
  const value = denominator > 0 ? Math.round((numerator / denominator) * 1000) / 10 : null;
  return {
    approval_rate: { numerator, denominator, value },
    arithmetic:
      denominator > 0
        ? `${numerator} approved of ${denominator} concluded (${counts.rejected} declined, ${counts.expired} lapsed; ${counts.blocked} withheld by your limits, not counted) = ${value}%`
        : "nothing concluded yet — the rate exists after your first decisions",
  };
}
