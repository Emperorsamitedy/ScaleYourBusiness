// The Goals screen's weekly candles and path (the owner's Goals design,
// 2026-10-17) — pure, no database. "1 candle = 1 week": each candle is
// one Monday-to-Sunday week of the goal's measured daily series, per day
// — open is the week's first measured day, close its last, high and low
// its extremes. The path is the one alert mode judges against
// (./progress): a straight line from the baseline on the day the measure
// was set to the target on the deadline, per 30 days, drawn here per day.

import type { GoalBaseline, GoalMeasure } from "./goal-measure";

const DAY_MS = 86_400_000;

export function addDays(day: string, by: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + by);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
}

/** The Monday on or before a day. */
export function weekStart(day: string): string {
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return addDays(day, -((dow + 6) % 7));
}

export interface Candle {
  /** YYYY-MM-DD, a Monday. */
  week: string;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Measured days in the week. */
  days: number;
}

/** Pure: weekly candles over from..to (inclusive); weeks with no measured day are left out. */
export function weeklyCandles(
  values: ReadonlyMap<string, number>,
  from: string,
  to: string,
): Candle[] {
  const weeks = new Map<string, Candle>();
  for (let day = from; day <= to; day = addDays(day, 1)) {
    const v = values.get(day);
    if (v === undefined) continue;
    const week = weekStart(day);
    const c = weeks.get(week);
    if (!c) weeks.set(week, { week, open: v, high: v, low: v, close: v, days: 1 });
    else {
      c.high = Math.max(c.high, v);
      c.low = Math.min(c.low, v);
      c.close = v;
      c.days += 1;
    }
  }
  return [...weeks.values()].sort((a, b) => a.week.localeCompare(b.week));
}

/** Pure: the weekly total of a second series (the volume pane), keyed by week. */
export function weeklyTotals(
  values: ReadonlyMap<string, number>,
  from: string,
  to: string,
): Map<string, number> {
  const out = new Map<string, number>();
  for (let day = from; day <= to; day = addDays(day, 1)) {
    const v = values.get(day);
    if (v === undefined) continue;
    const week = weekStart(day);
    out.set(week, (out.get(week) ?? 0) + v);
  }
  return out;
}

/**
 * Pure: each week's average a day, over the days measured in it — the line
 * the Goals screen draws (said plainly, 2026-11-28: one line in place of the
 * weekly candles). A week with no measured day is left out, not drawn as 0.
 */
export function weeklyAverages(
  values: ReadonlyMap<string, number>,
  from: string,
  to: string,
): { week: string; per_day: number; days: number }[] {
  const weeks = new Map<string, { total: number; days: number }>();
  for (let day = from; day <= to; day = addDays(day, 1)) {
    const v = values.get(day);
    if (v === undefined) continue;
    const week = weekStart(day);
    const w = weeks.get(week) ?? { total: 0, days: 0 };
    w.total += v;
    w.days += 1;
    weeks.set(week, w);
  }
  return [...weeks.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([week, w]) => ({ week, per_day: w.total / w.days, days: w.days }));
}

/**
 * Pure: where the path says the goal should be on `day`, per 30 days —
 * progress.ts's `expected`. Null before the measure was set or without
 * a baseline: there is no path to draw.
 */
export function pathPer30d(
  measure: Pick<GoalMeasure, "set_on" | "deadline" | "target_per_30d">,
  baseline: Pick<GoalBaseline, "per_30d"> | null,
  day: string,
): number | null {
  if (!baseline || day < measure.set_on) return null;
  const span = Math.max(1, daysBetween(measure.set_on, measure.deadline));
  const elapsed = Math.min(1, Math.max(0, daysBetween(measure.set_on, day) / span));
  return baseline.per_30d + (measure.target_per_30d - baseline.per_30d) * elapsed;
}

export type GoalWord = "reached" | "on_path" | "behind" | "off_path" | "too_early" | "unmeasured";

/** The card's status word, from the latest weekly check's verdict. */
export function goalWord(verdict: string | null | undefined): GoalWord | null {
  switch (verdict) {
    case "achieved":
      return "reached";
    case "on_track":
      return "on_path";
    case "lagging":
      return "behind";
    case "off_track":
      return "off_path";
    case "too_early":
      return "too_early";
    case "unmeasured":
      return "unmeasured";
    default:
      return null;
  }
}

/** Counts toward "N on its path": reached or on track at the latest check. */
export function onPath(verdict: string | null | undefined): boolean {
  return verdict === "achieved" || verdict === "on_track";
}
