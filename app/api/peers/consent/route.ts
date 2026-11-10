// The peer benchmark opt-in — architecture-v2 D7.
//
//   GET    /api/peers/consent   whether this business's figures join the
//                               comparison with similar businesses
//   POST   /api/peers/consent   opt in (the owner's consent, recorded)
//   DELETE /api/peers/consent   withdraw; the figures leave every aggregate
//
// Opting in and out are the owner's ("peers.consent"), from our own page.

import { type NextRequest, NextResponse } from "next/server";
import type { Access } from "../../../../lib/auth/access";
import { resolveAccess } from "../../../../lib/auth/access";
import { requireRole } from "../../../../lib/auth/roles";
import { appOriginOf, isSameOriginPost } from "../../../../lib/auth/same-origin";
import { logSafeError } from "../../../../lib/core/log-safe";
import { hasPeerConsent, optIntoPeers, optOutOfPeers } from "../../../../lib/peers/consent";

export async function GET(): Promise<NextResponse> {
  const access = await resolveAccess();
  if (!access) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  return NextResponse.json({ opted_in: await hasPeerConsent(access.profile_id) });
}

function crossOrigin(request: NextRequest): NextResponse | null {
  if (isSameOriginPost(request.headers, appOriginOf(request.url))) return null;
  return NextResponse.json({ error: "change this from our own page" }, { status: 403 });
}

async function record(access: Access, optIn: boolean): Promise<NextResponse> {
  try {
    const args = { profileId: access.profile_id, by: access.session?.user_id ?? null };
    if (optIn) await optIntoPeers(args);
    else await optOutOfPeers(args);
    console.log(
      JSON.stringify({
        event: optIn ? "peer_consent_given" : "peer_consent_withdrawn",
        account_id: access.account_id,
      }),
    );
    return NextResponse.json({ opted_in: optIn });
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "peer_consent_failed",
        account_id: access.account_id,
        ...logSafeError(error),
      }),
    );
    return NextResponse.json({ error: "something went wrong on our side" }, { status: 500 });
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const refused = crossOrigin(request);
  if (refused) return refused;
  const access = await resolveAccess();
  if (!access) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  const denied = requireRole(access, "peers.consent");
  if (denied) return denied;
  return record(access, true);
}

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  const refused = crossOrigin(request);
  if (refused) return refused;
  const access = await resolveAccess();
  if (!access) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  const denied = requireRole(access, "peers.consent");
  if (denied) return denied;
  return record(access, false);
}
