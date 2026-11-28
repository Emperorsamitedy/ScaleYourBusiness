// The loader behind the Goals screen's candle charts (the owner's Goals
// design, 2026-10-17). Read-only: per measurable goal, the measured daily
// series as weekly candles (./chart-view), the path alert mode judges
// against, and where the last 28 days put the goal now — the same window
// and arithmetic as the weekly check (./progress). A revenue goal also
// gets its weekly orders as the volume pane, when orders are measured.

import { listGoals } from "../content/goals";
import { dailySeries, windowStat } from "../trust/series";
import {
  addDays,
  pathPer30d,
  weekStart,
  weeklyAverages,
  weeklyCandles,
  weeklyTotals,
} from "./chart-view";
import type { Candle } from "./chart-view";
import { GOAL_METRICS, readGoalMeasure } from "./goal-measure";
import { PROGRESS } from "./progress";

/** How many weeks of history a chart shows, at most, before today. */
export const CHART_WEEKS = 16;

export interface GoalChart {
  goal_id: string;
  metric: keyof typeof GOAL_METRICS;
  direction: "increase" | "decrease";
  currency: string | null;
  set_on: string;
  deadline: string;
  /** Axis start (a Monday) and end (the deadline, capped at CHART_WEEKS ahead; today when past). */
  from: string;
  to: string;
  /** The last measured day the candles read up to: yesterday. */
  today: string;
  candles: Candle[];
  /** Each week's average a day, over its measured days: the line the screen draws. */
  weekly: { week: string; per_day: number; days: number }[];
  /** The volume pane: "orders" per week, for a revenue goal. */
  volume: { label: string; weeks: [string, number][] } | null;
  baseline_per_30d: number | null;
  target_per_30d: number;
  /** The last 28 days, per 30 days; null when nothing in them is measured. */
  now: { per_30d: number; days_measured: number } | null;
  /** Where the path says the goal should be today, per 30 days. */
  path_now_per_30d: number | null;
  /** True when no connection measures the goal's series at all. */
  unconnected: boolean;
}

export async function loadGoalCharts(profileId: string, now = new Date()): Promise<GoalChart[]> {
  const today = now.toISOString().slice(0, 10);
  const yesterday = addDays(today, -1);
  const charts: GoalChart[] = [];
  for (const goal of await listGoals(profileId)) {
    const { measure, baseline } = await readGoalMeasure(profileId, goal.goal_id);
    if (!measure) continue;
    const metric = GOAL_METRICS[measure.metric];
    const start = weekStart(addDays(yesterday, -7 * CHART_WEEKS));
    // The path runs on to the deadline, but never squeezes the history into a corner.
    const horizon = addDays(yesterday, 7 * CHART_WEEKS);
    const axisEnd =
      measure.deadline <= yesterday
        ? yesterday
        : measure.deadline < horizon
          ? measure.deadline
          : horizon;
    const series = await dailySeries(profileId, metric.series, start, yesterday);
    const values = series?.values ?? new Map<string, number>();

    let volume: GoalChart["volume"] = null;
    if (measure.metric === "revenue") {
      const orders = await dailySeries(profileId, "orders.daily", start, yesterday);
      if (orders && orders.values.size > 0) {
        volume = {
          label: "orders",
          weeks: [...weeklyTotals(orders.values, start, yesterday).entries()],
        };
      }
    }

    const windowFrom = addDays(today, -PROGRESS.window_days);
    const stat = series ? windowStat(series, windowFrom, yesterday) : null;
    charts.push({
      goal_id: goal.goal_id,
      metric: measure.metric,
      direction: measure.direction,
      currency: measure.currency,
      set_on: measure.set_on,
      deadline: measure.deadline,
      from: start,
      to: axisEnd,
      today: yesterday,
      candles: weeklyCandles(values, start, yesterday),
      weekly: weeklyAverages(values, start, yesterday),
      volume,
      baseline_per_30d: baseline?.per_30d ?? null,
      target_per_30d: measure.target_per_30d,
      now:
        stat && stat.days_measured > 0
          ? { per_30d: stat.mean_minor * 30, days_measured: stat.days_measured }
          : null,
      path_now_per_30d: pathPer30d(measure, baseline, today),
      unconnected: series === null,
    });
  }
  return charts;
}
