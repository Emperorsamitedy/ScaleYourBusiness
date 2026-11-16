// "Approve and post on Google" — I-45a lifted by the owner on 2026-11-16.
//
// The owner reads a reply (ScaleX's suggestion, edited or not) under a review
// SYB read from their Google Business Profile, and approves posting THAT
// text. One click does two recorded things, in order:
//
//   1. a proposal whose action carries the exact words to be posted (with the
//      AI label rule 17 requires already on the end), their sha256, and the
//      sha256 of whatever reply Google showed at that moment — the creation
//      entry in the decision log hashes all of it;
//   2. the owner's approval of that proposal (rule 12), by name.
//
// Then the engine is asked to run it at once, as a campaign's "Send now" is.
// With the Session D real-write gate off it refuses, sends nothing, and the
// proposal stays approved: the due runner posts it on its first pass after the
// gate opens. The executor (lib/execution/providers/google-business.ts)
// refuses to overwrite a reply someone else posted since, and undo puts back
// whatever was there before.
//
// Only Google reviews, and only through a connection consented under the
// write lines. A reply to a review on any other site stays text the owner
// copies: ScaleX holds no way to write there. The words are the business's
// public words, so they may not name the reviewer or carry an address or a
// phone number (the draft's own rules, I-45.3) — checked here, in code.

import { and, desc, eq } from "drizzle-orm";
import { db } from "../../db";
import { executions, proposals, reviews } from "../../db/schema";
import { disclosureLabel, relabel } from "../content/disclosure";
import type { ScenarioBlock } from "../diagnosis/recommendations";
import type { DispatchPlan } from "../execution/due";
import { ExecutionRefused, executeProposal } from "../execution/engine";
import type { ExecutionProvider } from "../execution/providers/fixture";
import { GBP_REPLY_MAX, GBP_REPLY_OP, sha256 } from "../execution/providers/google-business";
import { executionProvider } from "../execution/providers/index";
import type { FetchLike } from "../google-business/client";
import { GbpRequestError, REVIEW_NAME_RE, readReviewReply } from "../google-business/client";
import type { GoogleBusinessBackend } from "../google-business/writes";
import { dbGoogleBusinessBackend } from "../google-business/writes";
import type { ProposalRow } from "../proposals/service";
import { approveProposal, createProposal } from "../proposals/service";
import { maskContacts, replyProblem } from "./draft";
import { ReviewDeskError } from "./settings";

export const REVIEWS_MODULE = "reviews";
export const REPLY_KIND = "review_reply";
/** An approved reply that hasn't gone out by then lapses, and the owner approves it again. */
export const REPLY_EXPIRY_DAYS = 14;

/** Pure: the Google review name a review row was filed under, or null for any other review. */
export function googleReviewName(row: {
  source: string;
  provider_id: string | null;
  profile_id: string;
}): string | null {
  if (row.source !== "google" || !row.provider_id) return null;
  const prefix = `gbp:${row.profile_id}:`;
  if (!row.provider_id.startsWith(prefix)) return null;
  const name = row.provider_id.slice(prefix.length);
  return REVIEW_NAME_RE.test(name) ? name : null;
}

/** Pure: the words that will be posted — the owner's, labelled once (rule 17). */
export function postedWords(text: string): string {
  return relabel(text.trim(), disclosureLabel("post"));
}

/** Pure: why these words can't be posted, or null when they can. */
export function postProblem(text: string, reviewer: string | null): string | null {
  const words = text.trim();
  if (words === "") return "There's no reply to post — write one first.";
  if (postedWords(words).length > GBP_REPLY_MAX) {
    return `That reply is too long to post; keep it under ${GBP_REPLY_MAX - 100} characters.`;
  }
  if (maskContacts(words) !== words) {
    return "A public reply can't carry an email address or a phone number. Take them out, then approve it again.";
  }
  if (replyProblem(words, reviewer) === "name") {
    return "A public reply can't name the reviewer. Take the name out, then approve it again.";
  }
  return null;
}

/** The due runner's route for an approved reply: built from the approved row, never a caller. */
export function googleReplyPlanFor(
  proposal: Pick<ProposalRow, "module" | "action">,
): DispatchPlan | null {
  if (proposal.module !== REVIEWS_MODULE) return null;
  const action = proposal.action as { kind?: unknown; detail?: Record<string, unknown> } | null;
  if (action?.kind !== REPLY_KIND || !action.detail) return null;
  const d = action.detail;
  return {
    provider: "google_business_reviews",
    op: GBP_REPLY_OP,
    params: {
      review_name: d["review_name"],
      comment: d["comment"],
      comment_sha256: d["comment_sha256"],
      replaces_sha256: d["replaces_sha256"] ?? null,
    },
  };
}

function scenario(): ScenarioBlock {
  const none = (c: "base" | "downside" | "upside", statement: string) => ({
    case: c,
    statement,
    profit_delta_monthly: null,
    formula: null,
  });
  return {
    assumptions: [
      {
        statement:
          "the reply is posted exactly as you approved it, labelled as written with AI assistance",
        value: null,
        source_field: null,
        sensitivity: "low",
      },
    ],
    base_case: none("base", "The reviewer and everyone reading the review sees you answered."),
    downside_case: none("downside", "Nobody reads it; nothing changes."),
    upside_case: none("upside", "A future customer reads a fair answer and chooses you."),
    breakeven_condition: "not computed — a reply costs nothing to post",
  } as ScenarioBlock;
}

export interface PostOutcome {
  proposal_id: string;
  /** posted: it's on Google; waiting: approved, goes out when sending is on; refused: a guard held it. */
  result: "posted" | "waiting" | "refused";
  message: string;
}

/**
 * The owner's "Approve and post on Google". Refused, with nothing recorded,
 * when the review isn't a Google one, the words can't be posted, a reply is
 * already approved and waiting, or the Google connection can't write.
 */
export async function approveGoogleReply(args: {
  profileId: string;
  reviewId: string;
  userId: string;
  text: string;
  now?: Date;
  backend?: GoogleBusinessBackend;
  fetchImpl?: FetchLike;
  provider?: ExecutionProvider;
  sleep?: (ms: number) => Promise<void>;
}): Promise<PostOutcome> {
  const now = args.now ?? new Date();
  const [review] = await db
    .select()
    .from(reviews)
    .where(and(eq(reviews.id, args.reviewId), eq(reviews.profile_id, args.profileId)));
  if (!review) throw new ReviewDeskError("no such review", 404);
  const name = googleReviewName(review);
  if (name === null) {
    throw new ReviewDeskError(
      "ScaleX can post replies only to reviews it read from your Google Business Profile. Copy this one and post it yourself.",
      422,
    );
  }
  const problem = postProblem(args.text, review.reviewer);
  if (problem !== null) throw new ReviewDeskError(problem, 422);
  const waiting = await waitingReply(args.profileId, review.id);
  if (waiting) {
    throw new ReviewDeskError(
      "A reply you approved for this review is already waiting to be posted.",
      409,
    );
  }

  // What Google shows under the review right now: the approval names it, so a
  // reply someone posts in the meantime is never overwritten.
  const backend = args.backend ?? dbGoogleBusinessBackend();
  const cred = await backend.credential(review.account_id, args.profileId);
  if ("refused" in cred) throw new ReviewDeskError(cred.refused, 409);
  let live: string | null;
  try {
    live = await readReviewReply(cred.access_token, name, args.fetchImpl);
  } catch (error) {
    if (error instanceof GbpRequestError) {
      throw new ReviewDeskError(`Google couldn't be read just now: ${error.message}`, 503);
    }
    throw error;
  }

  const comment = postedWords(args.text);
  const created = await createProposal({
    profile_id: args.profileId,
    module: REVIEWS_MODULE,
    originating_finding: `review:reply:${review.id}`,
    action: {
      kind: REPLY_KIND,
      summary: `Post your reply to a ${review.stars !== null ? `${review.stars}-star ` : ""}review on Google`,
      detail: {
        review_id: review.id,
        review_name: name,
        comment,
        comment_sha256: sha256(comment),
        replaces_sha256: live === null ? null : sha256(live),
        execute_on_approval: true,
        posting:
          "ScaleX posts this reply on Google exactly as shown, ending with its AI label, as soon as you approve it (or, while real changes are switched off, on the first run after they're on).",
      },
    },
    scenario: scenario(),
    reversibility: {
      level: "easy",
      if_you_change_your_mind:
        live === null
          ? "Undo removes the reply from Google."
          : "Undo puts back the reply that was on Google before.",
    },
    expires_at: new Date(now.getTime() + REPLY_EXPIRY_DAYS * 86_400_000).toISOString(),
  });
  await approveProposal({ proposalId: created.id, userId: args.userId, profileId: args.profileId });

  const plan = googleReplyPlanFor(created)!;
  try {
    const run = await executeProposal({
      proposalId: created.id,
      provider: args.provider ?? executionProvider(plan.provider),
      op: plan.op,
      params: plan.params,
      ...(args.sleep ? { sleep: args.sleep } : {}),
    });
    return run.status === "succeeded"
      ? { proposal_id: created.id, result: "posted", message: "Posted on Google." }
      : {
          proposal_id: created.id,
          result: "refused",
          message: run.error ?? "Google didn't take the reply.",
        };
  } catch (error) {
    if (error instanceof ExecutionRefused) {
      return { proposal_id: created.id, result: "waiting", message: error.message };
    }
    throw error;
  }
}

/** An approved reply for this review that has no run yet (waiting for the gate or the runner). */
async function waitingReply(profileId: string, reviewId: string): Promise<boolean> {
  const rows = await db
    .select({ id: proposals.id, action: proposals.action, execution: executions.id })
    .from(proposals)
    .leftJoin(executions, eq(executions.proposal_id, proposals.id))
    .where(
      and(
        eq(proposals.profile_id, profileId),
        eq(proposals.module, REVIEWS_MODULE),
        eq(proposals.status, "approved"),
      ),
    );
  return rows.some(
    (r) =>
      r.execution === null &&
      (r.action as { detail?: { review_id?: unknown } } | null)?.detail?.review_id === reviewId,
  );
}

export type ReplyState = "waiting" | "posted" | "failed" | "withdrawn";

/** Each review's latest posted-reply state, for /reviews. */
export async function replyStates(profileId: string): Promise<Map<string, ReplyState>> {
  const rows = await db
    .select({
      action: proposals.action,
      status: proposals.status,
      execution: executions.status,
      created_at: proposals.created_at,
    })
    .from(proposals)
    .leftJoin(executions, eq(executions.proposal_id, proposals.id))
    .where(and(eq(proposals.profile_id, profileId), eq(proposals.module, REVIEWS_MODULE)))
    .orderBy(desc(proposals.created_at));
  const out = new Map<string, ReplyState>();
  for (const r of rows) {
    const id = (r.action as { detail?: { review_id?: unknown } } | null)?.detail?.review_id;
    if (typeof id !== "string" || out.has(id)) continue;
    if (r.execution === "succeeded") out.set(id, "posted");
    else if (r.execution === "undone") out.set(id, "withdrawn");
    else if (r.execution === "failed") out.set(id, "failed");
    else if (r.status === "approved") out.set(id, "waiting");
  }
  return out;
}
