// The execute-connections API — P3-20h/i (Session D, layer D1), rule 13.
//
//   GET     /api/connections/execute   the consent screen: what may be written, how to set it up,
//                                      Meta's access level, whether Facebook Login (P3-20j) is
//                                      armed, and the account's execute connections
//   POST    /api/connections/execute   { provider, secret, confirmation }: consent and connect
//   DELETE  /api/connections/execute   { id }: disconnect (the token is wiped here; Meta keeps its grant)
//
// A separate door from /api/connections, which only ever accepts read-only
// credentials (rule 9). Signed-in sessions only. The credential arrives in
// the body, is proven and encrypted before it touches the database, and
// never leaves again; nothing here logs a request body.

import { cookies } from "next/headers";
import { type NextRequest, NextResponse } from "next/server";
import type { AuthedSession } from "../../../../lib/auth/service";
import { currentSession } from "../../../../lib/auth/service";
import { metaAccessLevel, metaLoginEnv } from "../../../../lib/env";
import {
  ExecutionConnectionError,
  disconnectExecution,
  listExecutionConnections,
} from "../../../../lib/execution/connections";
import { consentToExecution } from "../../../../lib/execution/consent";
import { metaExecution } from "../../../../lib/execution/providers/meta";
import { EXECUTION_SCOPE_REGISTRY } from "../../../../lib/execution/scopes";
import {
  ADS_ACCESS_TIER_NOTE,
  DISCONNECT_NOTE,
  EXECUTION_SETUP,
  FACEBOOK_LOGIN_OFF,
  NOTHING_SENT_YET,
  OFFERED_EXECUTION,
  ONE_CONSENT_PER_FACEBOOK_ACCOUNT,
  TESTER_NOTE,
  accessLevelCopy,
  accessTierWords,
} from "../../../../lib/execution/setup";
import { requireRole } from "../../../../lib/auth/roles";

const AUTH_COOKIE = "syb_session";

async function signedIn(): Promise<AuthedSession | null> {
  const store = await cookies();
  return currentSession(store.get(AUTH_COOKIE)?.value);
}

function unauthorised(): NextResponse {
  return NextResponse.json({ error: "sign in to manage connections" }, { status: 401 });
}

function onError(error: unknown, accountId: string): NextResponse {
  if (error instanceof ExecutionConnectionError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  // The error's name only: an unexpected error's message could quote input.
  console.error(
    JSON.stringify({
      event: "execute_connections_error",
      account_id: accountId,
      name: error instanceof Error ? error.name : "unknown",
    }),
  );
  return NextResponse.json({ error: "something went wrong on our side" }, { status: 500 });
}

export async function GET(): Promise<NextResponse> {
  const session = await signedIn();
  if (!session) return unauthorised();
  try {
    // P3-20j: Facebook Login is offered only when SYB's Meta app keys are set.
    const facebookLogin = metaLoginEnv() !== null;
    return NextResponse.json({
      access: accessLevelCopy(metaAccessLevel(), facebookLogin),
      facebook_login: {
        available: facebookLogin,
        tester_note: TESTER_NOTE,
        one_consent_note: ONE_CONSENT_PER_FACEBOOK_ACCOUNT,
        off_note: FACEBOOK_LOGIN_OFF,
      },
      nothing_sent: NOTHING_SENT_YET,
      disconnect_note: DISCONNECT_NOTE,
      // P3-22d: the ad connection's last-seen access tier, in words beside Meta's own.
      ads_access_note: ADS_ACCESS_TIER_NOTE,
      connections: (await listExecutionConnections(session.account_id)).map((c) => ({
        ...c,
        access_tier_words: c.provider === "meta_ads" ? accessTierWords(c.access_tier) : null,
      })),
      providers: OFFERED_EXECUTION.map((id) => {
        const spec = EXECUTION_SCOPE_REGISTRY[id];
        const setup = EXECUTION_SETUP[id];
        return {
          id,
          label: spec.label,
          consent: spec.consent,
          readback_scopes: spec.readback_scopes,
          operations: spec.operations,
          confirm_phrase: setup?.confirm_phrase ?? null,
          credential_fields: setup?.credential_fields ?? [],
          own_app_steps: setup?.own_app_steps ?? [],
        };
      }),
    });
  } catch (error) {
    return onError(error, session.account_id);
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const session = await signedIn();
  if (!session) return unauthorised();
  const denied = requireRole(session, "write_access.manage");
  if (denied) return denied;
  try {
    const body = (await request.json().catch(() => null)) as {
      provider?: unknown;
      secret?: unknown;
      confirmation?: unknown;
    } | null;
    const provider = body?.provider;
    if (provider !== "meta_publish" && provider !== "meta_ads") {
      return NextResponse.json({ error: "unknown provider" }, { status: 422 });
    }
    if (typeof body?.secret !== "string") {
      return NextResponse.json({ error: "a credential is required" }, { status: 422 });
    }
    if (typeof body.confirmation !== "string") {
      return NextResponse.json({ error: "the typed confirmation is required" }, { status: 422 });
    }
    const { connection } = await consentToExecution({
      accountId: session.account_id,
      provider,
      secret: body.secret,
      confirmation: body.confirmation,
      verify: metaExecution.verifier(provider),
    });
    return NextResponse.json(connection, { status: 201 });
  } catch (error) {
    return onError(error, session.account_id);
  }
}

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  const session = await signedIn();
  if (!session) return unauthorised();
  const denied = requireRole(session, "write_access.manage");
  if (denied) return denied;
  try {
    const body = (await request.json().catch(() => null)) as { id?: unknown } | null;
    if (typeof body?.id !== "string") {
      return NextResponse.json({ error: "id is required" }, { status: 422 });
    }
    const connection = await disconnectExecution(session.account_id, body.id);
    console.log(
      JSON.stringify({
        event: "execution_disconnected",
        account_id: session.account_id,
        provider: connection.provider,
        connection_id: connection.id,
      }),
    );
    return NextResponse.json(connection);
  } catch (error) {
    return onError(error, session.account_id);
  }
}
