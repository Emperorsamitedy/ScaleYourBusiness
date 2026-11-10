// GET /api/cron/connector-sync — the P2-06 daily sync's trigger.
//
// Same shape as weekly-watch: Vercel cron calls this with
// `Authorization: Bearer ${CRON_SECRET}`; nothing else may run it. The
// job-queue decision is recorded in lib/connectors/sync.ts — this stays a
// cron route until a measured run says otherwise.
//
// I-45a: the daily read of Google Business Profile reviews rides the same
// beat, after the sync, so a poor review is known the day it lands. It is
// its own step: a Google failure is logged and reported as null, and never
// takes the measurement sync with it (or the other way round).
//
// P6-08: the daily upkeep of call recordings rides it too, as its own step:
// fetch what is still pending, delete Twilio copies a failed delete left,
// and delete what is past PHONE_RECORDING_KEEP_DAYS or erased.

import { bearerMatches } from "../../../../lib/core/secret-compare";
import { logSafeError } from "../../../../lib/core/log-safe";
import { type NextRequest, NextResponse } from "next/server";
import { runNavSync } from "../../../../lib/connectors/nav/service";
import { runConnectorSync } from "../../../../lib/connectors/sync";
import { runGoogleReviewReads } from "../../../../lib/google-business/read";
import { runRecordingUpkeep } from "../../../../lib/phone-recording/recordings";

async function isolated<T>(step: string, run: () => Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch (error) {
    console.error(
      JSON.stringify({ event: "connector_sync_step_failed", step, ...logSafeError(error) }),
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
    const result = await isolated("connector_sync", () => runConnectorSync());
    const google_reviews = await isolated("google_reviews", () => runGoogleReviewReads());
    const phone_recordings = await isolated("phone_recordings", () => runRecordingUpkeep());
    // The multi-market spec Part E: NAV keeps its own runner and keys.
    const nav = await isolated("nav", () => runNavSync());
    // A failed sync is still the job failing, as before; the other steps ran anyway.
    if (result === null) {
      return NextResponse.json(
        { error: "job failed", google_reviews, phone_recordings, nav },
        { status: 500 },
      );
    }
    const body = { ...result, google_reviews, phone_recordings, nav };
    console.log(JSON.stringify({ event: "connector_sync_run", ...body }));
    return NextResponse.json(body);
  } catch (error) {
    console.error(JSON.stringify({ event: "connector_sync_run_failed", ...logSafeError(error) }));
    return NextResponse.json({ error: "job failed" }, { status: 500 });
  }
}
