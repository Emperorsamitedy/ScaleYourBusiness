// GET /api/cron/daily-warnings — warnings sent at once (2026-11-20): the
// morning look at stock and cash, and the alerts for what is news.
//
// The warnings that look ahead (an item that runs out before its next
// delivery, the cash forecast's first tight week) were only looked for on
// Mondays, by the weekly beat. This beat looks every other morning, after
// the daily sync has read the day's figures (04:30 UTC) and before the
// morning beat for held phone alerts (07:00 UTC), which sends the alert
// once quiet hours end. Not on Mondays: the weekly beat makes the same
// checks itself and raises the alerts after its summaries have gone, so the
// email is not sent beside a summary that carries the same sentence.
//
// Arithmetic over the database only: no connector, no model, nothing
// proposed (lib/warnings/daily).
//
// Same shape as the other crons: `Authorization: Bearer ${CRON_SECRET}`.

import { type NextRequest, NextResponse } from "next/server";
import { bearerMatches } from "../../../../lib/core/secret-compare";
import { logSafeError } from "../../../../lib/core/log-safe";
import { runDailyWarnings } from "../../../../lib/warnings/daily";

// One business is a handful of reads; an email or a phone alert is 10 s at most.
export const maxDuration = 300;

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!bearerMatches(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  try {
    const result = await runDailyWarnings();
    console.log(JSON.stringify({ event: "daily_warnings", ...result }));
    return NextResponse.json(result);
  } catch (error) {
    console.error(JSON.stringify({ event: "daily_warnings_failed", ...logSafeError(error) }));
    return NextResponse.json({ error: "job failed" }, { status: 500 });
  }
}
