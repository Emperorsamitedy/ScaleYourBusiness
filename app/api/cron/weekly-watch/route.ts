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
import { runHoursTrials } from "../../../../lib/hours/trials";
import { runStockProposals } from "../../../../lib/stock/propose";
import { runWeeklySummaries } from "../../../../lib/summary/run";
import { runWeeklyWatch } from "../../../../lib/watch/job";

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
    // Feature 34: slow stock becomes ways to clear it — proposals only, never executed here.
    const stock = await runStockProposals();
    // Idea 42: last, so it reports everything above — the owner's week, by email, once.
    const summaries = await runWeeklySummaries();
    console.log(
      JSON.stringify({ event: "weekly_watch", ...result, progress, trials, ads, stock, summaries }),
    );
    return NextResponse.json({ ...result, progress, trials, ads, stock, summaries });
  } catch (error) {
    console.error(JSON.stringify({ event: "weekly_watch_failed", ...logSafeError(error) }));
    return NextResponse.json({ error: "job failed" }, { status: 500 });
  }
}
