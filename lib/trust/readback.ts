// Performance readback — Phase 3 Session E (P3-25).
//
// Every executed proposal is confronted with what the measurement layer
// actually recorded: the mean of the business-wide daily series after
// the action, against the 28 days before it, arithmetic shown. The
// verdict vocabulary is deliberately blunt — helped, did nothing,
// backfired — plus the two honest non-verdicts: too_early (not enough
// days measured yet) and unmeasured (no connected series at all). A
// system that only ever says "helped" or "insufficient data" is hiding;
// this one can say "backfired" about its own suggestion, with numbers.
//
// Deterministic throughout: thresholds in code, tested at their
// boundaries in both directions (the anomaly-detection discipline).
// Today every kind is judged on revenue.daily — the honest default
// until per-post readback (P3-23, Session D) gives finer attribution.

import { eq } from "drizzle-orm";
import { db } from "../../db";
import { executions } from "../../db/schema";
import type { ProposalRow } from "../proposals/service";
import type { WindowStat } from "./series";
import { dailySeries, shiftDay, windowStat } from "./series";

export type { WindowStat } from "./series";

export const READBACK = {
  /** Relative change at or above this: helped. */
  helped_at: 0.05,
  /** Relative change at or below this: backfired. */
  backfired_at: -0.05,
  /** Fewer measured days after the action than this: too_early. */
  min_after_days: 7,
  /** The before-window, matching the anomaly baseline. */
  before_days: 28,
  /** The after-window cap. */
  after_days: 28,
} as const;

export type OutcomeVerdict = "helped" | "did_nothing" | "backfired" | "too_early" | "unmeasured";

export interface ProposalOutcome {
  proposal_id: string;
  verdict: OutcomeVerdict;
  executed_on: string | null;
  metric: string;
  currency: string | null;
  before: WindowStat | null;
  after: WindowStat | null;
  delta_pct: number | null;
  /** The arithmetic, with the real numbers in it — always present. */
  arithmetic: string;
  /** What the scenario promised, for the side-by-side. */
  predicted: string | null;
  assumptions: { statement: string; sensitivity: string }[];
}

function money(minor: number, currency: string | null): string {
  const major = (minor / 100).toFixed(2);
  return currency ? `${major} ${currency}` : major;
}

/** When the proposal actually ran: the engine's record, else the decision. */
export async function executedOn(proposal: ProposalRow): Promise<string | null> {
  const [execution] = await db
    .select({ finished_at: executions.finished_at })
    .from(executions)
    .where(eq(executions.proposal_id, proposal.id));
  const at = execution?.finished_at ?? proposal.decided_at;
  return at ? at.slice(0, 10) : null;
}

/** Judge one executed proposal against the measured record. */
export async function readbackForProposal(
  proposal: ProposalRow,
  now: Date = new Date(),
): Promise<ProposalOutcome> {
  const scenario = proposal.scenario as {
    base_case?: { statement?: string };
    assumptions?: { statement: string; sensitivity: string }[];
  } | null;
  const base: Omit<ProposalOutcome, "verdict" | "arithmetic"> = {
    proposal_id: proposal.id,
    executed_on: null,
    metric: "revenue.daily",
    currency: null,
    before: null,
    after: null,
    delta_pct: null,
    predicted: scenario?.base_case?.statement ?? null,
    assumptions: (scenario?.assumptions ?? []).map((a) => ({
      statement: a.statement,
      sensitivity: a.sensitivity,
    })),
  };

  const day = await executedOn(proposal);
  if (!day) {
    return { ...base, verdict: "unmeasured", arithmetic: "never executed — nothing to measure" };
  }
  base.executed_on = day;

  const from = shiftDay(day, -READBACK.before_days);
  const today = now.toISOString().slice(0, 10);
  const afterTo =
    shiftDay(day, READBACK.after_days) < today ? shiftDay(day, READBACK.after_days) : today;
  const series = await dailySeries(proposal.profile_id, "revenue.daily", from, afterTo);
  if (!series || series.values.size === 0) {
    return {
      ...base,
      verdict: "unmeasured",
      arithmetic: "no measured revenue series — connect a source and the verdict becomes possible",
    };
  }
  base.currency = series.currency;

  const before = windowStat(series, from, shiftDay(day, -1));
  const after = windowStat(series, shiftDay(day, 1), afterTo);
  base.before = before;
  base.after = after;

  if (before.days_measured === 0) {
    return {
      ...base,
      verdict: "unmeasured",
      arithmetic: "no measured days before the action — no baseline to compare against",
    };
  }
  if (after.days_measured < READBACK.min_after_days) {
    return {
      ...base,
      verdict: "too_early",
      arithmetic: `${after.days_measured} measured day(s) since ${day} — the verdict needs ${READBACK.min_after_days}`,
    };
  }

  const delta = (after.mean_minor - before.mean_minor) / before.mean_minor;
  base.delta_pct = Math.round(delta * 1000) / 10;
  const verdict: OutcomeVerdict =
    delta >= READBACK.helped_at
      ? "helped"
      : delta <= READBACK.backfired_at
        ? "backfired"
        : "did_nothing";
  const arithmetic =
    `daily revenue averaged ${money(after.mean_minor, series.currency)} over the ` +
    `${after.days_measured} measured day(s) after ${day}, against ` +
    `${money(before.mean_minor, series.currency)} over the ${before.days_measured} before — ` +
    `${base.delta_pct >= 0 ? "+" : ""}${base.delta_pct}%` +
    ` (thresholds: helped at +${READBACK.helped_at * 100}%, backfired at ${READBACK.backfired_at * 100}%)`;
  return { ...base, verdict, arithmetic };
}
