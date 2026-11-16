// GET /api/cron/count-towns — gap 7 (TASKS-IDEAS), daily. Counts the oldest
// queued towns on OpenStreetMap, two a run: the public servers are slow and
// shared, so a few each day, politely. Same shape as the other crons: Vercel
// calls it with `Authorization: Bearer ${CRON_SECRET}`.

import { type NextRequest, NextResponse } from "next/server";
import { bearerMatches } from "../../../../lib/core/secret-compare";
import { logSafeError } from "../../../../lib/core/log-safe";
import { countQueuedTowns } from "../../../../lib/ideas/towns";

export const maxDuration = 300;

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!bearerMatches(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  try {
    const summary = await countQueuedTowns({ limit: 2 });
    console.log(JSON.stringify({ event: "count_towns_cron", account_id: null, ...summary }));
    return NextResponse.json(summary);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "count_towns_cron_failed",
        account_id: null,
        ...logSafeError(error),
      }),
    );
    return NextResponse.json({ error: "job failed" }, { status: 500 });
  }
}
