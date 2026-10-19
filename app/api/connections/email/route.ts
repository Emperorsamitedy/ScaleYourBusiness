// The campaign-email consent API — P4-15 (Phase 4 Session F), rule 13.
//
//   GET     /api/connections/email   the consent screen: the registry's lines (with the sender
//                                    filled once granted), the phrase, the suggested sender name,
//                                    and the account's campaign-email connection
//   POST    /api/connections/email   { sender_name, reply_to, confirmation }: consent
//   DELETE  /api/connections/email   { id }: disconnect, one click
//
// A separate door from /api/connections (read-only credentials) and from
// /api/connections/execute (Meta tokens): campaign email has no owner
// credential at all — it sends from SYB's own account — so what comes in
// here is consent and a sender identity. Signed-in sessions only.

import { cookies } from "next/headers";
import { type NextRequest, NextResponse } from "next/server";
import type { AuthedSession } from "../../../../lib/auth/service";
import { currentSession } from "../../../../lib/auth/service";
import {
  ExecutionConnectionError,
  activeExecutionConnection,
  disconnectExecution,
  toPublicExecutionConnection,
} from "../../../../lib/execution/connections";
import {
  EMAIL_CAMPAIGN_PHRASE,
  EMAIL_DISCONNECT_NOTE,
  EMAIL_NOTHING_SENT,
  consentToCampaignEmail,
  emailConsentLines,
  senderIdentity,
} from "../../../../lib/execution/email-consent";
import { EXECUTION_SCOPE_REGISTRY } from "../../../../lib/execution/scopes";
import { sessionDRealWritesOn } from "../../../../lib/env";
import { realWritesOffSentence } from "../../../../lib/execution/engine";
import { db } from "../../../../db";
import { businessProfiles } from "../../../../db/schema";
import { asc, eq } from "drizzle-orm";
import { readCurrentField } from "../../../../lib/profile/field-store";
import { BUSINESS_NAME_KEY } from "../../../../lib/crm/support-settings";

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
  console.error(
    JSON.stringify({
      event: "email_connection_error",
      account_id: accountId,
      name: error instanceof Error ? error.name : "unknown",
    }),
  );
  return NextResponse.json({ error: "something went wrong on our side" }, { status: 500 });
}

async function suggestedName(accountId: string): Promise<string> {
  const [profile] = await db
    .select({ id: businessProfiles.id })
    .from(businessProfiles)
    .where(eq(businessProfiles.account_id, accountId))
    .orderBy(asc(businessProfiles.created_at))
    .limit(1);
  if (!profile) return "";
  const f = await readCurrentField<unknown>(profile.id, BUSINESS_NAME_KEY);
  return f && f.status === "answered" && typeof f.value === "string" ? f.value.trim() : "";
}

export async function GET(): Promise<NextResponse> {
  const session = await signedIn();
  if (!session) return unauthorised();
  try {
    const row = await activeExecutionConnection(session.account_id, "email_campaign");
    const spec = EXECUTION_SCOPE_REGISTRY.email_campaign;
    const sender =
      row?.sender_name && row.reply_to ? senderIdentity(row.sender_name, row.reply_to) : null;
    return NextResponse.json({
      label: spec.label,
      // Verbatim from the registry. Granted: filled with the sender on record.
      // Not yet: the template, which the screen fills as the owner types,
      // with the same function the consent hash uses (lib/execution/email-sender).
      consent: sender ? emailConsentLines(sender) : null,
      consent_template: spec.consent.map((c) => c.why),
      operations: spec.operations,
      confirm_phrase: EMAIL_CAMPAIGN_PHRASE,
      suggested_sender: await suggestedName(session.account_id),
      nothing_sent: EMAIL_NOTHING_SENT,
      disconnect_note: EMAIL_DISCONNECT_NOTE,
      real_sends: sessionDRealWritesOn() ? null : realWritesOffSentence(spec.label),
      connection: row ? toPublicExecutionConnection(row) : null,
    });
  } catch (error) {
    return onError(error, session.account_id);
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const session = await signedIn();
  if (!session) return unauthorised();
  try {
    const body = (await request.json().catch(() => null)) as {
      sender_name?: unknown;
      reply_to?: unknown;
      confirmation?: unknown;
    } | null;
    if (
      typeof body?.sender_name !== "string" ||
      typeof body.reply_to !== "string" ||
      typeof body.confirmation !== "string"
    ) {
      return NextResponse.json(
        { error: "the sender name, the reply address and the typed confirmation are required" },
        { status: 422 },
      );
    }
    const { connection } = await consentToCampaignEmail({
      accountId: session.account_id,
      senderName: body.sender_name,
      replyTo: body.reply_to,
      confirmation: body.confirmation,
    });
    return NextResponse.json(connection, { status: 201 });
  } catch (error) {
    return onError(error, session.account_id);
  }
}

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  const session = await signedIn();
  if (!session) return unauthorised();
  try {
    const body = (await request.json().catch(() => null)) as { id?: unknown } | null;
    if (typeof body?.id !== "string") {
      return NextResponse.json({ error: "id is required" }, { status: 422 });
    }
    const row = await activeExecutionConnection(session.account_id, "email_campaign");
    if (!row || row.id !== body.id) {
      return NextResponse.json({ error: "connection not found" }, { status: 404 });
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
