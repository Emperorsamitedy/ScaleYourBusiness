// The first interview's budget — the v1 build spec §6.5, §6.6 (P7-54).
//
// "Hard cap the first interview at 8 minutes. The current full interview
// moves to a progressive profile that fills over weeks." And: "Never ask
// for a number a connected system already holds."
//
// A question's cost (1–3, the bank's own effort scale) is read as seconds
// through SECONDS_PER_COST — data, so it can be tuned against timed
// sessions. The generator offers only questions that still fit what's left
// of the 8 minutes; when none fits, the first interview is over and the
// report follows. Once a business has its first report there is no cap:
// the rest of the profile fills as the owner chooses to answer.
//
// Suppression: a question whose fact a live connection measures is not
// asked (CONNECTOR_ANSWERS), even before the connection's first sync has
// derived the fact.

import type { ApplicableQuestion } from "../resolver/applicability";

export const FIRST_INTERVIEW_SECONDS = 8 * 60;

/** The bank's cost scale, in seconds a careful owner takes to answer. */
export const SECONDS_PER_COST: Readonly<Record<number, number>> = { 1: 10, 2: 20, 3: 40 };

export function secondsOf(cost: number): number {
  return SECONDS_PER_COST[cost] ?? SECONDS_PER_COST[3]!;
}

/** Facts a connected system answers: fact key → the connector metric that measures it. */
export const CONNECTOR_ANSWERS: Readonly<Record<string, string>> = {
  "revenue.monthly_revenue": "revenue.daily",
  "revenue.order_count_monthly": "orders.daily",
  "marketing.monthly_ad_spend": "ad_spend.daily",
};

export interface Budget {
  /** Seconds of the first interview already spent on answered questions. */
  spent_seconds: number;
  limit_seconds: number;
}

/** Pure: the seconds spent so far — the owner's own answers, by question cost. */
export function spentSeconds(
  applicable: readonly ApplicableQuestion[],
  answeredByOwner: ReadonlySet<string>,
): number {
  return applicable
    .filter((q) => answeredByOwner.has(q.writes_to))
    .reduce((n, q) => n + secondsOf(q.cost), 0);
}

/**
 * Pure: the candidates that may still be asked — those a live connection
 * doesn't answer and, in the first interview, those that fit the budget.
 */
export function withinBudget(
  candidates: readonly ApplicableQuestion[],
  budget: Budget | null,
  measuredMetrics: ReadonlySet<string>,
): ApplicableQuestion[] {
  const unmeasured = candidates.filter((q) => {
    const metric = CONNECTOR_ANSWERS[q.writes_to];
    return metric === undefined || !measuredMetrics.has(metric);
  });
  if (budget === null) return unmeasured;
  const left = budget.limit_seconds - budget.spent_seconds;
  return unmeasured.filter((q) => secondsOf(q.cost) <= left);
}
