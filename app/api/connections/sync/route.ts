// POST /api/connections/sync  { id } — "Sync now" on the connections screen.
//
// The same runner the daily cron uses (P2-06), for one connection the
// signed-in account owns. Its advisory lock means a click during the cron
// run stands down instead of interleaving, and its page cap bounds how
// long one request can take: a year of Stripe history is 13 pulls.

import { cookies } from "next/headers";
import { type NextRequest, NextResponse } from "next/server";
import { currentSession } from "../../../../lib/auth/service";
import { ConnectorError, ownedConnection } from "../../../../lib/connectors/service";
import { syncConnection } from "../../../../lib/connectors/sync";
import { requireRole } from "../../../../lib/auth/roles";

export const maxDuration = 60;

const AUTH_COOKIE = "syb_session";

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
    const outcome = await syncConnection(body.id);
    return NextResponse.json({
      ok: outcome.ok,
      skipped: outcome.skipped,
      kind: outcome.kind,
      pages: outcome.pages,
      observations: outcome.observations,
      error: outcome.error,
    });
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
