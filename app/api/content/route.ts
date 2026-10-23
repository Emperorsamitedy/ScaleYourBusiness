// The content API — Phase 3 Session C (P3-15..17).
//
//   GET  /api/content                    the scheduled queue + producible proposals
//   POST /api/content {action}           "plan" | "shotlist" → a PROPOSAL (drafts nothing)
//   POST /api/content {action:"produce"} an approved proposal → drafted, disclosed items
//   POST /api/content {action:"withdraw", item_id}  P3-21e: a published post's stored
//                                        undo, through the engine (deletes it on Meta)
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
import { isPublishProposal, publishNotes } from "../../../lib/content/publish";
import { withdrawItem } from "../../../lib/content/publishing";
import { proposeShotList } from "../../../lib/content/shotlist";
import { contentWatchUntil } from "../../../lib/content/watch";
import { ProposalError } from "../../../lib/proposals/service";
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
    return NextResponse.json({
      items,
      // P3-21a: why each draft isn't headed for publishing, in the owner's words.
      publish_notes: await publishNotes(profileId, items),
      // The Session D real-write gate (lib/env.ts): off until the two-week test completes.
      real_writes: sessionDRealWritesOn(),
      // Rule 15: while the watch runs, nothing is proposed — the screen says so up front.
      watching_until: await contentWatchUntil(profileId),
      // P3-23b: each published item's own measured figures and verdict.
      performance: await postOutcomes(profileId),
      // A publish proposal publishes one finished item; it never produces.
      producible: producible
        .filter((p) => !isPublishProposal(p.action))
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
    return NextResponse.json(
      { error: 'action must be "plan", "shotlist", "produce" or "withdraw"' },
      { status: 422 },
    );
  } catch (error) {
    return onError(error);
  }
}
