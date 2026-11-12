// POST /api/growth — the growth studio's actions (v1 spec §10).
//
//   build_voice     the brand voice from the owner's own words (draft)      growth.voice
//   edit_voice      { description } — the owner's words, confirmed          growth.voice
//   confirm_voice   SYB's words are right as they are                       growth.voice
//   add_release     { person, evidence_ref, signed_at }                     growth.voice
//   revoke_release  { release_id }                                          growth.voice
//   open_brief      { trigger, subject, angle, assets? } — the evidence is
//                   the figures opportunity detection found, never sent     growth.manage

import { type NextRequest, NextResponse } from "next/server";
import { resolveAccess } from "../../../lib/auth/access";
import { requireRole } from "../../../lib/auth/roles";
import { appOriginOf, isSameOriginPost } from "../../../lib/auth/same-origin";
import { logSafeError } from "../../../lib/core/log-safe";
import { buildVoiceCard } from "../../../lib/content/voice";
import type { BriefTrigger } from "../../../lib/growth/brief";
import {
  BRIEF_TRIGGERS,
  BriefError,
  detectOpportunities,
  openBrief,
} from "../../../lib/growth/brief";
import {
  LibraryError,
  buildVoice,
  confirmVoice,
  editVoice,
  recordRelease,
  revokeRelease,
} from "../../../lib/growth/library";

const str = (v: unknown) => (typeof v === "string" ? v : "");

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!isSameOriginPost(request.headers, appOriginOf(request.url))) {
    return NextResponse.json({ error: "change this from our own page" }, { status: 403 });
  }
  const access = await resolveAccess();
  if (!access) return NextResponse.json({ error: "no session" }, { status: 401 });
  let b: Record<string, unknown>;
  try {
    b = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  const userId = access.session?.user_id ?? null;
  const voice = () => requireRole(access, "growth.voice");
  try {
    switch (b.action) {
      case "build_voice": {
        const denied = voice();
        if (denied) return denied;
        const card = await buildVoiceCard(access.profile_id);
        return NextResponse.json(await buildVoice(access.profile_id, card));
      }
      case "edit_voice": {
        const denied = voice();
        if (denied) return denied;
        return NextResponse.json(
          await editVoice(access.profile_id, userId ?? access.account_id, str(b.description)),
        );
      }
      case "confirm_voice": {
        const denied = voice();
        if (denied) return denied;
        return NextResponse.json(
          await confirmVoice(access.profile_id, userId ?? access.account_id),
        );
      }
      case "add_release": {
        const denied = voice();
        if (denied) return denied;
        const signed = new Date(str(b.signed_at) || Date.now());
        if (Number.isNaN(signed.getTime()))
          return NextResponse.json({ error: "when was it signed?" }, { status: 422 });
        return NextResponse.json(
          await recordRelease({
            profileId: access.profile_id,
            person: str(b.person),
            evidenceRef: str(b.evidence_ref),
            signedAt: signed,
          }),
        );
      }
      case "revoke_release": {
        const denied = voice();
        if (denied) return denied;
        await revokeRelease(access.profile_id, str(b.release_id));
        return NextResponse.json({ ok: true });
      }
      case "open_brief": {
        const denied = requireRole(access, "growth.manage");
        if (denied) return denied;
        const trigger = str(b.trigger);
        if (!(BRIEF_TRIGGERS as readonly string[]).includes(trigger)) {
          return NextResponse.json({ error: "no such trigger" }, { status: 422 });
        }
        // The evidence is what the business's own figures support — never taken from the request.
        const found = (await detectOpportunities(access.profile_id)).find(
          (o) => o.trigger === trigger,
        );
        const need = str(b.assets).trim();
        const brief = await openBrief({
          profileId: access.profile_id,
          trigger: trigger as BriefTrigger,
          evidence: found?.figure_ids ?? [],
          subject: str(b.subject),
          angle: str(b.angle),
          assetsRequired: need
            ? [{ kind: "video", description: need.slice(0, 200), quantity: 3 }]
            : [],
        });
        return NextResponse.json({ id: brief.id });
      }
      default:
        return NextResponse.json({ error: "unknown action" }, { status: 400 });
    }
  } catch (error) {
    if (error instanceof BriefError || error instanceof LibraryError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error(
      JSON.stringify({
        event: "growth_action_failed",
        account_id: access.account_id,
        ...logSafeError(error),
      }),
    );
    return NextResponse.json({ error: "something went wrong on our side" }, { status: 500 });
  }
}
