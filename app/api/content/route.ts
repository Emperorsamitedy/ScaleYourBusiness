// The content API — Phase 3 Session C (P3-15..17).
//
//   GET  /api/content                    the scheduled queue + producible proposals
//   POST /api/content {action}           "plan" | "shotlist" → a PROPOSAL (drafts nothing)
//   POST /api/content {action:"produce"} an approved proposal → drafted, disclosed items
//   POST /api/content {action:"withdraw", item_id}  P3-21e: a published post's stored
//                                        undo, through the engine (deletes it on Meta)
//   POST /api/content {action:"run_ad", item_id, audience?, daily_budget_minor?, run_days?}
//                                        P3-54: "Run this as an ad" → ONE proposal that,
//                                        approved, creates the ad on Meta, paused
//   POST /api/content {action:"go_live", build_id}  P3-54: the separate go-live
//                                        proposal for a created ad (made automatically
//                                        when the build completes; this is the fallback)
//
// Proposing needs only the profile; PRODUCING spends model tokens on
// drafts, so it demands the same signed-in user who could have
// approved the plan — production is the paid half of an approval.

import { logSafeError } from "../../../lib/core/log-safe";
import { matchingSession, resolveAccess } from "../../../lib/auth/access";
import { and, eq, inArray } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { db } from "../../../db";
import { proposals } from "../../../db/schema";
import { sessionDRealWritesOn } from "../../../lib/env";
import { ExecutionRefused } from "../../../lib/execution/engine";
import { ExecutionConnectionError } from "../../../lib/execution/connections";
import { PublishError } from "../../../lib/execution/providers/meta";
import { ContentError, proposeContentPlan } from "../../../lib/content/plan";
import { contentQueue, produceFromProposal } from "../../../lib/content/produce";
import {
  CAPTION_MAX,
  MAX_CLIPS_PER_ITEM,
  MAX_CLIP_BYTES,
  MAX_DIRECT_CLIP_BYTES,
  ON_SCREEN_MAX,
  footageView,
  uploadMode,
} from "../../../lib/content/footage";
import { generationView, isGenerationProposal } from "../../../lib/content/generation";
import { mediaTargetRefusal, supersededByFootage } from "../../../lib/content/media-item";
import { isPublishProposal, publishNotes } from "../../../lib/content/publish";
import { withdrawItem } from "../../../lib/content/publishing";
import { proposeShotList } from "../../../lib/content/shotlist";
import { contentWatchUntil } from "../../../lib/content/watch";
import { ProposalError } from "../../../lib/proposals/service";
import { adItemStates, proposeAdRun, proposeGoLive } from "../../../lib/ads/adcreate";
import type { AdAudienceInput } from "../../../lib/ads/targeting";
import { postOutcomes } from "../../../lib/trust/post-readback";

async function resolveProfile(): Promise<string | null> {
  // The one door (lib/auth/access): a signed cookie, and an owned business only for its own account.
  return (await resolveAccess())?.profile_id ?? null;
}

function onError(error: unknown): NextResponse {
  if (
    error instanceof ContentError ||
    error instanceof ProposalError ||
    error instanceof ExecutionRefused ||
    error instanceof ExecutionConnectionError
  ) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  // The owner's sentence from the publish path (meta-errors / P3-24a), never Meta's raw text.
  if (error instanceof PublishError) {
    return NextResponse.json({ error: error.message }, { status: 409 });
  }
  console.error(JSON.stringify({ event: "content_error", ...logSafeError(error) }));
  return NextResponse.json({ error: "something went wrong on our side" }, { status: 500 });
}

export async function GET(): Promise<NextResponse> {
  const profileId = await resolveProfile();
  if (!profileId) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  try {
    const [items, producible] = await Promise.all([
      contentQueue(profileId),
      db
        .select({ id: proposals.id, action: proposals.action })
        .from(proposals)
        .where(
          and(
            eq(proposals.profile_id, profileId),
            eq(proposals.module, "content"),
            inArray(proposals.status, ["approved"]),
          ),
        ),
    ]);
    // P3-52/53: footage and the AI fallback, for every item that can take media.
    const targets = items.filter((i) => mediaTargetRefusal(i) === null).map((i) => i.id);
    const mode = uploadMode();
    const superseded: string[] = [];
    for (const i of items) {
      if (i.status === "queued" && (await supersededByFootage(i))) superseded.push(i.id);
    }
    return NextResponse.json({
      items,
      media: {
        upload_mode: mode,
        limits: {
          clip_bytes: mode === "direct" ? MAX_DIRECT_CLIP_BYTES : MAX_CLIP_BYTES,
          clips_per_item: MAX_CLIPS_PER_ITEM,
          on_screen: ON_SCREEN_MAX,
          caption: CAPTION_MAX,
        },
        footage: await footageView(profileId, targets),
        generation: await generationView(profileId, items),
        // Approved generated items whose footage arrived: they won't be published (real footage wins).
        superseded,
      },
      // P3-21a: why each draft isn't headed for publishing, in the owner's words.
      publish_notes: await publishNotes(profileId, items),
      // The Session D real-write gate (lib/env.ts): off until the two-week test completes.
      real_writes: sessionDRealWritesOn(),
      // Rule 15: while the watch runs, nothing is proposed — the screen says so up front.
      watching_until: await contentWatchUntil(profileId),
      // P3-23b: each published item's own measured figures and verdict.
      performance: await postOutcomes(profileId),
      // P3-54: per item, whether it can run as an ad and where its ad stands.
      ads: await adItemStates(profileId, items),
      // A publish proposal publishes one finished item; it never produces.
      producible: producible
        .filter((p) => !isPublishProposal(p.action) && !isGenerationProposal(p.action))
        .map((p) => ({
          id: p.id,
          summary: (p.action as { summary?: string }).summary ?? "content proposal",
        })),
    });
  } catch (error) {
    return onError(error);
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const profileId = await resolveProfile();
  if (!profileId) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  try {
    const body = (await request.json()) as {
      action?: unknown;
      proposal_id?: unknown;
      item_id?: unknown;
      build_id?: unknown;
      audience?: unknown;
      daily_budget_minor?: unknown;
      run_days?: unknown;
    };

    if (body.action === "plan") {
      const proposal = await proposeContentPlan(profileId);
      return NextResponse.json({ proposal_id: proposal.id, status: proposal.status });
    }
    if (body.action === "shotlist") {
      const proposal = await proposeShotList(profileId);
      return NextResponse.json({ proposal_id: proposal.id, status: proposal.status });
    }
    if (body.action === "produce") {
      const session = await matchingSession();
      if (!session) {
        return NextResponse.json(
          { error: "producing drafts needs you signed in — it spends real model calls" },
          { status: 401 },
        );
      }
      if (typeof body.proposal_id !== "string") {
        return NextResponse.json({ error: "proposal_id is required" }, { status: 422 });
      }
      const { items, publishing } = await produceFromProposal(body.proposal_id, {
        expectedProfileId: profileId,
      });
      return NextResponse.json({ produced: items.length, publishing: publishing.created.length });
    }
    if (body.action === "withdraw") {
      // A write to Meta: the same signed-in owner who could have approved it.
      const session = await matchingSession();
      if (!session) {
        return NextResponse.json(
          { error: "withdrawing a post needs you signed in — it deletes it on Meta" },
          { status: 401 },
        );
      }
      if (typeof body.item_id !== "string") {
        return NextResponse.json({ error: "item_id is required" }, { status: 422 });
      }
      const execution = await withdrawItem({
        itemId: body.item_id,
        profileId,
        userId: session.user_id,
      });
      return NextResponse.json({ withdrawn: execution.status === "undone" });
    }
    if (body.action === "run_ad") {
      // P3-54: a proposal only — nothing is sent until it is approved and the runner builds it.
      if (typeof body.item_id !== "string") {
        return NextResponse.json({ error: "item_id is required" }, { status: 422 });
      }
      const out = await proposeAdRun(profileId, {
        item_id: body.item_id,
        ...(audienceOf(body.audience) ? { audience: audienceOf(body.audience) } : {}),
        ...(Number.isSafeInteger(body.daily_budget_minor)
          ? { daily_budget_minor: body.daily_budget_minor as number }
          : {}),
        ...(Number.isInteger(body.run_days) ? { run_days: body.run_days as number } : {}),
      });
      if ("skipped" in out) return NextResponse.json({ error: out.skipped }, { status: 409 });
      return NextResponse.json({ proposal_id: out.created.id, status: out.created.status });
    }
    if (body.action === "go_live") {
      if (typeof body.build_id !== "string") {
        return NextResponse.json({ error: "build_id is required" }, { status: 422 });
      }
      const out = await proposeGoLive(profileId, body.build_id);
      if ("skipped" in out) return NextResponse.json({ error: out.skipped }, { status: 409 });
      return NextResponse.json({ proposal_id: out.created.id, status: out.created.status });
    }
    return NextResponse.json(
      {
        error: 'action must be "plan", "shotlist", "produce", "withdraw", "run_ad" or "go_live"',
      },
      { status: 422 },
    );
  } catch (error) {
    return onError(error);
  }
}

/** P3-54: an audience from the client, kept to the shape the builder takes; anything else is dropped. */
function audienceOf(raw: unknown): AdAudienceInput | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const a = raw as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const text = (v: unknown) =>
    typeof v === "string" && v.trim() !== "" ? v.trim().slice(0, 200) : undefined;
  const loc = (a.location ?? null) as Record<string, unknown> | null;
  const location =
    loc && typeof loc === "object"
      ? Object.fromEntries(
          Object.entries({
            country: text(loc.country),
            latitude: num(loc.latitude),
            longitude: num(loc.longitude),
            radius_km: num(loc.radius_km),
            label: text(loc.label),
          }).filter(([, v]) => v !== undefined),
        )
      : undefined;
  const out: AdAudienceInput = Object.fromEntries(
    Object.entries({
      location,
      age_min: num(a.age_min),
      age_max: num(a.age_max),
      interests: text(a.interests),
    }).filter(([, v]) => v !== undefined),
  );
  return Object.keys(out).length > 0 ? out : null;
}
