// GET /api/cron/connector-sync — the P2-06 daily sync's trigger.
//
// Same shape as weekly-watch: Vercel cron calls this with
// `Authorization: Bearer ${CRON_SECRET}`; nothing else may run it. The
// job-queue decision is recorded in lib/connectors/sync.ts — this stays a
// cron route until a measured run says otherwise.

import { logSafeError } from "../../../../lib/core/log-safe";
import { type NextRequest, NextResponse } from "next/server";
import { runConnectorSync } from "../../../../lib/connectors/sync";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  try {
    const result = await runConnectorSync();
    console.log(JSON.stringify({ event: "connector_sync_run", ...result }));
    return NextResponse.json(result);
  } catch (error) {
    console.error(JSON.stringify({ event: "connector_sync_run_failed", ...logSafeError(error) }));
    return NextResponse.json({ error: "job failed" }, { status: 500 });
  }
}
