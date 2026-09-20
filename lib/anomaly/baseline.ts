// The baseline and the anomaly rule — P2-22 / P2-23.
//
// "Knows a weekend dip from a real 20% drop." Deterministic statistics on
// daily observations; no model call (CLAUDE.md's cost rule). Every number
// here is arithmetic anyone can redo by hand from the inputs, which is why
// the inputs are stored with every verdict (P2-25).
//
// THE BASELINE for a day is built from the 28 days before it:
//
//   overall mean       mean of the window's values
//   weekday factors    for each weekday with at least two points in the
//                      window, that weekday's mean over the overall mean;
//                      otherwise 1. A Sunday that always runs at 60% of the
//                      week gets a factor near 0.6, so a quiet Sunday is
//                      EXPECTED, not anomalous.
//   expected(day)      overall mean × that day's weekday factor
//   residuals          value − expected, for every day in the window
//   MAD                median absolute deviation of the residuals: the
//                      usual size of a surprise, robust to the odd outlier
//   scale              1.4826 × MAD (the normal-equivalent sigma), floored
//                      at 5% of the day's expected value, so a perfectly
//                      steady series still has a sensible unit of "usual
//                      variation", and the same percentage move reads the
//                      same on a quiet day as on a busy one
//
// THE RULE: a day is BEYOND when |actual − expected| > K × scale, K = 3,
// in either direction. An anomaly is a run of N consecutive beyond days in
// the same direction, N = 2: one odd day is noise, two is a signal. The
// thresholds are constants with tests at their boundaries, both ways.
//
// Pure module: no database, no clock.

export const BASELINE_WINDOW_DAYS = 28;
/** Fewer points than this and there is no baseline, so no verdict. */
export const MIN_BASELINE_DAYS = 14;
/** Beyond when the deviation exceeds this many scales. Strict: exactly K is not beyond. */
export const MAD_K = 3;
/** Consecutive beyond days, same direction, before it counts. */
export const RUN_DAYS = 2;
/** The scale never drops below this fraction of the day's expected value. */
export const MIN_SCALE_FRACTION = 0.05;
/** MAD → sigma for a normal distribution. */
export const MAD_TO_SIGMA = 1.4826;

const DAY_MS = 86_400_000;

/** "YYYY-MM-DD" → the day's value. Missing days are simply absent. */
export type Series = ReadonlyMap<string, number>;

export function shiftDay(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** 0 = Sunday … 6 = Saturday, in UTC. */
export function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

export const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

const mean = (values: readonly number[]): number =>
  values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;

export interface Baseline {
  target_date: string;
  window_from: string;
  window_to: string;
  window_days: number;
  overall_mean: number;
  weekday: number;
  weekday_factor: number;
  /** Index 0 = Sunday. */
  weekday_factors: number[];
  expected: number;
  residual_median: number;
  mad: number;
  scale: number;
  /** The window's points, so the verdict can be replayed exactly. */
  points: { date: string; value: number }[];
}

/** The baseline for `targetDate`, or null when the 28 days before it hold too little. */
export function computeBaseline(series: Series, targetDate: string): Baseline | null {
  const from = shiftDay(targetDate, -BASELINE_WINDOW_DAYS);
  const to = shiftDay(targetDate, -1);
  const points: { date: string; value: number; weekday: number }[] = [];
  for (let d = from; d <= to; d = shiftDay(d, 1)) {
    const value = series.get(d);
    if (value !== undefined && Number.isFinite(value)) {
      points.push({ date: d, value, weekday: weekdayOf(d) });
    }
  }
  if (points.length < MIN_BASELINE_DAYS) return null;

  const overall = mean(points.map((p) => p.value));
  if (overall <= 0) return null; // a dead series has no "usual"

  const factors = Array.from({ length: 7 }, (_, w) => {
    const same = points.filter((p) => p.weekday === w).map((p) => p.value);
    return same.length >= 2 ? mean(same) / overall : 1;
  });
  const expectedOn = (weekday: number): number => overall * (factors[weekday] ?? 1);

  const residuals = points.map((p) => p.value - expectedOn(p.weekday));
  const residualMedian = median(residuals);
  const mad = median(residuals.map((r) => Math.abs(r - residualMedian)));

  const weekday = weekdayOf(targetDate);
  // The floor follows the DAY's expected level, not the overall mean: a
  // 20% drop on a quiet Sunday is the same event as a 20% drop on a busy
  // Saturday, and the rule must read it the same way.
  const scale = Math.max(MAD_TO_SIGMA * mad, MIN_SCALE_FRACTION * expectedOn(weekday));
  return {
    target_date: targetDate,
    window_from: from,
    window_to: to,
    window_days: points.length,
    overall_mean: overall,
    weekday,
    weekday_factor: factors[weekday] ?? 1,
    weekday_factors: factors,
    expected: expectedOn(weekday),
    residual_median: residualMedian,
    mad,
    scale,
    points: points.map(({ date, value }) => ({ date, value })),
  };
}

export type Direction = "drop" | "spike";

export interface DayVerdict {
  date: string;
  actual: number;
  expected: number;
  /** (actual − expected) ÷ scale. */
  deviation: number;
  /** (actual − expected) ÷ expected. */
  pct: number;
  beyond: boolean;
  direction: Direction | null;
  baseline: Baseline;
}

/** One day against its own baseline, or null without a value or a baseline. */
export function evaluateDay(series: Series, date: string): DayVerdict | null {
  const actual = series.get(date);
  if (actual === undefined || !Number.isFinite(actual)) return null;
  const baseline = computeBaseline(series, date);
  if (baseline === null) return null;
  const deviation = (actual - baseline.expected) / baseline.scale;
  const beyond = Math.abs(deviation) > MAD_K;
  return {
    date,
    actual,
    expected: baseline.expected,
    deviation,
    pct: baseline.expected > 0 ? (actual - baseline.expected) / baseline.expected : 0,
    beyond,
    direction: beyond ? (deviation < 0 ? "drop" : "spike") : null,
    baseline,
  };
}

export interface AnomalyRun {
  direction: Direction;
  /** Oldest first; the last is `endDate`. */
  days: DayVerdict[];
}

/** The run of beyond days ending on `endDate`, when it is long enough and one-directional. */
export function detectRun(series: Series, endDate: string, runDays = RUN_DAYS): AnomalyRun | null {
  const days: DayVerdict[] = [];
  for (let i = 0; i < runDays; i += 1) {
    const verdict = evaluateDay(series, shiftDay(endDate, -i));
    if (verdict === null || !verdict.beyond || verdict.direction === null) return null;
    days.unshift(verdict);
  }
  const direction = days[0]?.direction;
  if (!direction || days.some((d) => d.direction !== direction)) return null;
  return { direction, days };
}

export interface WeekOverWeek {
  last7: number;
  prior7: number;
  /** (last7 − prior7) ÷ prior7, or null when the prior week is empty. */
  change: number | null;
}

/** The last seven days against the seven before them. Missing days count as zero. */
export function weekOverWeek(series: Series, endDate: string): WeekOverWeek {
  let last7 = 0;
  let prior7 = 0;
  for (let i = 0; i < 7; i += 1) last7 += series.get(shiftDay(endDate, -i)) ?? 0;
  for (let i = 7; i < 14; i += 1) prior7 += series.get(shiftDay(endDate, -i)) ?? 0;
  return { last7, prior7, change: prior7 > 0 ? (last7 - prior7) / prior7 : null };
}
