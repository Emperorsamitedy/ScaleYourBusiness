// The content API — Phase 3 Session C (P3-15..17).
//
//   GET  /api/content                    the scheduled queue + producible proposals
//   POST /api/content {action}           "plan" | "shotlist" → a PROPOSAL (drafts nothing)
//   POST /api/content {action:"produce"} an approved proposal → drafted, disclosed items
//
// Proposing needs only the profile; PRODUCING spends model tokens on
// drafts, so it demands the same signed-in user who could have
// approved the plan — production is the paid half of an approval.

import { and, eq, inArray } from "drizzle-orm";
import { cookies } from "next/headers";
import { type NextRequest, NextResponse } from "next/server";
import { db } from "../../../db";
import { businessProfiles, proposals } from "../../../db/schema";
import { currentSession } from "../../../lib/auth/service";
import { ContentError, proposeContentPlan } from "../../../lib/content/plan";
import { contentQueue, produceFromProposal } from "../../../lib/content/produce";
import { proposeShotList } from "../../../lib/content/shotlist";
import { ProposalError } from "../../../lib/proposals/service";

const COOKIE = "syb_intake_profile";
const AUTH_COOKIE = "syb_session";

async function resolveProfile(): Promise<string | null> {
  const store = await cookies();
  const profileId = store.get(COOKIE)?.value;
  if (!profileId) return null;
  const [row] = await db
    .select({ id: businessProfiles.id })
    .from(businessProfiles)
    .where(eq(businessProfiles.id, profileId));
  return row?.id ?? null;
}

function onError(error: unknown): NextResponse {
  if (error instanceof ContentError || error instanceof ProposalError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  console.error(JSON.stringify({ event: "content_error", message: String(error) }));
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
      producible: producible.map((p) => ({
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
    const body = (await request.json()) as { action?: unknown; proposal_id?: unknown };

    if (body.action === "plan") {
      const proposal = await proposeContentPlan(profileId);
      return NextResponse.json({ proposal_id: proposal.id, status: proposal.status });
    }
    if (body.action === "shotlist") {
      const proposal = await proposeShotList(profileId);
      return NextResponse.json({ proposal_id: proposal.id, status: proposal.status });
    }
    if (body.action === "produce") {
      const store = await cookies();
      const session = await currentSession(store.get(AUTH_COOKIE)?.value);
      if (!session) {
        return NextResponse.json(
          { error: "producing drafts needs you signed in — it spends real model calls" },
          { status: 401 },
        );
      }
      if (typeof body.proposal_id !== "string") {
        return NextResponse.json({ error: "proposal_id is required" }, { status: 422 });
      }
      const { items } = await produceFromProposal(body.proposal_id, {
        expectedProfileId: profileId,
      });
      return NextResponse.json({ produced: items.length });
    }
    return NextResponse.json(
      { error: 'action must be "plan", "shotlist" or "produce"' },
      { status: 422 },
    );
  } catch (error) {
    return onError(error);
  }
}
