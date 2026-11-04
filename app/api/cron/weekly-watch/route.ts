// GET /api/cron/weekly-watch — the P1-46 weekly job's trigger.
//
// Vercel cron calls this with `Authorization: Bearer ${CRON_SECRET}`
// when CRON_SECRET is set in the environment; nothing else may run it.
// No job queue until Phase 2 (CLAUDE.md), and a weekly snapshot+diff
// completes in seconds — a cron-hit route is the whole requirement.

import { bearerMatches } from "../../../../lib/core/secret-compare";
import { logSafeError } from "../../../../lib/core/log-safe";
import { type NextRequest, NextResponse } from "next/server";
import { runProgressChecks } from "../../../../lib/care/progress";
import { runAdProposals } from "../../../../lib/ads/proposals";
import { runForecastGrading } from "../../../../lib/forecasts/run";
import { runHoursTrials } from "../../../../lib/hours/trials";
import { runStockProposals } from "../../../../lib/stock/propose";
import { runSeasonPushes } from "../../../../lib/content/season-push";
import { runStockWarnings } from "../../../../lib/stock/warnings";
import { runWeeklySummaries } from "../../../../lib/summary/run";
import { runWeeklyWatch } from "../../../../lib/watch/job";
import { pruneExpiredReviews } from "../../../../lib/reviews/store";
import { pruneExpiredCarts } from "../../../../lib/carts/store";

/**
 * Review 2026-10-30: one step that throws is logged and reported as null,
 * and the steps after it (the owner's weekly summary above all) still run.
 * Each step logs its own per-business failures with the account id; what
 * reaches here is a step failing as a whole, which has no one account.
 */
async function isolated<T>(step: string, run: () => Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch (error) {
    console.error(
      JSON.stringify({ event: "weekly_watch_step_failed", step, ...logSafeError(error) }),
    );
    return null;
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  if (!bearerMatches(request.headers.get("authorization"), secret)) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  try {
    const result = await runWeeklyWatch();
    // P3-44: goal progress rides the same weekly beat.
    const progress = await runProgressChecks();
    // P3-41: this month's trading-hours signals become trial proposals.
    const trials = await runHoursTrials();
    // P3-22a: measured campaigns become pause / raise proposals — never executed here.
    const ads = await runAdProposals();
    // P5-02: items whose cover falls below their delivery time, into the watch log.
    const stock_warnings = await runStockWarnings();
    // Feature 34: slow stock becomes ways to clear it, and P5-03 low stock a
    // reorder note — proposals only, never executed here, never an order.
    const stock = await runStockProposals();
    // I-46a: a busy stretch two to three weeks out becomes one content-calendar
    // proposal — never drafted or published here.
    const season_push = await isolated("season_push", () => runSeasonPushes());
    // Idea 54: SYB's own forecasts whose window has closed, graded from
    // measured rows — before the summary, so the week's grades are in it.
    const forecasts = await isolated("forecast_grading", () => runForecastGrading());
    // Idea 45: reviews (and the reviewer names on them) don't outlive their year,
    // even for a business that gets no new review and never opens /reviews.
    const reviews_expired = await isolated("reviews_prune", () => pruneExpiredReviews(new Date()));
    // Idea 47 (review 2026-10-30): nor carts their 90 days, for a store whose syncs stopped.
    const carts_expired = await isolated("carts_prune", () => pruneExpiredCarts(new Date()));
    // Idea 42: last, so it reports everything above — the owner's week, by email, once.
    const summaries = await runWeeklySummaries();
    console.log(
      JSON.stringify({
        event: "weekly_watch",
        ...result,
        progress,
        trials,
        ads,
        stock_warnings,
        stock,
        season_push,
        forecasts,
        reviews_expired,
        carts_expired,
        summaries,
      }),
    );
    return NextResponse.json({
      ...result,
      progress,
      trials,
      ads,
      stock_warnings,
      stock,
      season_push,
      forecasts,
      reviews_expired,
      carts_expired,
      summaries,
    });
  } catch (error) {
    console.error(JSON.stringify({ event: "weekly_watch_failed", ...logSafeError(error) }));
    return NextResponse.json({ error: "job failed" }, { status: 500 });
  }
}
