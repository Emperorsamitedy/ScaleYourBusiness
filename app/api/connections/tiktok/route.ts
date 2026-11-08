// The TikTok Ads consent API — TikTok Ads (specs/tiktok-ads-api-v1.md), rule 13.
//
//   GET     /api/connections/tiktok   the card: what the one consent covers (read AND act —
//                                     TikTok can't separate them), whether SYB's TikTok app is
//                                     set up and exactly which settings are missing, the
//                                     connection and how the last read went
//   DELETE  /api/connections/tiktok   { id }: revoke (the access is deleted here at once)
//
// Granting goes through ./start (the typed phrase, then TikTok's own page)
// and ./callback. Signed-in sessions of this business only; granting and
// revoking are the owner's own (write_access.manage).

import { type NextRequest, NextResponse } from "next/server";
import { resolveAccess } from "../../../../lib/auth/access";
import { requireRole } from "../../../../lib/auth/roles";
import { logSafeError } from "../../../../lib/core/log-safe";
import { tiktokAdsEnv, tiktokAdsMissing } from "../../../../lib/env";
import {
  ExecutionConnectionError,
  activeExecutionConnection,
  toPublicExecutionConnection,
} from "../../../../lib/execution/connections";
import { EXECUTION_SCOPE_REGISTRY } from "../../../../lib/execution/scopes";
import { parseTikTokCredential } from "../../../../lib/tiktok/api";
import { decryptSecret } from "../../../../lib/connectors/secrets";
import {
  TIKTOK_PHRASE,
  TIKTOK_PROVIDER,
  revokeTikTokAds,
  tiktokConsentLines,
} from "../../../../lib/tiktok/login";

function onError(error: unknown, accountId: string): NextResponse {
  if (error instanceof ExecutionConnectionError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  console.error(
    JSON.stringify({ event: "tiktok_route_error", account_id: accountId, ...logSafeError(error) }),
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
    const row = await activeExecutionConnection(session.account_id, TIKTOK_PROVIDER);
    let advertisers: number | null = null;
    if (row?.encrypted_secret) {
      try {
        advertisers = parseTikTokCredential(decryptSecret(row.encrypted_secret)).advertiser_ids
          .length;
      } catch {
        advertisers = null;
      }
    }
    const spec = EXECUTION_SCOPE_REGISTRY[TIKTOK_PROVIDER];
    return NextResponse.json({
      label: spec.label,
      configured: tiktokAdsEnv() !== null,
      // The exact settings still missing, by name (never their values).
      missing: tiktokAdsMissing(),
      // Verbatim from the registry: the screen can't promise what it doesn't declare.
      consent: tiktokConsentLines(),
      scopes: [...spec.readback_scopes, ...spec.write_scopes],
      confirm_phrase: TIKTOK_PHRASE,
      connection: row ? toPublicExecutionConnection(row) : null,
      advertisers,
      last_read: row?.last_sync_at ?? null,
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
  // Write access is the owner's own consent (rule 13).
  const denied = requireRole(session, "write_access.manage");
  if (denied) return denied;
  try {
    const body = (await request.json().catch(() => null)) as { id?: unknown } | null;
    if (typeof body?.id !== "string") {
      return NextResponse.json({ error: "id is required" }, { status: 422 });
    }
    return NextResponse.json(await revokeTikTokAds(session.account_id, body.id));
  } catch (error) {
    return onError(error, session.account_id);
  }
}
