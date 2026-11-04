// POST /api/content/media — footage in (P3-52) and the AI fallback (P3-53).
//
//   multipart  {item_id, file}                    development only: a clip through the route
//                                                 to the local disk store (100 MB cap)
//   {action:"grant", item_id, content_type, bytes, name}
//                                                 production: a 30-minute Blob client token
//                                                 for ONE server-chosen pathname, type and size
//   {action:"confirm", item_id, clip_id}          the upload landed — checked with Blob itself
//   {action:"remove_clip", clip_id}               the bytes leave storage before any cut
//   {action:"cut", item_id, on_screen, caption, date}
//                                                 the cutting room runs after the response
//                                                 (and on the cron sweep if it is cut short)
//   {action:"propose_generation", item_id, media, direction?, brief?: {hook, script}}
//                                                 a PROPOSAL with its cost — generates nothing
//   {action:"generate", proposal_id}              an APPROVED generation proposal → media
//   {action:"propose_publish", item_id}           a draft that qualifies now gets its publish
//                                                 proposal (the "drafted before" gap)
//
// Every action is the signed-in owner's (a session for this profile's
// account) and must come from our own page (isSameOriginPost: Sec-Fetch-Site,
// else Origin; neither → refused). Uploading spends storage, generating
// spends money, and both put media on something that may be published.

import { after, type NextRequest, NextResponse } from "next/server";
import { resolveAccess } from "../../../../lib/auth/access";
import { appOriginOf, isSameOriginPost } from "../../../../lib/auth/same-origin";
import { logSafeError } from "../../../../lib/core/log-safe";
import { EditError } from "../../../../lib/content/edit";
import {
  MAX_DIRECT_CLIP_BYTES,
  confirmClipUpload,
  issueClipUpload,
  removeClip,
  requestRender,
  runRender,
  storeClipDirect,
  uploadMode,
} from "../../../../lib/content/footage";
import type { BriefInput } from "../../../../lib/content/generation";
import { generateFromProposal, proposeGeneration } from "../../../../lib/content/generation";
import { MediaError, configuredMediaStore } from "../../../../lib/content/media";
import { ContentError } from "../../../../lib/content/plan";
import { proposePublishing } from "../../../../lib/content/publish";
import { CONTENT_WORDS, blockWords } from "../../../../lib/content/publish-words";
import { requestTr } from "../../../../lib/i18n/request-tr";
import { ProposalError } from "../../../../lib/proposals/service";
import { requireRole } from "../../../../lib/auth/roles";

// A render runs after the response, inside this function's lifetime.
export const maxDuration = 300;

function onError(error: unknown): NextResponse {
  if (
    error instanceof ContentError ||
    error instanceof MediaError ||
    error instanceof EditError ||
    error instanceof ProposalError
  ) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  console.error(JSON.stringify({ event: "content_media_error", ...logSafeError(error) }));
  return NextResponse.json({ error: "something went wrong on our side" }, { status: 500 });
}

function briefOf(raw: unknown): BriefInput | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { hook?: unknown; script?: unknown };
  const clip = (v: unknown) =>
    typeof v === "string" && v.trim() !== "" ? v.trim().slice(0, 600) : undefined;
  const hook = clip(r.hook);
  const script = clip(r.script);
  return hook || script ? { ...(hook ? { hook } : {}), ...(script ? { script } : {}) } : null;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  // L-4c: this route's own refusals in the reader's language.
  const { tr, locale } = await requestTr(CONTENT_WORDS);
  if (!isSameOriginPost(request.headers, appOriginOf(request.url))) {
    return NextResponse.json({ error: tr("error.sameOrigin") }, { status: 403 });
  }
  const access = await resolveAccess();
  if (!access) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  const session = access.session;
  if (!session) {
    return NextResponse.json({ error: tr("error.mediaSignedIn") }, { status: 401 });
  }
  const denied = requireRole(session, "content.draft");
  if (denied) return denied;
  const profileId = access.profile_id;

  try {
    const type = request.headers.get("content-type") ?? "";
    if (type.startsWith("multipart/form-data")) {
      const store = configuredMediaStore();
      if (!store) {
        return NextResponse.json({ error: tr("error.noUploads") }, { status: 503 });
      }
      // Refused before the body is read: the declared length is over the cap.
      const declared = Number(request.headers.get("content-length") ?? "0");
      if (declared > MAX_DIRECT_CLIP_BYTES + 1024 * 1024) {
        return NextResponse.json(
          { error: tr("error.clipSize", { mb: MAX_DIRECT_CLIP_BYTES / 1024 / 1024 }) },
          { status: 413 },
        );
      }
      const form = await request.formData().catch(() => null);
      const file = form?.get("file");
      const itemId = form?.get("item_id");
      if (!form || typeof itemId !== "string" || !(file instanceof File)) {
        return NextResponse.json({ error: tr("error.itemAndFile") }, { status: 422 });
      }
      if (file.size > MAX_DIRECT_CLIP_BYTES) {
        return NextResponse.json(
          { error: tr("error.clipSize", { mb: MAX_DIRECT_CLIP_BYTES / 1024 / 1024 }) },
          { status: 413 },
        );
      }
      const clip = await storeClipDirect({
        profileId,
        itemId,
        name: file.name,
        contentType: file.type,
        body: new Uint8Array(await file.arrayBuffer()),
        store,
      });
      return NextResponse.json({ clip_id: clip.id, label: clip.label, bytes: clip.bytes });
    }

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const itemId = typeof body.item_id === "string" ? body.item_id : null;

    switch (body.action) {
      case "grant": {
        if (uploadMode() !== "blob") {
          return NextResponse.json({ error: tr("error.throughSyb") }, { status: 409 });
        }
        if (!itemId) return NextResponse.json({ error: tr("error.itemId") }, { status: 422 });
        const grant = await issueClipUpload({
          profileId,
          itemId,
          contentType: body.content_type,
          bytes: body.bytes,
          name: body.name,
        });
        return NextResponse.json(grant);
      }
      case "confirm": {
        if (!itemId) return NextResponse.json({ error: tr("error.itemId") }, { status: 422 });
        const clip = await confirmClipUpload({ profileId, itemId, clipId: body.clip_id });
        return NextResponse.json({ clip_id: clip.id, status: clip.status, bytes: clip.bytes });
      }
      case "remove_clip": {
        const store = configuredMediaStore();
        if (!store) return NextResponse.json({ error: tr("error.noStorage") }, { status: 503 });
        await removeClip({ profileId, clipId: body.clip_id, store });
        return NextResponse.json({ removed: true });
      }
      case "cut": {
        if (!itemId) return NextResponse.json({ error: tr("error.itemId") }, { status: 422 });
        const render = await requestRender({
          profileId,
          itemId,
          userId: session.user_id,
          onScreen: body.on_screen,
          caption: body.caption,
          scheduledFor: body.date,
        });
        // After the response, inside this function's maxDuration; the cron sweep is the backstop.
        after(async () => {
          try {
            await runRender(render.id);
          } catch (error) {
            console.error(
              JSON.stringify({
                event: "footage_render_after_failed",
                account_id: session.account_id,
                render_id: render.id,
                ...logSafeError(error),
              }),
            );
          }
        });
        return NextResponse.json({ render_id: render.id, status: render.status });
      }
      case "propose_generation": {
        if (!itemId) return NextResponse.json({ error: tr("error.itemId") }, { status: 422 });
        const proposal = await proposeGeneration({
          profileId,
          itemId,
          media: body.media,
          direction: body.direction,
          brief: briefOf(body.brief),
        });
        return NextResponse.json({ proposal_id: proposal.id, status: proposal.status });
      }
      case "generate": {
        if (typeof body.proposal_id !== "string") {
          return NextResponse.json({ error: tr("error.proposalId") }, { status: 422 });
        }
        const outcome = await generateFromProposal({
          proposalId: body.proposal_id,
          expectedProfileId: profileId,
        });
        return NextResponse.json(outcome);
      }
      case "propose_publish": {
        if (!itemId) return NextResponse.json({ error: tr("error.itemId") }, { status: 422 });
        const run = await proposePublishing(profileId, [itemId]);
        return NextResponse.json({
          proposed: run.created.length,
          // L-4c: why not, in the reader's language.
          reason: (() => {
            const first = run.skipped[0];
            const block = first ? run.blocks?.[first.item_id] : undefined;
            return block ? blockWords(block, tr, locale) : (first?.reason ?? null);
          })(),
        });
      }
      default:
        return NextResponse.json({ error: tr("error.unknownAction") }, { status: 422 });
    }
  } catch (error) {
    return onError(error);
  }
}
