// GET /api/cron/execute-due — the P3-20e due runner's trigger.
//
// Same shape as connector-sync: Vercel cron calls this with
// `Authorization: Bearer ${CRON_SECRET}`; nothing else may run it. The
// schedule's precision is the hosting decision recorded in
// TASKS-PHASE3.md (Hobby: once a day, ±59 min; Pro: per minute).

import { bearerMatches } from "../../../../lib/core/secret-compare";
import { logSafeError } from "../../../../lib/core/log-safe";
import { type NextRequest, NextResponse } from "next/server";
import { runDueExecutions } from "../../../../lib/execution/due";

// Review 2026-10-23 (#24): one campaign run of 50 recipients paced 600 ms
// apart takes about 40–60 s, and a pass can hold several. 300 s is the
// ceiling Vercel allows, and it stays well inside the campaign reclaim's
// 15 minutes (STALE_RUN_MS), so a live run is never mistaken for a dead one.
export const maxDuration = 300;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  if (!bearerMatches(request.headers.get("authorization"), secret)) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  try {
    const { outcomes, ...summary } = await runDueExecutions();
    return NextResponse.json({ ...summary, outcomes: outcomes.length });
  } catch (error) {
    console.error(JSON.stringify({ event: "execute_due_run_failed", ...logSafeError(error) }));
    return NextResponse.json({ error: "job failed" }, { status: 500 });
  }
}
