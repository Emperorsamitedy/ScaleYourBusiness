// The first-campaign review — review 2026-10-23 (#5c), rule 23.
//
// Campaigns go out from SYB's own sending domain and Resend account.
// A self-signed-up account can import scraped addresses, attest "explicit
// consent" and send under any sender name; the complaints that follow land
// on the shared domain, and owners stop getting their sign-in links. So a
// PERSON at SYB reads each account's FIRST campaign before it sends,
// and that reading is a fact, the way the law review is:
//
//   - a review is a row: the operator's name, the day, the campaign they
//     read, and the account it belongs to — plus a decision-log entry under
//     the campaign's own profile whose hash covers the sha256 of the name,
//     never the name, and no customer data at all;
//   - until the account has one, its campaign is refused at pre-flight
//     (guard 6b, right after the law review), in words, and stays approved;
//   - once it has one, later campaigns don't need another. The daily cap
//     (CAMPAIGN_DAILY_RECIPIENT_CAP) keeps bounding them.
//
// Recorded by an operator from /ops (the OPS_KEY door), like the law review.

import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, notExists, sql } from "drizzle-orm";
import { db } from "../../db";
import {
  businessProfiles,
  campaignReviews,
  connections,
  contentItems,
  decisionLog,
  proposals,
} from "../../db/schema";
import { SEGMENT_KIND, SEGMENT_MODULE } from "./segment-proposals";

export class CampaignReviewError extends Error {
  readonly status: number;
  constructor(message: string, status = 422) {
    super(message);
    this.name = "CampaignReviewError";
    this.status = status;
  }
}

export type CampaignReviewRow = typeof campaignReviews.$inferSelect;

export interface CampaignReviewVerdict {
  reviewed: boolean;
  /** In the owner's words, for the screen and the engine's refusal. */
  words: string;
  reviewed_on: string | null;
}

/** Said while an account's first campaign waits for its review. */
export const FIRST_CAMPAIGN_UNREVIEWED =
  "This is your first campaign, so a person at ScaleX reads it before it goes out. Campaigns share ScaleX's sending address, and this keeps it trusted for everyone. It sends once that review is recorded.";

/** Pure: the verdict from the account's latest review, or none. */
export function campaignReviewVerdict(
  latest: Pick<CampaignReviewRow, "reviewed_on"> | null,
): CampaignReviewVerdict {
  if (latest === null) {
    return { reviewed: false, words: FIRST_CAMPAIGN_UNREVIEWED, reviewed_on: null };
  }
  return {
    reviewed: true,
    words: `Your first campaign was reviewed by ScaleX on ${latest.reviewed_on}.`,
    reviewed_on: latest.reviewed_on,
  };
}

/** The account's verdict: has a person reviewed one of its campaigns? */
export async function accountCampaignReview(accountId: string): Promise<CampaignReviewVerdict> {
  const [row] = await db
    .select({ reviewed_on: campaignReviews.reviewed_on })
    .from(campaignReviews)
    .where(eq(campaignReviews.account_id, accountId))
    .orderBy(desc(campaignReviews.recorded_at), desc(campaignReviews.id))
    .limit(1);
  return campaignReviewVerdict(row ?? null);
}

export function hashCampaignReview(
  row: Pick<
    CampaignReviewRow,
    "id" | "account_id" | "proposal_id" | "reviewer" | "reviewed_on" | "recorded_at"
  >,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        kind: "campaign_review",
        review_id: row.id,
        account_id: row.account_id,
        proposal_id: row.proposal_id,
        // The name is hashed into the entry, never written to it.
        reviewer_sha256: createHash("sha256").update(row.reviewer).digest("hex"),
        reviewed_on: row.reviewed_on,
        recorded_at: row.recorded_at,
      }),
    )
    .digest("hex");
}

/**
 * Record that a person read this campaign. Only a campaign proposal; the
 * account is the campaign's own, never one the form names.
 */
export async function recordCampaignReview(args: {
  proposalId: string;
  reviewer: string;
  reviewedOn: string;
  now?: Date;
}): Promise<CampaignReviewRow> {
  const reviewer = args.reviewer.trim();
  if (reviewer === "") throw new CampaignReviewError("the reviewer's name is required");
  if (reviewer.length > 200) throw new CampaignReviewError("the reviewer's name is too long");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.reviewedOn) || Number.isNaN(Date.parse(args.reviewedOn))) {
    throw new CampaignReviewError("the review date must be a day, YYYY-MM-DD");
  }
  const today = (args.now ?? new Date()).toISOString().slice(0, 10);
  if (args.reviewedOn > today) {
    throw new CampaignReviewError("a review can't be dated in the future");
  }
  if (!/^[0-9a-f-]{36}$/i.test(args.proposalId)) {
    throw new CampaignReviewError("no such campaign", 404);
  }
  const [p] = await db
    .select({
      id: proposals.id,
      module: proposals.module,
      action: proposals.action,
      profile_id: proposals.profile_id,
      account_id: businessProfiles.account_id,
    })
    .from(proposals)
    .innerJoin(businessProfiles, eq(businessProfiles.id, proposals.profile_id))
    .where(eq(proposals.id, args.proposalId));
  if (
    !p ||
    p.module !== SEGMENT_MODULE ||
    (p.action as { kind?: unknown } | null)?.kind !== SEGMENT_KIND
  ) {
    throw new CampaignReviewError("no such campaign", 404);
  }
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(campaignReviews)
      .values({
        account_id: p.account_id,
        proposal_id: p.id,
        reviewer,
        reviewed_on: args.reviewedOn,
      })
      .onConflictDoNothing()
      .returning();
    if (!row) throw new CampaignReviewError("this campaign's review is already recorded", 409);
    await tx.insert(decisionLog).values({
      profile_id: p.profile_id,
      actor: "system",
      kind: "campaign_review",
      ref_id: row.id,
      payload_hash: hashCampaignReview(row),
    });
    console.log(
      JSON.stringify({
        event: "campaign_review_recorded",
        account_id: row.account_id,
        review_id: row.id,
        proposal_id: row.proposal_id,
        reviewed_on: row.reviewed_on,
      }),
    );
    return row;
  });
}

export interface AwaitingReview {
  proposal_id: string;
  account_id: string;
  summary: string;
  recipients: number;
  sender_name: string | null;
  subject: string | null;
  body: string | null;
  approved_at: string | null;
}

/**
 * For /ops: approved campaigns of accounts with no review yet — what the
 * operator reads. The business's own words (sender, subject, body) and a
 * count; never a recipient.
 */
export async function campaignsAwaitingReview(limit = 20): Promise<AwaitingReview[]> {
  const rows = await db
    .select({
      proposal_id: proposals.id,
      account_id: businessProfiles.account_id,
      action: proposals.action,
    })
    .from(proposals)
    .innerJoin(businessProfiles, eq(businessProfiles.id, proposals.profile_id))
    .where(
      and(
        eq(proposals.module, SEGMENT_MODULE),
        sql`${proposals.action}->>'kind' = ${SEGMENT_KIND}`,
        eq(proposals.status, "approved"),
        notExists(
          db
            .select({ one: sql`1` })
            .from(campaignReviews)
            .where(eq(campaignReviews.account_id, businessProfiles.account_id)),
        ),
      ),
    )
    .orderBy(asc(proposals.created_at), asc(proposals.id))
    .limit(limit);
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.proposal_id);
  const drafts = await db
    .select()
    .from(contentItems)
    .where(and(inArray(contentItems.proposal_id, ids), eq(contentItems.kind, "email")))
    .orderBy(asc(contentItems.created_at), asc(contentItems.id));
  const senders = await db
    .select({ account_id: connections.account_id, sender_name: connections.sender_name })
    .from(connections)
    .where(
      and(
        inArray(
          connections.account_id,
          rows.map((r) => r.account_id),
        ),
        eq(connections.provider, "email_campaign"),
        eq(connections.status, "connected"),
      ),
    );
  return rows.map((r) => {
    const draft = drafts.find((d) => d.proposal_id === r.proposal_id) ?? null;
    const action = r.action as { summary?: unknown; detail?: { contact_ids?: unknown } } | null;
    const ids = action?.detail?.contact_ids;
    return {
      proposal_id: r.proposal_id,
      account_id: r.account_id,
      summary: typeof action?.summary === "string" ? action.summary : "",
      recipients: Array.isArray(ids) ? ids.length : 0,
      sender_name: senders.find((s) => s.account_id === r.account_id)?.sender_name ?? null,
      subject: draft?.approved_subject ?? null,
      body: draft?.body ?? null,
      approved_at: draft?.approved_at ?? null,
    };
  });
}
