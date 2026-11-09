// GET /api/cron/collect-video — AI video collected in the background (P6-03;
// the owner's decision of 2026-11-09: submit now, collect later).
//
// Approving a set of candidates only submits them. This asks Higgsfield
// after every candidate still being made (polling is the source of truth;
// its webhook isn't documented), downloads, labels and stores what
// finished, retries what failed unbilled, and closes what ran out of time —
// a request Higgsfield never billed gives its cap room back, and a closed
// set no longer holds its proposal open. Hard caps per run
// (COLLECT_LIMITS). The studio runs the same pass for its own business
// while a set is being made; this is the backstop for everyone else.
//
// Schedule: vercel.json. The project is on Vercel Hobby, whose crons run
// once a day, so it is daily; on Pro make it every five minutes
// (`*/5 * * * *`). Same shape as the other crons: Vercel calls it with
// `Authorization: Bearer ${CRON_SECRET}`.

import { type NextRequest, NextResponse } from "next/server";
import { collectCandidates } from "../../../../lib/content/candidates";
import { logSafeError } from "../../../../lib/core/log-safe";
import { bearerMatches } from "../../../../lib/core/secret-compare";

export const maxDuration = 300;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  if (!bearerMatches(request.headers.get("authorization"), secret)) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  try {
    return NextResponse.json(await collectCandidates());
  } catch (error) {
    console.error(JSON.stringify({ event: "collect_video_run_failed", ...logSafeError(error) }));
    return NextResponse.json({ error: "job failed" }, { status: 500 });
  }
}
