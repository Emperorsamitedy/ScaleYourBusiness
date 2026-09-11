// GET /api/cron/weekly-watch — the P1-46 weekly job's trigger.
//
// Vercel cron calls this with `Authorization: Bearer ${CRON_SECRET}`
// when CRON_SECRET is set in the environment; nothing else may run it.
// No job queue until Phase 2 (CLAUDE.md), and a weekly snapshot+diff
// completes in seconds — a cron-hit route is the whole requirement.

import { type NextRequest, NextResponse } from "next/server";
import { runWeeklyWatch } from "../../../../lib/watch/job";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  try {
    const result = await runWeeklyWatch();
    console.log(JSON.stringify({ event: "weekly_watch", ...result }));
    return NextResponse.json(result);
  } catch (error) {
    console.error(JSON.stringify({ event: "weekly_watch_failed", message: String(error) }));
    return NextResponse.json({ error: "job failed" }, { status: 500 });
  }
}
