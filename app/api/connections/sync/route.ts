// POST /api/connections/sync  { id } — "Sync now" on the connections screen.
//
// The same runner the daily cron uses (P2-06), for one connection the
// signed-in account owns. Its advisory lock means a click during the cron
// run stands down instead of interleaving, and its page cap bounds how
// long one request can take: a year of Stripe history is 13 pulls.
//
// A read's progress, live (2026-11-20): a caller that asks for
// `Accept: application/x-ndjson` gets one JSON line per page as it lands
// ({ type: "progress", step, pages, observations }) and a last line with
// what a plain call returns ({ type: "done", ok, skipped, kind, pages,
// observations, error }). Counts only. Who may ask is decided before the
// first line, exactly as for the plain answer; a browser that goes away
// mid-read does not stop the read (a page and its cursor land together).

import { cookies } from "next/headers";
import { type NextRequest, NextResponse } from "next/server";
import { currentSession } from "../../../../lib/auth/service";
import { ConnectorError, ownedConnection } from "../../../../lib/connectors/service";
import type { SyncOutcome } from "../../../../lib/connectors/sync";
import { syncConnection } from "../../../../lib/connectors/sync";
import type { SyncLine } from "../../../../lib/connectors/sync-stream";
import { SYNC_STREAM_TYPE } from "../../../../lib/connectors/sync-stream";
import { requireRole } from "../../../../lib/auth/roles";

export const maxDuration = 60;

const AUTH_COOKIE = "syb_session";

/** What a finished read says, to the plain caller and as the stream's last line. */
function summary(outcome: SyncOutcome) {
  return {
    ok: outcome.ok,
    skipped: outcome.skipped,
    kind: outcome.kind,
    pages: outcome.pages,
    observations: outcome.observations,
    error: outcome.error,
  };
}

/** The read as lines: each page as it lands, then the summary. */
function streamSync(id: string, accountId: string): NextResponse {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // A line that cannot be sent (the browser left) is dropped; the read goes on.
      const line = (value: SyncLine) => {
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`));
        } catch {
          /* nobody is listening */
        }
      };
      try {
        const outcome = await syncConnection(id, new Date(), {
          onProgress: (progress) => line({ type: "progress", ...progress }),
        });
        line({ type: "done", ...summary(outcome) });
      } catch (error) {
        console.error(
          JSON.stringify({
            event: "connection_sync_error",
            account_id: accountId,
            name: error instanceof Error ? error.name : "unknown",
          }),
        );
        line({ type: "failed", error: "something went wrong on our side" });
      }
      try {
        controller.close();
      } catch {
        /* already closed by the browser */
      }
    },
  });
  return new NextResponse(stream, {
    headers: {
      "content-type": `${SYNC_STREAM_TYPE}; charset=utf-8`,
      "cache-control": "no-store, no-transform",
      // A proxy that holds lines back would make the progress arrive all at once.
      "x-accel-buffering": "no",
    },
  });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const store = await cookies();
  const session = await currentSession(store.get(AUTH_COOKIE)?.value);
  if (!session) {
    return NextResponse.json({ error: "sign in to manage connections" }, { status: 401 });
  }
  // I-52b: reading again is a manager's; connecting and disconnecting stay an owner's.
  const denied = requireRole(session, "connections.sync");
  if (denied) return denied;
  try {
    const body = (await request.json().catch(() => null)) as { id?: unknown } | null;
    if (typeof body?.id !== "string") {
      return NextResponse.json({ error: "id is required" }, { status: 422 });
    }
    await ownedConnection(session.account_id, body.id);
    if ((request.headers.get("accept") ?? "").includes(SYNC_STREAM_TYPE)) {
      return streamSync(body.id, session.account_id);
    }
    return NextResponse.json(summary(await syncConnection(body.id)));
  } catch (error) {
    if (error instanceof ConnectorError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error(
      JSON.stringify({
        event: "connection_sync_error",
        account_id: session.account_id,
        name: error instanceof Error ? error.name : "unknown",
      }),
    );
    return NextResponse.json({ error: "something went wrong on our side" }, { status: 500 });
  }
}
