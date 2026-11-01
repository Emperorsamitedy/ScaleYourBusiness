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

import { and, eq, lt, sql } from "drizzle-orm";
import { db } from "../../db";
import { reviews } from "../../db/schema";
import type { reviewSettings } from "../../db/schema";
import type { SenderAuth } from "../support/inbound";
import type { AlertableReview } from "./alert";
import { claimReviewAlert, pushReviewAlert } from "./alert";
import type { ParsedReview, ReviewPlatformKey } from "./parse";
import { REVIEW_LIMITS, dedupeKey, worthKnowing } from "./parse";
import { twinOf } from "./twin";

export type ReviewRow = typeof reviews.$inferSelect;
export type ReviewSettingsRow = typeof reviewSettings.$inferSelect;

/** How long a review, and the reviewer's name on it, is kept. */
export const REVIEW_RETENTION_DAYS = 365;
const DAY_MS = 86_400_000;

export function expiryOf(receivedAt: string): string {
  return new Date(Date.parse(receivedAt) + REVIEW_RETENTION_DAYS * DAY_MS).toISOString();
}

export type ReadBy = "parser" | "model" | "owner" | "unread" | "api";

export interface ReviewToFile extends ParsedReview {
  profile_id: string;
  account_id: string;
  platform: ReviewPlatformKey;
  /** I-45a: "google" — read from the owner's Business Profile by Google's API. */
  source: "email" | "paste" | "google";
  read_by: ReadBy;
  received_at: string;
  provider_id: string | null;
  /** What an unread one keys on: its Message-ID, else the provider's id. */
  fallback_id: string | null;
  sender_auth: SenderAuth | null;
  /**
   * I-45a: the key to file on instead of the content hash, for a review that
   * has its own id at its platform (Google's review name). Two text-less
   * reviews with the same stars are two reviews there.
   */
  dedupe_basis?: string;
  /**
   * I-45a: false files the review quietly — still marked worth knowing, but
   * with no alert line. For a review read back from before SYB was
   * connected: old news isn't "a review came in". Default true.
   */
  alert?: boolean;
}

export type FileOutcome =
  { kind: "filed"; review: ReviewRow; alerted: boolean } | { kind: "duplicate" };

/** I-45a: a review keyed on its own platform id hashes that id alone. */
const NO_CONTENT = { stars: null, reviewer: null, text: null, link: null } as const;

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
  // As instants (review 2026-10-30): the two strings needn't share a format.
  const reviewedAt =
    r.reviewed_at && Date.parse(r.reviewed_at) <= Date.parse(r.received_at)
      ? r.reviewed_at
      : r.received_at;
  await pruneExpiredReviews(now, r.profile_id);
  // The row and its one alert commit together: a failure files neither, so
  // the webhook's retry files the review AND raises its alert.
  const filed = await db.transaction(async (tx) => {
    if (r.platform === "google") {
      // I-45a: the same review by email and from Google's API files once. One
      // business's Google reviews are filed one at a time, so two arrivals of
      // one review can't both miss each other.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`reviews-google:${r.profile_id}`}))`,
      );
      const twin = await twinOf(tx, {
        profile_id: r.profile_id,
        platform: r.platform,
        source: r.source,
        stars,
        text,
        reviewer,
        reviewed_at: reviewedAt,
      });
      if (twin !== null) return null;
    }
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
        dedupe_key:
          r.dedupe_basis !== undefined
            ? dedupeKey(r.platform, NO_CONTENT, r.dedupe_basis)
            : dedupeKey(r.platform, { stars, reviewer, text, link }, r.fallback_id),
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
    const claimed =
      r.alert === false ? false : await claimReviewAlert(alertable, { now, executor: tx });
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
