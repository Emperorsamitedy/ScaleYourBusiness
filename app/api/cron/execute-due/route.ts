// GET /api/cron/execute-due — the P3-20e due runner's trigger.
//
// Same shape as connector-sync: Vercel cron calls this with
// `Authorization: Bearer ${CRON_SECRET}`; nothing else may run it. The
// schedule's precision is the hosting decision recorded in
// TASKS-PHASE3.md (Hobby: once a day, ±59 min; Pro: per minute).

import { logSafeError } from "../../../../lib/core/log-safe";
import { type NextRequest, NextResponse } from "next/server";
import { runDueExecutions } from "../../../../lib/execution/due";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
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
