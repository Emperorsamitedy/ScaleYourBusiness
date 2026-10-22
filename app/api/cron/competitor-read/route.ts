// GET /api/cron/competitor-read — feature 35's weekly re-read.
//
// Same shape as weekly-watch: Vercel cron calls this with
// `Authorization: Bearer ${CRON_SECRET}`; nothing else may run it. It
// re-reads every listed competitor page not read in the last six days,
// records what changed as superseded facts and watch-log lines, and
// executes nothing.

import { bearerMatches } from "../../../../lib/core/secret-compare";
import { logSafeError } from "../../../../lib/core/log-safe";
import { type NextRequest, NextResponse } from "next/server";
import { runCompetitorReads } from "../../../../lib/competitors/service";

export const maxDuration = 300;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  if (!bearerMatches(request.headers.get("authorization"), secret)) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  try {
    const result = await runCompetitorReads();
    console.log(JSON.stringify({ event: "competitor_read_run", ...result }));
    return NextResponse.json(result);
  } catch (error) {
    console.error(JSON.stringify({ event: "competitor_read_run_failed", ...logSafeError(error) }));
    return NextResponse.json({ error: "job failed" }, { status: 500 });
  }
}
