// GET /api/cron/render-footage — the cutting room's sweep (P3-52).
//
// A render normally runs right after the owner asks for it, inside that
// request's function (`after` in /api/content/media). This is the backstop
// for a run that was cut short or waited for a server with FFmpeg: every
// queued render with attempts left, and every one a dead function left
// `rendering`, one at a time inside the time budget. Same shape as the
// other crons: Vercel calls it with `Authorization: Bearer ${CRON_SECRET}`.

import { bearerMatches } from "../../../../lib/core/secret-compare";
import { logSafeError } from "../../../../lib/core/log-safe";
import { type NextRequest, NextResponse } from "next/server";
import { sweepRenders } from "../../../../lib/content/footage";

export const maxDuration = 300;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  if (!bearerMatches(request.headers.get("authorization"), secret)) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  try {
    const { ran, left } = await sweepRenders();
    const by = (s: string) => ran.filter((r) => r.status === s).length;
    return NextResponse.json({
      ran: ran.length,
      rendered: by("rendered"),
      waiting: by("waiting"),
      retrying: by("retrying"),
      failed: by("failed"),
      left,
    });
  } catch (error) {
    console.error(JSON.stringify({ event: "render_footage_run_failed", ...logSafeError(error) }));
    return NextResponse.json({ error: "job failed" }, { status: 500 });
  }
}
