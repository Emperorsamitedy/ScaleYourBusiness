// The revenue measurer for pre/post plans — D89 (architecture-v2), the
// measurer close-due.ts was waiting for.
//
// A before/after comparison alone credits an action with whatever the
// season did. So the effect is a difference-in-differences against the
// business's own same weeks a year earlier:
//
//   effect per day i = (after_i − before_i) − (after_i − before_i, a year earlier)
//
// `before_i` is the same weekday BEFORE_OFFSET days before `after_i`, and a
// year earlier is 364 days (52 weeks), so every pair compares like weekday
// with like weekday. The interval is a t-interval on the daily effects,
// widened for their day-to-day correlation, and computed in integers end to
// end (hard rule 1) — the one square root is an integer square root,
// rounded up so the interval is never narrower than the arithmetic says.
//
// It refuses to score — inconclusive, saying why — rather than guess: no
// year of history, too few measured days, more than one currency, a metric
// that isn't revenue, or another action that ran in the same weeks (this
// year or last), since one business-wide series can't tell two actions'
// effects apart.

import { and, eq, gte, lte, ne, or } from "drizzle-orm";
import { db } from "../../db";
import { measurementPlans } from "../../db/schema";
import { scaleMinorBy } from "../core/money";
import { dailySeries, shiftDay } from "../trust/series";
import type { Observation } from "./close";
import type { Plan } from "./plans";

export const REVENUE_MEASURE = {
  /** A year earlier, in whole weeks, so weekdays line up. */
  year_days: 364,
  /** Of the window's days, the share that must be measured in all four arms. */
  min_paired_share_bp: 7_500,
  /** After window end, how long a missing last day is waited for before scoring without it. */
  grace_days: 3,
  /** The correlation used for widening is capped here (an AR(1) inflation factor). */
  max_rho: 0.9,
} as const;

/** Two-sided 95 % t critical values, conservative: the value for the largest tabled df ≤ df. */
const T95: readonly [number, number][] = [
  [1, 12.706],
  [2, 4.303],
  [3, 3.182],
  [4, 2.776],
  [5, 2.571],
  [6, 2.447],
  [8, 2.306],
  [10, 2.228],
  [12, 2.179],
  [15, 2.131],
  [20, 2.086],
  [25, 2.06],
  [30, 2.042],
  [40, 2.021],
  [60, 2.0],
  [120, 1.98],
];

export function t95(df: number): number {
  let t = T95[0]![1];
  for (const [d, v] of T95) if (df >= d) t = v;
  return t;
}

/** The gap between an after-day and its before-day: whole weeks, clear of the action's own day. */
export function beforeOffset(windowDays: number): number {
  return 7 * Math.ceil((windowDays + 1) / 7);
}

export interface Arms {
  /** Day i of the window, its before-day, and both a year earlier; undefined where unmeasured. */
  after: readonly (number | undefined)[];
  before: readonly (number | undefined)[];
  afterLastYear: readonly (number | undefined)[];
  beforeLastYear: readonly (number | undefined)[];
}

/** The smallest r with r² ≥ v. */
function isqrtCeil(v: bigint): bigint {
  if (v <= 0n) return 0n;
  let x = BigInt(Math.ceil(Math.sqrt(Number(v)))); // not money: a starting guess, corrected below
  while (x * x < v) x += 1n;
  while (x > 0n && (x - 1n) * (x - 1n) >= v) x -= 1n;
  return x;
}

function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

/**
 * Pure: the window's effect and its 95 % interval from the four arms, in the
 * series' minor units — or why it can't be scored.
 */
export function differenceInDifferences(arms: Arms, windowDays: number): Observation {
  const n = windowDays;
  const d: { i: number; v: bigint }[] = [];
  for (let i = 0; i < n; i++) {
    const a = arms.after[i];
    const b = arms.before[i];
    const al = arms.afterLastYear[i];
    const bl = arms.beforeLastYear[i];
    if (a === undefined || b === undefined || al === undefined || bl === undefined) continue;
    d.push({ i, v: BigInt(a) - BigInt(b) - (BigInt(al) - BigInt(bl)) });
  }
  const m = d.length;
  const needed = Math.ceil((n * REVENUE_MEASURE.min_paired_share_bp) / 10_000);
  if (m < Math.max(needed, 2)) {
    return {
      inconclusive: `Only ${m} of ${n} days were measured this year, before and after, and a year earlier — scoring needs ${Math.max(needed, 2)}.`,
    };
  }

  const M = BigInt(m);
  let s1 = 0n;
  let s2 = 0n;
  for (const x of d) {
    s1 += x.v;
    s2 += x.v * x.v;
  }
  // m × Σ(d − mean)²: never negative, zero only when every day's effect is the same.
  const q = M * s2 - s1 * s1;

  // Lag-1 correlation of consecutive days, in integers until the ratio itself.
  let rho = 0;
  if (q > 0n) {
    let num = 0n;
    for (let k = 0; k + 1 < m; k++) {
      if (d[k + 1]!.i !== d[k]!.i + 1) continue;
      num += (M * d[k]!.v - s1) * (M * d[k + 1]!.v - s1);
    }
    rho = Number((num * 1_000n) / (M * q)) / 1_000; // not money: a correlation
  }
  rho = Math.min(Math.max(rho, 0), REVENUE_MEASURE.max_rho);
  const inflation = Math.sqrt((1 + rho) / (1 - rho));
  // The multiplier in thousandths, rounded up: never a narrower interval than the maths gives.
  const k = BigInt(Math.ceil(t95(m - 1) * inflation * 1_000));

  // half-width = n · k/1000 · sqrt(q / (m² (m − 1)))
  const N = BigInt(n);
  const halfWidth = isqrtCeil(ceilDiv(N * N * k * k * q, M * M * (M - 1n) * 1_000_000n));

  if (s1 > BigInt(Number.MAX_SAFE_INTEGER) || s1 < -BigInt(Number.MAX_SAFE_INTEGER)) {
    return { inconclusive: "The amounts are too large to score exactly." };
  }
  const observed = scaleMinorBy(Number(s1), n, m);
  const half = Number(halfWidth);
  const perDay = scaleMinorBy(Number(s1), 1, m);
  return {
    observed_minor: observed,
    low_minor: observed - half,
    high_minor: observed + half,
    method_notes:
      `Difference in differences over ${m} of ${n} days: each day after the action against the same ` +
      `weekday ${beforeOffset(n)} days before, minus the same comparison a year earlier (364 days), ` +
      `which takes out the season. Average effect ${perDay} a day, × ${n} days = ${observed}; ` +
      `95% interval ±${half} (t with ${m - 1} df, widened ×${inflation.toFixed(2)} for day-to-day ` + // not money: a factor shown as words
      `correlation ${rho.toFixed(2)}). Grade C: before/after with a seasonal control, not a holdout.`, // not money: a correlation shown as words
  };
}

/** The window's days, its before-days and both a year earlier, as dates. */
export function armDays(windowStart: string, windowEnd: string) {
  const startDay = new Date(Date.parse(windowStart)).toISOString().slice(0, 10);
  const n = Math.round((Date.parse(windowEnd) - Date.parse(windowStart)) / 86_400_000);
  const offset = beforeOffset(n);
  const after = Array.from({ length: n }, (_, i) => shiftDay(startDay, i + 1));
  const before = after.map((day) => shiftDay(day, -offset));
  const year = REVENUE_MEASURE.year_days;
  return {
    n,
    after,
    before,
    afterLastYear: after.map((day) => shiftDay(day, -year)),
    beforeLastYear: before.map((day) => shiftDay(day, -year)),
  };
}

/** Another executed action whose window touches this one's weeks, this year or a year earlier. */
async function overlapping(plan: Plan, days: ReturnType<typeof armDays>): Promise<boolean> {
  const span = (from: string, to: string) =>
    and(
      lte(measurementPlans.window_start, `${to}T23:59:59.999Z`),
      gte(measurementPlans.window_end, `${from}T00:00:00.000Z`),
    );
  const [other] = await db
    .select({ id: measurementPlans.id })
    .from(measurementPlans)
    .where(
      and(
        eq(measurementPlans.profile_id, plan.profile_id),
        ne(measurementPlans.id, plan.id),
        eq(measurementPlans.shadow, false),
        ne(measurementPlans.design, "unmeasurable"),
        or(
          span(days.before[0]!, days.after[days.n - 1]!),
          span(days.beforeLastYear[0]!, days.afterLastYear[days.n - 1]!),
        ),
      ),
    )
    .limit(1);
  return other !== undefined;
}

export class NotSyncedYetError extends Error {
  constructor(day: string) {
    super(`the window's last day (${day}) hasn't synced yet`);
    this.name = "NotSyncedYetError";
  }
}

/**
 * The measurer: scores a plan on the business-wide daily revenue series.
 * Throws (leaving the plan open for the next run) only while the window's
 * last day may still be syncing; everything else it can't score closes
 * inconclusive with the reason.
 */
export async function measureRevenue(plan: Plan, now = new Date()): Promise<Observation> {
  if (plan.primary_metric !== "revenue") {
    return {
      inconclusive: `This is scored on ${plan.primary_metric.replace(/_/g, " ")}, which SYB doesn't measure from a connected source yet — revenue alone can't stand in for it.`,
    };
  }
  const days = armDays(plan.window_start, plan.window_end);
  if (days.n < 7) {
    return { inconclusive: "The window is shorter than a week — too short to score." };
  }
  if (await overlapping(plan, days)) {
    return {
      inconclusive:
        "Another change ran in the same weeks (this year or the same weeks last year), and one revenue series can't tell their effects apart — so neither is credited.",
    };
  }

  const series = await dailySeries(
    plan.profile_id,
    "revenue.daily",
    days.beforeLastYear[0]!,
    days.after[days.n - 1]!,
  );
  if (!series || series.values.size === 0) {
    return { inconclusive: "No connected revenue series — connect a source and it can be scored." };
  }
  if (series.currencies.size > 1) {
    return {
      inconclusive: `Revenue arrives in ${series.currencies.size} currencies, and they are never added together — it can't be scored as one number.`,
    };
  }
  if (series.currency !== plan.currency) {
    return {
      inconclusive: `Revenue is measured in ${series.currency ?? "no currency"} and the plan is in ${plan.currency}; nothing is converted, so it isn't scored.`,
    };
  }

  const lastDay = days.after[days.n - 1]!;
  const graceEnd = Date.parse(plan.window_end) + REVENUE_MEASURE.grace_days * 86_400_000;
  if (!series.values.has(lastDay) && now.getTime() < graceEnd) throw new NotSyncedYetError(lastDay);

  const pick = (list: readonly string[]) => list.map((day) => series.values.get(day));
  const lastYearMeasured = pick(days.afterLastYear).some((v) => v !== undefined);
  if (!lastYearMeasured) {
    return {
      inconclusive:
        "There's no revenue on record for the same weeks a year earlier, so the season can't be taken out — a before/after alone isn't scored.",
    };
  }
  return differenceInDifferences(
    {
      after: pick(days.after),
      before: pick(days.before),
      afterLastYear: pick(days.afterLastYear),
      beforeLastYear: pick(days.beforeLastYear),
    },
    days.n,
  );
}
