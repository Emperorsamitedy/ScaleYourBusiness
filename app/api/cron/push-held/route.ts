// GET /api/cron/push-held — idea 53 (I-53.4): the morning beat for phone
// alerts that quiet hours or the daily cap held back.
//
// An alert for a new proposal goes out right after the request that made
// it (lib/push/flush.ts). What waits is sent here. No existing beat could
// carry it: every daily cron runs between 03:00 and 05:45 UTC, inside
// quiet hours (21:00–08:00) for every European business. 07:00 UTC is
// 08:00 in Central Europe in winter and 09:00 in summer. Vercel Hobby runs
// it once a day within the hour; on a per-hour schedule (Pro) every zone's
// held alerts would go at its own 08:00. pushPlan keeps the rules whatever
// the beat: it never sends inside quiet hours.
//
// Same shape as the other crons: `Authorization: Bearer ${CRON_SECRET}`.

import { type NextRequest, NextResponse } from "next/server";
import { bearerMatches } from "../../../../lib/core/secret-compare";
import { logSafeError } from "../../../../lib/core/log-safe";
import { flushHeldPushes } from "../../../../lib/push/flush";

// Sends are sequential, 10 s at most each: a few minutes covers many accounts.
export const maxDuration = 300;

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!bearerMatches(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  try {
    const summary = await flushHeldPushes();
    console.log(JSON.stringify({ event: "push_held_run", ...summary }));
    return NextResponse.json(summary);
  } catch (error) {
    console.error(JSON.stringify({ event: "push_held_run_failed", ...logSafeError(error) }));
    return NextResponse.json({ error: "job failed" }, { status: 500 });
  }
}
