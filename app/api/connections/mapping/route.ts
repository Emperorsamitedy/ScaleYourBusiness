// Matching a connected provider's items to the profile — P2-15 (store
// products to offers), P2-18 (analytics channels to sales channels).
//
//   GET  /api/connections/mapping?id=<connection>   entities, items, suggestions
//   PUT  /api/connections/mapping                   { id, entity_id, ref | null }
//
// Suggestions are computed; nothing is stored until the owner confirms.
// Signed-in sessions only, and only for a connection the account owns.

import { logSafeError } from "../../../../lib/core/log-safe";
import { cookies } from "next/headers";
import { type NextRequest, NextResponse } from "next/server";
import type { AuthedSession } from "../../../../lib/auth/service";
import { currentSession } from "../../../../lib/auth/service";
import { confirmMapping, mappingView } from "../../../../lib/connectors/mapping";
import { ConnectorError } from "../../../../lib/connectors/service";

const AUTH_COOKIE = "syb_session";

async function signedIn(): Promise<AuthedSession | null> {
  const store = await cookies();
  return currentSession(store.get(AUTH_COOKIE)?.value);
}

function onError(error: unknown, accountId: string): NextResponse {
  if (error instanceof ConnectorError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  console.error(
    JSON.stringify({
      event: "mapping_error",
      account_id: accountId,
      name: error instanceof Error ? error.name : "unknown",
      ...logSafeError(error),
    }),
  );
  return NextResponse.json({ error: "something went wrong on our side" }, { status: 500 });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const session = await signedIn();
  if (!session) {
    return NextResponse.json({ error: "sign in to manage connections" }, { status: 401 });
  }
  const id = request.nextUrl.searchParams.get("id");
  if (id === null) return NextResponse.json({ error: "id is required" }, { status: 422 });
  try {
    return NextResponse.json(await mappingView(session.account_id, id));
  } catch (error) {
    return onError(error, session.account_id);
  }
}

export async function PUT(request: NextRequest): Promise<NextResponse> {
  const session = await signedIn();
  if (!session) {
    return NextResponse.json({ error: "sign in to manage connections" }, { status: 401 });
  }
  try {
    const body = (await request.json().catch(() => null)) as {
      id?: unknown;
      entity_id?: unknown;
      ref?: unknown;
    } | null;
    if (typeof body?.id !== "string" || typeof body.entity_id !== "string") {
      return NextResponse.json({ error: "id and entity_id are required" }, { status: 422 });
    }
    if (body.ref !== null && typeof body.ref !== "string") {
      return NextResponse.json({ error: "ref must be an item or null" }, { status: 422 });
    }
    return NextResponse.json(
      await confirmMapping({
        accountId: session.account_id,
        connectionId: body.id,
        entityId: body.entity_id,
        ref: body.ref,
      }),
    );
  } catch (error) {
    return onError(error, session.account_id);
  }
}
