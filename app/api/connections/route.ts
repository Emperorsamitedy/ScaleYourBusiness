// The connections API — Phase 2 Sessions B, C and D.
//
//   GET     /api/connections   the account's connections, plus what each provider asks for
//   POST    /api/connections   { provider, secret }: connect (proven, scope-checked, encrypted)
//   DELETE  /api/connections   { id }: disconnect (the credential is wiped, the row is kept)
//
// Connecting a payment account, a store, an analytics property or an ad
// account is an account-level act, so every method requires a signed-in
// session (the magic-link session from P1-49), not merely the anonymous
// intake cookie. The credential arrives in a request body, is encrypted
// before it touches the database, and never leaves again: every response
// is built from PublicConnection, and nothing here logs a request body.

import { cookies } from "next/headers";
import { type NextRequest, NextResponse } from "next/server";
import type { AuthedSession } from "../../../lib/auth/service";
import { currentSession } from "../../../lib/auth/service";
import { CREDENTIAL_FIELDS } from "../../../lib/connectors/credentials";
import { mappingKindFor } from "../../../lib/connectors/mapping";
import { FIXTURE_BACKFILL_DAYS } from "../../../lib/connectors/providers/fixture";
import { GA4_HISTORY_DAYS } from "../../../lib/connectors/providers/ga4";
import { META_HISTORY_DAYS } from "../../../lib/connectors/providers/meta-ads";
import { SC_HISTORY_DAYS } from "../../../lib/connectors/providers/search-console";
import { SQUARE_HISTORY_DAYS } from "../../../lib/connectors/providers/square";
import { historyDaysFor } from "../../../lib/connectors/providers/shopify";
import { STRIPE_BACKFILL_DAYS } from "../../../lib/connectors/providers/stripe";
import { WOO_BACKFILL_DAYS } from "../../../lib/connectors/providers/woocommerce";
import { getProvider } from "../../../lib/connectors/registry";
import type { ProviderId } from "../../../lib/connectors/scopes";
import { SCOPE_GUIDE, isProviderId } from "../../../lib/connectors/scopes";
import type { PublicConnection } from "../../../lib/connectors/service";
import {
  ConnectorError,
  connect,
  disconnectForAccount,
  listConnections,
} from "../../../lib/connectors/service";
import { requireRole } from "../../../lib/auth/roles";

const AUTH_COOKIE = "syb_session";

/** How far back a connection's history reaches, given what it was granted. */
function historyDays(provider: string, grantedScopes: readonly string[]): number {
  switch (provider) {
    case "shopify":
      return historyDaysFor(grantedScopes);
    case "woocommerce":
      return WOO_BACKFILL_DAYS;
    case "stripe":
      return STRIPE_BACKFILL_DAYS;
    case "ga4":
      return GA4_HISTORY_DAYS;
    case "meta_ads":
      return META_HISTORY_DAYS;
    case "search_console":
      return SC_HISTORY_DAYS;
    case "square":
      return SQUARE_HISTORY_DAYS;
    default:
      return FIXTURE_BACKFILL_DAYS;
  }
}

/** The fixture exists for tests and local UI work. It is never offered in production. */
function offered(): ProviderId[] {
  const live: ProviderId[] = [
    "stripe",
    "shopify",
    "woocommerce",
    "ga4",
    "meta_ads",
    "search_console",
    "square",
  ];
  return process.env.NODE_ENV === "production" ? live : [...live, "fixture"];
}

async function signedIn(): Promise<AuthedSession | null> {
  const store = await cookies();
  return currentSession(store.get(AUTH_COOKIE)?.value);
}

function unauthorised(): NextResponse {
  return NextResponse.json({ error: "sign in to manage connections" }, { status: 401 });
}

function onError(error: unknown, accountId: string): NextResponse {
  if (error instanceof ConnectorError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  // The error's name only: an unexpected error's message could quote input.
  console.error(
    JSON.stringify({
      event: "connections_error",
      account_id: accountId,
      name: error instanceof Error ? error.name : "unknown",
    }),
  );
  return NextResponse.json({ error: "something went wrong on our side" }, { status: 500 });
}

/** What the owner can match on this provider: "product", "channel", or null (P2-15, P2-18). */
function matching(provider: string): "product" | "channel" | null {
  return isProviderId(provider) ? mappingKindFor(getProvider(provider)) : null;
}

function describe(c: PublicConnection) {
  return {
    ...c,
    history_days: historyDays(c.provider, c.granted_scopes),
    matching: matching(c.provider),
  };
}

export async function GET(): Promise<NextResponse> {
  const session = await signedIn();
  if (!session) return unauthorised();
  try {
    return NextResponse.json({
      connections: (await listConnections(session.account_id)).map(describe),
      providers: offered().map((id) => {
        const provider = getProvider(id);
        return {
          id,
          label: provider.label,
          scope_verification: provider.scopeVerification,
          guide: SCOPE_GUIDE[id],
          credential_fields: CREDENTIAL_FIELDS[id],
          matching: mappingKindFor(provider),
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
  const denied = requireRole(session, "connections.manage");
  if (denied) return denied;
  try {
    const body = (await request.json().catch(() => null)) as {
      provider?: unknown;
      secret?: unknown;
    } | null;
    const provider = body?.provider;
    const secret = body?.secret;
    if (typeof provider !== "string" || !isProviderId(provider) || !offered().includes(provider)) {
      return NextResponse.json({ error: "unknown provider" }, { status: 422 });
    }
    if (typeof secret !== "string") {
      return NextResponse.json({ error: "a credential is required" }, { status: 422 });
    }
    const connection = await connect(session.account_id, provider, secret);
    console.log(
      JSON.stringify({
        event: "connector_connected",
        account_id: session.account_id,
        provider,
        connection_id: connection.id,
      }),
    );
    return NextResponse.json(describe(connection), { status: 201 });
  } catch (error) {
    return onError(error, session.account_id);
  }
}

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  const session = await signedIn();
  if (!session) return unauthorised();
  const denied = requireRole(session, "connections.manage");
  if (denied) return denied;
  try {
    const body = (await request.json().catch(() => null)) as { id?: unknown } | null;
    if (typeof body?.id !== "string") {
      return NextResponse.json({ error: "id is required" }, { status: 422 });
    }
    const connection = await disconnectForAccount(session.account_id, body.id);
    console.log(
      JSON.stringify({
        event: "connector_disconnected",
        account_id: session.account_id,
        provider: connection.provider,
        connection_id: connection.id,
      }),
    );
    return NextResponse.json(describe(connection));
  } catch (error) {
    return onError(error, session.account_id);
  }
}
