// Goal progress and alert levels — P3-44 (Session J, alert mode).
//
// Weekly, for every measurable goal of a business in care: is it on the
// path from where it started to where the owner wants it? Arithmetic,
// never a model (CLAUDE.md cost rule) — the alert REVIEW (P3-46) is the
// only model call in alert mode, and it only runs after this says so.
//
// The path is a straight line from the baseline (at the day the measure
// was set) to the target (at the deadline). Each check compares the last
// 28 days, per 30 days, with where the line says the business should be:
//
//   ratio     = progress made / progress expected by now
//   shortfall = (expected − actual) / baseline        (direction-aware)
//
//   achieved   actual at or past the target
//   off_track  moving away from the target by ≥ the noise floor, or
//              ratio < 0.4 with a shortfall ≥ the noise floor
//   lagging    ratio < 0.7 with a shortfall ≥ the noise floor
//   on_track   otherwise
//
// The noise floor (5%, the readback's own threshold) is what makes the
// alert scale with the size of the gap: a goal asking for +5% is never
// "behind" by more than noise early on, while one asking for +50% opens
// a shortfall quickly when nothing moves. ALERT is three consecutive
// off-track weeks. Two honest non-states, each explaining itself:
// too_early and unmeasured. Every threshold below is pinned by tests at
// its boundary in both directions.

import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../../db";
import { goals, modeDecisions, watchActivity } from "../../db/schema";
import { format, money } from "../core/money";
import { dailySeries, shiftDay, windowStat } from "../trust/series";
import type { CareState } from "./day-zero";
import { careState } from "./day-zero";
import type { GoalBaseline, GoalMeasure } from "./goal-measure";
import { GOAL_METRICS, ensureBaseline, readGoalMeasure } from "./goal-measure";
import type { LimitLlm } from "../proposals/hard-limits";
import type { ReviewLlm } from "./review";
import { escalateIfStuck, runAlertReview } from "./review";

export const PROGRESS = {
  /** No verdict before this long under care (and never inside watching mode). */
  min_weeks_under_care: 8,
  /** The "now" window, ending yesterday. */
  window_days: 28,
  /** Fewer measured days than this in the window: too_early. */
  min_window_days: 21,
  /** Below this share of the expected progress (with a real shortfall): lagging. */
  lagging_below: 0.7,
  /** Below this share (with a real shortfall): off track. */
  off_track_below: 0.4,
  /** A shortfall smaller than this share of the baseline is noise. */
  noise_floor: 0.05,
  /** Consecutive off-track weekly checks that make an alert. */
  alert_after_weeks: 3,
  /** A goal is checked at most once in this many days. */
  min_days_between_checks: 6,
} as const;

export type ProgressVerdict =
  "achieved" | "on_track" | "lagging" | "off_track" | "too_early" | "unmeasured";

export interface ProgressAssessment {
  verdict: ProgressVerdict;
  expected_per_30d: number | null;
  actual_per_30d: number | null;
  /** Share of the expected progress achieved; null without a verdict. */
  ratio: number | null;
  /** Shortfall against the path, as a share of the baseline; positive = behind. */
  shortfall: number | null;
  /** The arithmetic with the real numbers — always present. */
  arithmetic: string;
}

export interface ProgressInput {
  measure: GoalMeasure;
  baseline: GoalBaseline | null;
  /** Mean per measured day over the current window; null when unmeasured. */
  current: { mean_minor: number; days_measured: number } | null;
  care: Pick<CareState, "day_zero" | "watch_ends_at"> | null;
  /** YYYY-MM-DD. */
  today: string;
}

const DAY_MS = 86_400_000;
const daysBetween = (a: string, b: string) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
const round3 = (n: number) => Math.round(n * 1000) / 1000;

function amount(measure: GoalMeasure, perThirtyDays: number): string {
  const label = GOAL_METRICS[measure.metric].label;
  const value =
    measure.currency !== null
      ? format(money(Math.round(perThirtyDays), measure.currency))
      : String(Math.round(perThirtyDays));
  return `${value} ${label} per 30 days`;
}

/** The pure verdict. Everything the runner does around it is reading and writing. */
export function assessProgress(input: ProgressInput): ProgressAssessment {
  const { measure, baseline, current, care, today } = input;
  const none = { expected_per_30d: null, actual_per_30d: null, ratio: null, shortfall: null };

  if (!care) {
    return { ...none, verdict: "too_early", arithmetic: "the business has not entered care yet" };
  }
  const careFloor = shiftDay(care.day_zero.slice(0, 10), PROGRESS.min_weeks_under_care * 7);
  if (today < careFloor) {
    return {
      ...none,
      verdict: "too_early",
      arithmetic: `under care since ${care.day_zero.slice(0, 10)} — progress is judged from ${careFloor} (${PROGRESS.min_weeks_under_care} weeks)`,
    };
  }
  if (care.watch_ends_at && today < care.watch_ends_at.slice(0, 10)) {
    return {
      ...none,
      verdict: "too_early",
      arithmetic: `still in the watching period until ${care.watch_ends_at.slice(0, 10)}`,
    };
  }
  const goalFloor = shiftDay(measure.set_on, PROGRESS.window_days);
  if (today < goalFloor) {
    return {
      ...none,
      verdict: "too_early",
      arithmetic: `the goal was set on ${measure.set_on} — its first full ${PROGRESS.window_days}-day window ends ${goalFloor}`,
    };
  }
  if (!baseline) {
    return {
      ...none,
      verdict: "unmeasured",
      arithmetic: `no measured baseline for ${GOAL_METRICS[measure.metric].label} before ${measure.set_on} — connect a source and the history fills it`,
    };
  }
  if (!current || current.days_measured < PROGRESS.min_window_days) {
    return {
      ...none,
      verdict: current ? "too_early" : "unmeasured",
      arithmetic: current
        ? `${current.days_measured} measured day(s) in the last ${PROGRESS.window_days} — a verdict needs ${PROGRESS.min_window_days}`
        : `no measured ${GOAL_METRICS[measure.metric].label} in the last ${PROGRESS.window_days} days`,
    };
  }

  const s = measure.direction === "increase" ? 1 : -1;
  const actual = current.mean_minor * 30;
  const span = Math.max(1, daysBetween(measure.set_on, measure.deadline));
  const elapsed = Math.min(1, Math.max(0, daysBetween(measure.set_on, today) / span));
  const expected = baseline.per_30d + (measure.target_per_30d - baseline.per_30d) * elapsed;
  // A business starting from zero has no baseline to scale by; the target stands in.
  const scale = baseline.per_30d > 0 ? baseline.per_30d : measure.target_per_30d;

  const progress = s * (actual - baseline.per_30d);
  const required = s * (expected - baseline.per_30d);
  const ratio = required > 0 ? progress / required : 1;
  const shortfall = (s * (expected - actual)) / scale;
  const movedAway = progress / scale <= -PROGRESS.noise_floor;

  const path =
    `${amount(measure, actual)} over the last ${current.days_measured} measured days, against ` +
    `${amount(measure, expected)} expected by ${today} on the path from ${amount(measure, baseline.per_30d)} ` +
    `(${baseline.to}) to ${amount(measure, measure.target_per_30d)} (${measure.deadline})`;
  const numbers = {
    expected_per_30d: Math.round(expected),
    actual_per_30d: Math.round(actual),
    ratio: round3(ratio),
    shortfall: round3(shortfall),
  };

  if (s * (actual - measure.target_per_30d) >= 0) {
    return { ...numbers, verdict: "achieved", arithmetic: `target reached: ${path}` };
  }
  const real = shortfall >= PROGRESS.noise_floor;
  const pct = (n: number) => `${Math.round(n * 1000) / 10}%`;
  const detail = `${path} — ${pct(ratio)} of the expected progress, ${pct(Math.max(0, shortfall))} behind the path`;
  if (movedAway) {
    return {
      ...numbers,
      verdict: "off_track",
      arithmetic: `moving away from the target: ${detail}`,
    };
  }
  if (real && ratio < PROGRESS.off_track_below) {
    return { ...numbers, verdict: "off_track", arithmetic: detail };
  }
  if (real && ratio < PROGRESS.lagging_below) {
    return { ...numbers, verdict: "lagging", arithmetic: detail };
  }
  return { ...numbers, verdict: "on_track", arithmetic: detail };
}

export interface ProgressRunResult {
  checked: number;
  skipped_recent: number;
  alerts_raised: number;
}

interface PreviousCheck {
  at: string;
  consecutive_off_track: number;
  alert: boolean;
}

async function previousCheck(profileId: string, goalId: string): Promise<PreviousCheck | null> {
  const [row] = await db
    .select({ at: watchActivity.at, meta: watchActivity.meta })
    .from(watchActivity)
    .where(
      and(
        eq(watchActivity.profile_id, profileId),
        eq(watchActivity.kind, "goal_progress"),
        sql`${watchActivity.meta}->>'goal_id' = ${goalId}`,
      ),
    )
    .orderBy(desc(watchActivity.at))
    .limit(1);
  if (!row) return null;
  const meta = row.meta as { consecutive_off_track?: number; alert?: boolean } | null;
  return {
    at: row.at,
    consecutive_off_track: meta?.consecutive_off_track ?? 0,
    alert: meta?.alert ?? false,
  };
}

const SENTENCE: Record<ProgressVerdict, string> = {
  achieved: "Goal reached",
  on_track: "On track",
  lagging: "Behind the path",
  off_track: "Off track",
  too_early: "Too early to judge",
  unmeasured: "Can't be measured yet",
};

/** How a raised alert reaches the review (P3-46); null = record the alert only. */
export interface ReviewHook {
  llm?: ReviewLlm;
  limitLlm?: LimitLlm;
}

/**
 * Check one goal; writes one watch-log entry, and an alert entry when one
 * starts. A new alert runs the review when `review` is given; a goal
 * still in alert is escalated to a person once the recovery window closes.
 */
export async function checkGoal(
  profileId: string,
  goalId: string,
  care: CareState | null,
  now: Date = new Date(),
  review: ReviewHook | null = null,
): Promise<{ checked: boolean; alert_raised: boolean }> {
  const previous = await previousCheck(profileId, goalId);
  if (
    previous &&
    now.getTime() - Date.parse(previous.at) < PROGRESS.min_days_between_checks * DAY_MS
  ) {
    return { checked: false, alert_raised: false };
  }
  await ensureBaseline(profileId, goalId);
  const { measure, baseline } = await readGoalMeasure(profileId, goalId);
  if (!measure) return { checked: false, alert_raised: false };

  const today = now.toISOString().slice(0, 10);
  const to = shiftDay(today, -1);
  const from = shiftDay(today, -PROGRESS.window_days);
  const series = await dailySeries(profileId, GOAL_METRICS[measure.metric].series, from, to);
  const current = series ? windowStat(series, from, to) : null;
  const result = assessProgress({ measure, baseline, current, care, today });

  const consecutive =
    result.verdict === "off_track" ? (previous?.consecutive_off_track ?? 0) + 1 : 0;
  const alert = consecutive >= PROGRESS.alert_after_weeks;
  // Stamped with the check's own clock, so the weekly spacing compares like with like.
  const at = now.toISOString();
  await db.insert(watchActivity).values({
    profile_id: profileId,
    at,
    kind: "goal_progress",
    detail: `${SENTENCE[result.verdict]}: ${result.arithmetic}.`,
    meta: {
      goal_id: goalId,
      verdict: result.verdict,
      expected_per_30d: result.expected_per_30d,
      actual_per_30d: result.actual_per_30d,
      ratio: result.ratio,
      shortfall: result.shortfall,
      consecutive_off_track: consecutive,
      alert,
    },
  });
  const raised = alert && !(previous?.alert ?? false);
  if (raised) {
    await db.insert(watchActivity).values({
      profile_id: profileId,
      at,
      kind: "goal_alert",
      detail: `Alert: this goal has been off track for ${consecutive} weekly checks in a row. A full review of everything since day zero comes next.`,
      meta: { goal_id: goalId, consecutive_off_track: consecutive },
    });
    if (review) await runAlertReview(profileId, goalId, { ...review, now });
  } else if (alert) {
    await escalateIfStuck(profileId, goalId, now);
  }
  return { checked: true, alert_raised: raised };
}

/** The weekly sweep: every measurable goal of every business in care. Live review by default. */
export async function runProgressChecks(
  now: Date = new Date(),
  review: ReviewHook | null = {},
): Promise<ProgressRunResult> {
  const inCare = await db
    .selectDistinct({ profile_id: modeDecisions.profile_id })
    .from(modeDecisions);
  let checked = 0;
  let skipped = 0;
  let alerts = 0;
  for (const { profile_id } of inCare) {
    const care = await careState(profile_id);
    const goalRows = await db
      .select({ id: goals.id })
      .from(goals)
      .where(eq(goals.profile_id, profile_id));
    for (const goal of goalRows) {
      const { measure } = await readGoalMeasure(profile_id, goal.id);
      if (!measure) continue;
      const outcome = await checkGoal(profile_id, goal.id, care, now, review);
      if (outcome.checked) checked++;
      else skipped++;
      if (outcome.alert_raised) alerts++;
    }
  }
  return { checked, skipped_recent: skipped, alerts_raised: alerts };
}
