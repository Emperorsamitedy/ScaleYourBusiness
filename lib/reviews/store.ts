// Filing a review — idea 45 (I-45.1, I-45.2). One path for every review,
// forwarded or pasted: bounded, keyed so the same review files once,
// alerted at most once, and gone after REVIEW_RETENTION_DAYS.
//
// Rule 22 and rule 19: the reviewer is a person. Only the name the
// platform showed publicly is kept, on this row and nowhere else (no
// contact, no log line, no watch line), the row expires a year after it
// was filed, and the owner can remove it at once (lib/review-desk/erase).
//
// Stranger-reachable through the inbound webhook: lib/reviews and the
// database only.

import { and, eq, lt } from "drizzle-orm";
import { db } from "../../db";
import { reviews } from "../../db/schema";
import type { reviewSettings } from "../../db/schema";
import type { SenderAuth } from "../support/inbound";
import type { AlertableReview } from "./alert";
import { claimReviewAlert, pushReviewAlert } from "./alert";
import type { ParsedReview, ReviewPlatformKey } from "./parse";
import { REVIEW_LIMITS, dedupeKey, worthKnowing } from "./parse";

export type ReviewRow = typeof reviews.$inferSelect;
export type ReviewSettingsRow = typeof reviewSettings.$inferSelect;

/** How long a review, and the reviewer's name on it, is kept. */
export const REVIEW_RETENTION_DAYS = 365;
const DAY_MS = 86_400_000;

export function expiryOf(receivedAt: string): string {
  return new Date(Date.parse(receivedAt) + REVIEW_RETENTION_DAYS * DAY_MS).toISOString();
}

export type ReadBy = "parser" | "model" | "owner" | "unread";

export interface ReviewToFile extends ParsedReview {
  profile_id: string;
  account_id: string;
  platform: ReviewPlatformKey;
  source: "email" | "paste";
  read_by: ReadBy;
  received_at: string;
  provider_id: string | null;
  /** What an unread one keys on: its Message-ID, else the provider's id. */
  fallback_id: string | null;
  sender_auth: SenderAuth | null;
}

export type FileOutcome =
  { kind: "filed"; review: ReviewRow; alerted: boolean } | { kind: "duplicate" };

const clip = (s: string | null, max: number) => (s === null ? null : s.slice(0, max));

/** Delete what has passed its year. For one business, or (no id) for all of them. */
export async function pruneExpiredReviews(now: Date, profileId?: string): Promise<number> {
  const cutoff = now.toISOString();
  const rows = await db
    .delete(reviews)
    .where(
      profileId
        ? and(eq(reviews.profile_id, profileId), lt(reviews.expires_at, cutoff))
        : lt(reviews.expires_at, cutoff),
    )
    .returning({ id: reviews.id });
  return rows.length;
}

/** File one review, raise its alert when it is worth knowing, prune the business's expired ones. */
export async function fileReview(r: ReviewToFile, now = new Date()): Promise<FileOutcome> {
  const stars =
    r.stars !== null && Number.isInteger(r.stars) && r.stars >= 1 && r.stars <= 5 ? r.stars : null;
  const text = clip(r.text, REVIEW_LIMITS.text_chars);
  const reviewer = clip(r.reviewer, REVIEW_LIMITS.reviewer_chars);
  const link = clip(r.link, REVIEW_LIMITS.link_chars);
  const worth = worthKnowing(stars, text);
  // A review can't be dated after it reached SYB.
  const reviewedAt =
    r.reviewed_at && r.reviewed_at <= r.received_at ? r.reviewed_at : r.received_at;
  await pruneExpiredReviews(now, r.profile_id);
  // The row and its one alert commit together: a failure files neither, so
  // the webhook's retry files the review AND raises its alert.
  const filed = await db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(reviews)
      .values({
        profile_id: r.profile_id,
        account_id: r.account_id,
        platform: r.platform,
        source: r.source,
        read_by: r.read_by,
        stars,
        reviewer,
        text,
        link,
        reviewed_at: reviewedAt,
        received_at: r.received_at,
        provider_id: r.provider_id,
        dedupe_key: dedupeKey(r.platform, { stars, reviewer, text, link }, r.fallback_id),
        sender_auth: r.sender_auth,
        worth_knowing: worth,
        expires_at: expiryOf(r.received_at),
      })
      .onConflictDoNothing()
      .returning();
    if (!inserted) return null;
    const alertable: AlertableReview = {
      id: inserted.id,
      account_id: inserted.account_id,
      profile_id: inserted.profile_id,
      platform: inserted.platform as ReviewPlatformKey,
      stars: inserted.stars,
      worth_knowing: inserted.worth_knowing,
    };
    const claimed = await claimReviewAlert(alertable, { now, executor: tx });
    return { row: inserted, alertable, claimed };
  });
  if (!filed) return { kind: "duplicate" };
  const { row, alertable, claimed: alerted } = filed;
  if (alerted) await pushReviewAlert(alertable);
  // Ids and facts only: never the reviewer, the words or the link.
  console.log(
    JSON.stringify({
      event: "review_filed",
      account_id: row.account_id,
      profile_id: row.profile_id,
      review_id: row.id,
      platform: row.platform,
      source: row.source,
      read_by: row.read_by,
      stars: row.stars,
      worth_knowing: row.worth_knowing,
      alerted,
    }),
  );
  return { kind: "filed", review: row, alerted };
}
