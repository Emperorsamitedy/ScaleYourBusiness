// The creative studio API — Phase 3 Session K (P3-50, P3-51).
//
//   GET  /api/studio                                   the niche's ads, the briefs, the goals
//   POST /api/studio {action:"research", terms?, fresh?}  read Meta's Ad Library (read-only)
//   POST /api/studio {action:"brief", campaign?, goal_id?} Sonnet writes one brief (capped)
//   POST /api/studio {action:"make", brief_id, hook_index}  a shot-list PROPOSAL from one hook
//
// Reading the Library uses SYB's own rate-limited token, and writing a
// brief spends model calls, so both demand the signed-in owner. "make"
// only proposes: the approval queue decides, as for every shot list.

import { type NextRequest, NextResponse } from "next/server";
import { matchingSession, resolveAccess } from "../../../lib/auth/access";
import {
  BRIEF_CAPS,
  BriefError,
  briefUsage,
  listBriefs,
  proposeShotListFromBrief,
  writeBrief,
} from "../../../lib/content/brief";
import { listGoals } from "../../../lib/content/goals";
import { ContentError } from "../../../lib/content/plan";
import { contentWatchUntil } from "../../../lib/content/watch";
import { logSafeError } from "../../../lib/core/log-safe";
import { ModelRefusalError } from "../../../lib/llm/answer";
import { ProposalError } from "../../../lib/proposals/service";
import { nicheView, readNicheAds } from "../../../lib/research/niche";
import { requireRole } from "../../../lib/auth/roles";
import { requestLocale } from "../../../lib/i18n/server";
import type { RoleAction } from "../../../lib/auth/roles";

function onError(error: unknown, accountId: string): NextResponse {
  if (
    error instanceof BriefError ||
    error instanceof ContentError ||
    error instanceof ProposalError
  ) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  if (error instanceof ModelRefusalError) {
    return NextResponse.json(
      { error: "The writing model declined this brief, so none was kept." },
      { status: 502 },
    );
  }
  console.error(
    JSON.stringify({ event: "studio_error", account_id: accountId, ...logSafeError(error) }),
  );
  return NextResponse.json({ error: "something went wrong on our side" }, { status: 500 });
}

export async function GET(): Promise<NextResponse> {
  const access = await resolveAccess();
  if (!access) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  try {
    const now = new Date();
    const [niche, briefs, goals, spend, watchingUntil] = await Promise.all([
      nicheView(access.profile_id, now),
      listBriefs(access.profile_id),
      listGoals(access.profile_id),
      briefUsage(access.account_id, now),
      contentWatchUntil(access.profile_id, now),
    ]);
    return NextResponse.json({
      niche,
      briefs,
      goals: goals
        .filter((g) => g.statement !== null)
        .map((g) => ({ goal_id: g.goal_id, statement: g.statement })),
      brief_allowance: {
        calls_left: Math.max(0, BRIEF_CAPS.max_calls_per_account_per_month - spend.account_calls),
        calls_per_month: BRIEF_CAPS.max_calls_per_account_per_month,
        attempts_per_brief: BRIEF_CAPS.max_attempts,
      },
      // Rule 15: while the watch runs, "make this" proposes nothing.
      watching_until: watchingUntil,
    });
  } catch (error) {
    return onError(error, access.account_id);
  }
}

/** Idea 52: the role each action needs (lib/auth/roles); an action not listed asks for an owner. */
const STUDIO_ROLE: Record<string, RoleAction> = {
  research: "content.draft",
  brief: "content.draft",
  make: "proposals.generate",
};

export async function POST(request: NextRequest): Promise<NextResponse> {
  const access = await resolveAccess();
  if (!access) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await request.json();
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
    body = parsed as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "body must be a JSON object" }, { status: 400 });
  }
  const denied = requireRole(access, STUDIO_ROLE[String(body.action)] ?? "content.draft");
  if (denied) return denied;
  try {
    if (body.action === "research") {
      if (!(await matchingSession())) {
        return NextResponse.json(
          { error: "reading the Ad Library needs you signed in" },
          { status: 401 },
        );
      }
      const terms = Array.isArray(body.terms) ? body.terms.slice(0, 5) : undefined;
      const outcome = await readNicheAds({
        profileId: access.profile_id,
        accountId: access.account_id,
        ...(terms && terms.length > 0 ? { terms } : {}),
        fresh: body.fresh === true,
      });
      return NextResponse.json({
        status: outcome.status,
        why: "why" in outcome ? outcome.why : null,
        fresh: outcome.status === "read" ? outcome.fresh : false,
      });
    }
    if (body.action === "brief") {
      if (!(await matchingSession())) {
        return NextResponse.json(
          { error: "writing a brief needs you signed in — it spends real model calls" },
          { status: 401 },
        );
      }
      const label =
        typeof body.campaign === "string" ? body.campaign.trim().slice(0, 160) || null : null;
      const goalId = typeof body.goal_id === "string" && body.goal_id !== "" ? body.goal_id : null;
      const row = await writeBrief({
        profileId: access.profile_id,
        accountId: access.account_id,
        campaign: { label, goal_id: goalId },
        // L-5: the owner's parts in their language; hooks and scripts in the business's.
        locale: await requestLocale(),
      });
      return NextResponse.json({ brief_id: row.id, attempts: row.attempts });
    }
    if (body.action === "make") {
      if (typeof body.brief_id !== "string" || typeof body.hook_index !== "number") {
        return NextResponse.json(
          { error: "brief_id and hook_index are required" },
          { status: 422 },
        );
      }
      const proposal = await proposeShotListFromBrief(
        access.profile_id,
        body.brief_id,
        body.hook_index,
      );
      return NextResponse.json({ proposal_id: proposal.id, status: proposal.status });
    }
    return NextResponse.json(
      { error: 'action must be "research", "brief" or "make"' },
      { status: 422 },
    );
  } catch (error) {
    return onError(error, access.account_id);
  }
}
