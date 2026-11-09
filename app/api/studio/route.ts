// The creative studio API — Phase 3 Session K (P3-50, P3-51).
//
//   GET  /api/studio                                   the niche's ads, the briefs, the goals
//   POST /api/studio {action:"research", terms?, fresh?}  read Meta's Ad Library (read-only)
//   POST /api/studio {action:"brief", campaign?, goal_id?} Sonnet writes one brief (capped)
//   POST /api/studio {action:"make", brief_id, hook_index}  a shot-list PROPOSAL from one hook
//   POST /api/studio {action:"propose_video", item_id}       P6-03: a PROPOSAL for three AI video
//                                                            candidates for a brief's shot list
//   POST /api/studio {action:"generate_video", proposal_id}  an APPROVED one → three requests
//                                                            SUBMITTED; answers at once (2026-11-09)
//   POST /api/studio {action:"collect_video"}                while a set is being made: ask after
//                                                            its clips, after this response
//   POST /api/studio {action:"pick", candidate_id}           the owner's pick → its video item,
//                                                            offered for publishing (another yes)
//
// Reading the Library uses SYB's own rate-limited token, and writing a
// brief spends model calls, so both demand the signed-in owner. "make"
// only proposes: the approval queue decides, as for every shot list. The
// AI video actions (P6-03) demand the signed-in owner too: one spends real
// money once approved, and a pick is a decision recorded with who made it.

import { after, type NextRequest, NextResponse } from "next/server";
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
import {
  collectCandidates,
  pendingCandidates,
  pickCandidate,
  studioVideoView,
} from "../../../lib/content/candidates";
import {
  generateFromProposal,
  generationSetup,
  proposeGeneration,
} from "../../../lib/content/generation";
import { MediaError } from "../../../lib/content/media";
import { ContentError } from "../../../lib/content/plan";
import { contentWatchUntil } from "../../../lib/content/watch";
import { logSafeError } from "../../../lib/core/log-safe";
import { ModelRefusalError } from "../../../lib/llm/answer";
import { ProposalError } from "../../../lib/proposals/service";
import { nicheView, readNicheAds } from "../../../lib/research/niche";
import { requireRole } from "../../../lib/auth/roles";
import { requestLocale } from "../../../lib/i18n/server";
import type { RoleAction } from "../../../lib/auth/roles";

// P6-03: generating only submits now (the owner's decision of 2026-11-09);
// the time is for collect_video's after(): a download, a label and a store
// per finished clip, under collectCandidates' own caps and budget.
export const maxDuration = 300;

/** The studio's own collecting pass: this business only, a few at a time. */
const STUDIO_COLLECT = { candidates: 3, downloads: 3, budget_ms: 150_000 } as const;

function onError(error: unknown, accountId: string): NextResponse {
  if (
    error instanceof BriefError ||
    error instanceof ContentError ||
    error instanceof MediaError ||
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
    const [niche, briefs, goals, spend, watchingUntil, video] = await Promise.all([
      nicheView(access.profile_id, now),
      listBriefs(access.profile_id),
      listGoals(access.profile_id),
      briefUsage(access.account_id, now),
      contentWatchUntil(access.profile_id, now),
      studioVideoView(access.profile_id, generationSetup(), now),
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
      // P6-03: AI video — the shot lists from briefs, and the candidates to pick from.
      video,
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
  propose_video: "proposals.generate",
  generate_video: "content.draft",
  collect_video: "content.draft",
  pick: "content.draft",
};

const VIDEO_ACTIONS = new Set(["propose_video", "generate_video", "collect_video", "pick"]);

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
    if (VIDEO_ACTIONS.has(String(body.action))) {
      const session = await matchingSession();
      if (!session) {
        return NextResponse.json(
          { error: "AI video needs you signed in — it spends real money once approved" },
          { status: 401 },
        );
      }
      if (body.action === "propose_video") {
        if (typeof body.item_id !== "string") {
          return NextResponse.json({ error: "item_id is required" }, { status: 422 });
        }
        const proposal = await proposeGeneration({
          profileId: access.profile_id,
          itemId: body.item_id,
          media: "video",
        });
        return NextResponse.json({ proposal_id: proposal.id, status: proposal.status });
      }
      if (body.action === "generate_video") {
        if (typeof body.proposal_id !== "string") {
          return NextResponse.json({ error: "proposal_id is required" }, { status: 422 });
        }
        const outcome = await generateFromProposal({
          proposalId: body.proposal_id,
          expectedProfileId: access.profile_id,
        });
        return NextResponse.json(outcome);
      }
      if (body.action === "collect_video") {
        // Spends nothing new: the clips were paid for when submitted. After the response,
        // inside this function's time; the collect-video cron is the backstop.
        const pending = await pendingCandidates(access.profile_id);
        if (pending > 0) {
          const profileId = access.profile_id;
          const accountId = access.account_id;
          after(async () => {
            try {
              await collectCandidates({ profileId, limits: STUDIO_COLLECT });
            } catch (error) {
              console.error(
                JSON.stringify({
                  event: "studio_collect_failed",
                  account_id: accountId,
                  ...logSafeError(error),
                }),
              );
            }
          });
        }
        return NextResponse.json({ pending });
      }
      if (typeof body.candidate_id !== "string") {
        return NextResponse.json({ error: "candidate_id is required" }, { status: 422 });
      }
      const picked = await pickCandidate({
        profileId: access.profile_id,
        candidateId: body.candidate_id,
        userId: session.user_id,
      });
      return NextResponse.json(picked);
    }
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
      {
        error:
          'action must be "research", "brief", "make", "propose_video", "generate_video", "collect_video" or "pick"',
      },
      { status: 422 },
    );
  } catch (error) {
    return onError(error, access.account_id);
  }
}
