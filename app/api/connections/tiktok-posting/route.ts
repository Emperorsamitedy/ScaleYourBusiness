// The TikTok posting consent API — 2026-11-08, rule 13.
//
//   GET     /api/connections/tiktok-posting   the card: what SYB may post, what it can't undo,
//                                             what TikTok allows until its audit, whether it's
//                                             set up, and the connection (never its secret)
//   DELETE  /api/connections/tiktok-posting   { id }: disconnect (deleted here at once, and
//                                             TikTok asked to revoke the token too)
//
// Granting goes through ./start (the typed phrase, then TikTok's own screen)
// and ./callback. Signed-in sessions of this business only; granting and
// revoking are the owner's own (write_access.manage).

import { type NextRequest, NextResponse } from "next/server";
import { resolveAccess } from "../../../../lib/auth/access";
import { requireRole } from "../../../../lib/auth/roles";
import { logSafeError } from "../../../../lib/core/log-safe";
import { tiktokAuditStatus, tiktokPostingEnv } from "../../../../lib/env";
import {
  ExecutionConnectionError,
  activeExecutionConnection,
  executionSecret,
  toPublicExecutionConnection,
} from "../../../../lib/execution/connections";
import { TIKTOK_PROVIDER, parseTikTokCredential } from "../../../../lib/execution/providers/tiktok";
import { EXECUTION_SCOPE_REGISTRY } from "../../../../lib/execution/scopes";
import {
  TIKTOK_ACCESS_WORDS,
  TIKTOK_NEEDS,
  TIKTOK_NOT_SET_UP,
  TIKTOK_PHRASE,
  TIKTOK_REVOKE_NOTE,
  revokeTikTokPosting,
  tiktokConsentLines,
} from "../../../../lib/execution/tiktok-posting";

function onError(error: unknown, accountId: string): NextResponse {
  if (error instanceof ExecutionConnectionError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  console.error(
    JSON.stringify({
      event: "tiktok_posting_route_error",
      account_id: accountId,
      ...logSafeError(error),
    }),
  );
  return NextResponse.json({ error: "something went wrong on our side" }, { status: 500 });
}

export async function GET(): Promise<NextResponse> {
  const access = await resolveAccess();
  const session = access?.session ?? null;
  if (!access || !session) {
    return NextResponse.json({ error: "sign in to manage connections" }, { status: 401 });
  }
  try {
    const configured = tiktokPostingEnv() !== null;
    const audit = tiktokAuditStatus();
    const row = await activeExecutionConnection(session.account_id, TIKTOK_PROVIDER);
    let account: { nickname: string | null; username: string | null } | null = null;
    if (row && row.encrypted_secret !== null) {
      try {
        const cred = parseTikTokCredential(executionSecret(row));
        account = { nickname: cred.nickname, username: cred.username };
      } catch {
        account = null;
      }
    }
    const spec = EXECUTION_SCOPE_REGISTRY[TIKTOK_PROVIDER];
    return NextResponse.json({
      label: spec.label,
      configured,
      not_set_up: configured ? null : TIKTOK_NOT_SET_UP,
      audited: audit === "audited",
      access_words: TIKTOK_ACCESS_WORDS[audit],
      // Verbatim from the registry: the card can't promise what it doesn't declare.
      consent: tiktokConsentLines(),
      scope: spec.write_scopes[0],
      readback_scopes: [...spec.readback_scopes],
      operations: spec.operations.map((o) => ({
        op: o.op,
        description: o.description,
        reversible: o.reversible,
      })),
      needs: TIKTOK_NEEDS,
      confirm_phrase: TIKTOK_PHRASE,
      revoke_note: TIKTOK_REVOKE_NOTE,
      connection: row ? toPublicExecutionConnection(row) : null,
      account,
    });
  } catch (error) {
    return onError(error, session.account_id);
  }
}

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  const access = await resolveAccess();
  const session = access?.session ?? null;
  if (!access || !session) {
    return NextResponse.json({ error: "sign in to manage connections" }, { status: 401 });
  }
  // Write access is the owner's own consent (rule 13, idea 52).
  const denied = requireRole(session, "write_access.manage");
  if (denied) return denied;
  try {
    const body = (await request.json().catch(() => null)) as { id?: unknown } | null;
    if (typeof body?.id !== "string") {
      return NextResponse.json({ error: "id is required" }, { status: 422 });
    }
    return NextResponse.json(await revokeTikTokPosting(session.account_id, body.id));
  } catch (error) {
    return onError(error, session.account_id);
  }
}
