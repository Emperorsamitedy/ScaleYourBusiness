// The weekly grading of SYB's forecasts — idea 54 (I-54.3). Rides the
// weekly beat (app/api/cron/weekly-watch), before the summary email, so the
// week's grades are on record when the email is composed.
//
// Every claim whose window closed at least a day ago and has no grade is
// read against the measured rows that grade it (./grade, pure), and graded
// once. A claim whose rows aren't in yet waits for next week, up to
// GRADE.patience_days. Read-only apart from the grade itself: no model, no
// network, no retry loop — one pass, and migration 0067 refuses a second
// grading of the same row anyway. One claim's failure never stops the rest.

import { and, asc, eq, gt, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { db } from "../../db";
import { forecastChecks, metricObservations } from "../../db/schema";
import { logSafeError } from "../core/log-safe";
import { addDays } from "../seasons/forecast";
import type { ClaimRow, DayValue, Grade, StockCount } from "./grade";
import { GRADE, gradeSeasonWeek, gradeStockOut } from "./grade";

type Row = typeof forecastChecks.$inferSelect;

/** The item's measured stock counts after the day the claim started from. */
async function stockCounts(claim: Row): Promise<StockCount[]> {
  const ref = claim.subject_ref as {
    connection_id?: unknown;
    product_ref?: unknown;
    as_of?: unknown;
  };
  if (
    typeof ref.connection_id !== "string" ||
    typeof ref.product_ref !== "string" ||
    typeof ref.as_of !== "string"
  ) {
    return [];
  }
  const rows = await db
    .select({
      id: metricObservations.id,
      date: metricObservations.period_date,
      value: metricObservations.value_num,
    })
    .from(metricObservations)
    .where(
      and(
        eq(metricObservations.connection_id, ref.connection_id),
        eq(metricObservations.metric_key, "stock.on_hand"),
        sql`${metricObservations.dimensions}->>'product_ref' = ${ref.product_ref}`,
        gt(metricObservations.period_date, ref.as_of),
      ),
    )
    .orderBy(asc(metricObservations.period_date));
  return rows
    .filter((r) => r.value !== null)
    .map((r) => ({ id: r.id, date: r.date, on_hand: Number(r.value) }));
}

/** The week's measured days of the same series: business-wide rows, the claim's currency. */
async function weekDays(claim: Row): Promise<DayValue[]> {
  const ref = claim.subject_ref as { connection_id?: unknown };
  if (typeof ref.connection_id !== "string") return [];
  const rows = await db
    .select({
      id: metricObservations.id,
      date: metricObservations.period_date,
      dimensions: metricObservations.dimensions,
      value_minor: metricObservations.value_minor,
      value_num: metricObservations.value_num,
      currency: metricObservations.currency,
    })
    .from(metricObservations)
    .where(
      and(
        eq(metricObservations.connection_id, ref.connection_id),
        eq(metricObservations.metric_key, claim.metric),
        gte(metricObservations.period_date, claim.window_start),
        lte(metricObservations.period_date, claim.window_end),
      ),
    );
  const out: DayValue[] = [];
  for (const r of rows) {
    if (!Object.keys(r.dimensions ?? {}).every((k) => k === "currency")) continue;
    if (claim.unit === "money") {
      if (r.value_minor === null || r.currency?.toUpperCase() !== claim.currency) continue;
      out.push({ id: r.id, date: r.date, value: Number(r.value_minor) });
    } else if (r.value_num !== null) {
      out.push({ id: r.id, date: r.date, value: Number(r.value_num) });
    }
  }
  return out;
}

/** One claim's grade from its measured rows, or null while they aren't in. */
export async function gradeOne(claim: Row, today: string): Promise<Grade | null> {
  const c: ClaimRow = claim;
  if (claim.kind === "stock_out") return gradeStockOut(c, await stockCounts(claim), today);
  if (claim.kind === "season_week") return gradeSeasonWeek(c, await weekDays(claim), today);
  return null;
}

export interface GradingResult {
  due: number;
  graded: number;
  /** Rows not in yet: they wait for next week's beat. */
  waiting: number;
  failed: number;
}

/** The weekly pass over every business, or the given ones (tests). */
export async function runForecastGrading(
  now: Date = new Date(),
  opts: { profileIds?: readonly string[] } = {},
): Promise<GradingResult> {
  const today = now.toISOString().slice(0, 10);
  const closedBy = addDays(today, -(GRADE.after_days + 1));
  const due = await db
    .select()
    .from(forecastChecks)
    .where(
      and(
        isNull(forecastChecks.graded_at),
        lte(forecastChecks.window_end, closedBy),
        opts.profileIds ? inArray(forecastChecks.profile_id, [...opts.profileIds]) : undefined,
      ),
    )
    .orderBy(asc(forecastChecks.window_end));
  const result: GradingResult = { due: due.length, graded: 0, waiting: 0, failed: 0 };
  for (const claim of due) {
    try {
      const grade = await gradeOne(claim, today);
      if (!grade) {
        result.waiting++;
        continue;
      }
      await db
        .update(forecastChecks)
        .set({ graded_at: now.toISOString(), ...grade })
        .where(and(eq(forecastChecks.id, claim.id), isNull(forecastChecks.graded_at)));
      result.graded++;
      console.log(
        JSON.stringify({
          event: "forecast_graded",
          account_id: claim.account_id,
          forecast_id: claim.id,
          kind: claim.kind,
          verdict: grade.verdict,
        }),
      );
    } catch (error) {
      result.failed++;
      console.error(
        JSON.stringify({
          event: "forecast_grading_failed",
          account_id: claim.account_id,
          forecast_id: claim.id,
          ...logSafeError(error),
        }),
      );
    }
  }
  return result;
}
