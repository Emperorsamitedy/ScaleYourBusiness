// Measurable goals — P3-42 (Session J, alert mode).
//
// A goal (P3-14) is the owner's sentence. Alert mode needs more: a
// number to move, how far, and by when — and the number it started
// from. The measure is the owner's statement (owner_input); the
// baseline is MEASURED, never asked, and records the series it came from
// (rule 6). Both live in the supersession store beside the goal's other
// attributes, so a target raised in May still shows what it was in March.
//
// Units are "per 30 days": the mean of the measured days in a 28-day
// window, times 30. One unit for target, baseline and progress, stated on
// every screen, so nothing compares a month with a day.

import { eq } from "drizzle-orm";
import { db } from "../../db";
import { goals } from "../../db/schema";
import type { MetricKey } from "../connectors/provider";
import { CONNECTOR_CONFIDENCE } from "../connectors/derive";
import { connectorSeriesId } from "../connectors/measured";
import { confidence } from "../core/confidence";
import { createField } from "../core/field";
import { fieldId } from "../core/ids";
import { isoDateTime } from "../core/iso";
import { readCurrentField, writeField } from "../profile/field-store";
import { dailySeries, shiftDay, windowStat } from "../trust/series";

export class GoalMeasureError extends Error {
  readonly status: number;
  constructor(message: string, status = 422) {
    super(message);
    this.name = "GoalMeasureError";
    this.status = status;
  }
}

/** What a goal can be measured on — each one a measured daily series. */
export const GOAL_METRICS = {
  revenue: { series: "revenue.daily", kind: "money", label: "revenue" },
  orders: { series: "orders.daily", kind: "count", label: "orders" },
  sessions: { series: "sessions.daily", kind: "count", label: "website visits" },
} as const satisfies Record<string, { series: MetricKey; kind: "money" | "count"; label: string }>;

export type GoalMetric = keyof typeof GOAL_METRICS;

export const BASELINE = {
  /** The window the baseline averages, ending the day before the goal is set. */
  window_days: 28,
  /** Fewer measured days than this in the window: no baseline yet. */
  min_days: 21,
} as const;

export interface GoalMeasure {
  metric: GoalMetric;
  direction: "increase" | "decrease";
  /** The level wanted, per 30 days. Minor units for money (rule 1). */
  target_per_30d: number;
  /** ISO 4217 for money; null for counts. */
  currency: string | null;
  /** YYYY-MM-DD — when the target should be reached. */
  deadline: string;
  /** YYYY-MM-DD — when the measure was set: the start of the expected path. */
  set_on: string;
}

export interface GoalBaseline {
  per_30d: number;
  currency: string | null;
  from: string;
  to: string;
  days_measured: number;
}

const HORIZON_MONTHS: Record<string, number> = { "3_months": 3, "6_months": 6, "12_months": 12 };

function addMonths(day: string, months: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

const isDay = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));

export interface GoalMeasureInput {
  metric: string;
  /** Defaults to "increase". */
  direction?: string | null;
  target_per_30d: number;
  currency?: string | null;
  /** Optional; derived from the goal's horizon when absent. */
  deadline?: string | null;
}

async function goalOwnedBy(profileId: string, goalId: string): Promise<void> {
  const [spine] = await db
    .select({ profile_id: goals.profile_id })
    .from(goals)
    .where(eq(goals.id, goalId));
  if (!spine || spine.profile_id !== profileId) throw new GoalMeasureError("no such goal", 404);
}

export async function readGoalMeasure(
  profileId: string,
  goalId: string,
): Promise<{ measure: GoalMeasure | null; baseline: GoalBaseline | null }> {
  const measure = await readCurrentField<GoalMeasure>(profileId, `goals.${goalId}.measure`);
  const baseline = await readCurrentField<GoalBaseline>(profileId, `goals.${goalId}.baseline`);
  return { measure: measure?.value ?? null, baseline: baseline?.value ?? null };
}

/**
 * Measure the baseline: the 28 days before the measure was set. Null when
 * fewer than 21 of them are measured — said, not guessed. A connector's
 * twelve-month backfill can fill the window after the fact, so a goal set
 * before connecting gets its baseline once the history arrives.
 */
export async function measureBaseline(
  profileId: string,
  measure: GoalMeasure,
): Promise<{ baseline: GoalBaseline; providers: string[] } | { reason: string }> {
  const metric = GOAL_METRICS[measure.metric];
  const to = shiftDay(measure.set_on, -1);
  const from = shiftDay(measure.set_on, -BASELINE.window_days);
  const series = await dailySeries(profileId, metric.series, from, to);
  if (!series) return { reason: `no connected source measures ${metric.label}` };
  if (series.currencies.size > 1) {
    return {
      reason: `${metric.label} is measured in ${[...series.currencies].join(" and ")} — one currency is needed`,
    };
  }
  const stat = windowStat(series, from, to);
  if (stat.days_measured < BASELINE.min_days) {
    return {
      reason: `${stat.days_measured} measured day(s) in the ${BASELINE.window_days} before ${measure.set_on} — a baseline needs ${BASELINE.min_days}`,
    };
  }
  if (metric.kind === "money" && series.currency !== measure.currency) {
    return {
      reason: `${metric.label} is measured in ${series.currency}, the target is in ${measure.currency}`,
    };
  }
  return {
    baseline: {
      per_30d: stat.mean_minor * 30,
      currency: metric.kind === "money" ? series.currency : null,
      from,
      to,
      days_measured: stat.days_measured,
    },
    providers: [...series.providers].sort(),
  };
}

/** Write the baseline as an inferred fact naming the series it came from (rule 6). */
async function writeBaseline(
  profileId: string,
  goalId: string,
  measure: GoalMeasure,
  measured: { baseline: GoalBaseline; providers: string[] },
): Promise<void> {
  const series = GOAL_METRICS[measure.metric].series;
  const at = isoDateTime(new Date().toISOString());
  await writeField(
    profileId,
    createField<GoalBaseline>({
      id: fieldId(`goals.${goalId}.baseline`),
      value: measured.baseline,
      status: "inferred",
      confidence: confidence(CONNECTOR_CONFIDENCE),
      source: {
        kind: "inferred",
        derived_from: measured.providers.map((p) => fieldId(connectorSeriesId(p, series))),
        method: `baseline_per_30d = mean(${series}, ${measured.baseline.from}..${measured.baseline.to}, ${measured.baseline.days_measured} measured days) × 30`,
      },
      observed_at: isoDateTime(`${measured.baseline.to}T23:59:59Z`),
      recorded_at: at,
    }),
  );
}

/** Capture the baseline if it is missing and now measurable. True when one exists after. */
export async function ensureBaseline(profileId: string, goalId: string): Promise<boolean> {
  const { measure, baseline } = await readGoalMeasure(profileId, goalId);
  if (!measure) return false;
  if (baseline) return true;
  const measured = await measureBaseline(profileId, measure);
  if ("reason" in measured) return false;
  await writeBaseline(profileId, goalId, measure, measured);
  return true;
}

/**
 * Make a goal measurable. Validates the statement against what the
 * system can measure; captures the baseline when the history exists.
 */
export async function setGoalMeasure(
  profileId: string,
  goalId: string,
  input: GoalMeasureInput,
  now: Date = new Date(),
): Promise<{ measure: GoalMeasure; baseline: GoalBaseline | null; baseline_note: string | null }> {
  await goalOwnedBy(profileId, goalId);
  if (!(input.metric in GOAL_METRICS)) {
    throw new GoalMeasureError(`metric must be one of: ${Object.keys(GOAL_METRICS).join(", ")}`);
  }
  const metric = input.metric as GoalMetric;
  const kind = GOAL_METRICS[metric].kind;
  const direction = input.direction ?? "increase";
  if (direction !== "increase" && direction !== "decrease") {
    throw new GoalMeasureError("direction must be increase or decrease");
  }
  if (!Number.isInteger(input.target_per_30d) || input.target_per_30d <= 0) {
    throw new GoalMeasureError(
      kind === "money"
        ? "the target must be a positive whole number of minor units (cents), per 30 days"
        : "the target must be a positive whole number, per 30 days",
    );
  }
  const currency = kind === "money" ? (input.currency ?? "").toUpperCase() : null;
  if (kind === "money" && !/^[A-Z]{3}$/.test(currency ?? "")) {
    throw new GoalMeasureError("a money target needs its currency — ISO 4217, e.g. EUR (rule 1)");
  }

  const setOn = now.toISOString().slice(0, 10);
  let deadline = input.deadline ?? null;
  if (!deadline) {
    const horizon = await readCurrentField<string>(profileId, `goals.${goalId}.horizon`);
    const months = horizon ? HORIZON_MONTHS[horizon.value as string] : undefined;
    if (!months) {
      throw new GoalMeasureError(
        "a measurable goal needs a deadline, or a horizon to derive one from",
      );
    }
    deadline = addMonths(setOn, months);
  }
  if (!isDay(deadline) || deadline <= setOn) {
    throw new GoalMeasureError("the deadline must be a date (YYYY-MM-DD) after today");
  }

  const measure: GoalMeasure = {
    metric,
    direction,
    target_per_30d: input.target_per_30d,
    currency,
    deadline,
    set_on: setOn,
  };

  const measured = await measureBaseline(profileId, measure);
  if (!("reason" in measured)) {
    const reached =
      direction === "increase"
        ? measured.baseline.per_30d >= measure.target_per_30d
        : measured.baseline.per_30d <= measure.target_per_30d;
    if (reached) {
      throw new GoalMeasureError(
        `the target is already reached — the last 28 days measured ${measured.baseline.per_30d} per 30 days`,
      );
    }
  }

  const at = isoDateTime(now.toISOString());
  await writeField(
    profileId,
    createField<GoalMeasure>({
      id: fieldId(`goals.${goalId}.measure`),
      value: measure,
      status: "answered",
      confidence: confidence(0.75),
      source: { kind: "owner_input" },
      observed_at: at,
      recorded_at: at,
    }),
  );
  if ("reason" in measured) return { measure, baseline: null, baseline_note: measured.reason };
  await writeBaseline(profileId, goalId, measure, measured);
  return { measure, baseline: measured.baseline, baseline_note: null };
}
