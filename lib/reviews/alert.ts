// The alert a poor review raises — idea 45 (I-45.2).
//
// A review that is worth knowing (./parse.ts worthKnowing: 3 stars or
// fewer, or flagged words with no stars) raises ONE alert, ever: the
// review row's alerted_at is claimed atomically before anything is
// written, so a redelivery, a re-forward or two racing deliveries can't
// say it twice. A 4- or 5-star review raises none; it is listed, quietly.
//
// Today the alert is a line on the watch log ("What I noticed", and the
// weekly summary's reviews section reads the same rows). The line names
// the platform and the stars, never the reviewer and never the words.
//
// PHONE ALERTS (idea 53) ARE NOT ON THIS BRANCH. `phoneAlertHook` below is
// where they plug in: it is handed only `lockScreenLine` — "A 2-star
// review on Google" — and today does nothing but say so in the log.
//
// Stranger-reachable (the inbound webhook files reviews): this module
// writes the watch_activity table through the database alone and imports
// nothing from lib/watch (the rule-21 structural test holds it to that).

import { and, eq, isNull } from "drizzle-orm";
import type { DbOrTx } from "../../db";
import { db } from "../../db";
import { reviews, watchActivity } from "../../db/schema";
import type { ReviewPlatformKey } from "./parse";
import { PLATFORM_LABELS } from "./parse";

/** The watch-log kind of a review worth knowing. lib/watch/watch-view lists it as noticed. */
export const REVIEW_ALERT_KIND = "review_alert";

function platformName(platform: ReviewPlatformKey): string {
  return platform === "other" ? "another site" : PLATFORM_LABELS[platform];
}

/** The watch log's line: platform and stars only. */
export function alertLine(platform: ReviewPlatformKey, stars: number | null): string {
  return stars !== null
    ? `A ${stars}-star review came in on ${platformName(platform)}.`
    : `A review on ${platformName(platform)} came in with words worth reading.`;
}

/** What a phone's lock screen may show (idea 53): no reviewer, no words. */
export function lockScreenLine(platform: ReviewPlatformKey, stars: number | null): string {
  return stars !== null
    ? `A ${stars}-star review on ${platformName(platform)}`
    : `A review worth reading on ${platformName(platform)}`;
}

export type PhoneAlertHook = (args: {
  account_id: string;
  profile_id: string;
  review_id: string;
  line: string;
}) => Promise<"sent" | "not_built" | "failed">;

/**
 * Idea 53's push goes here. Until it merges this sends nothing: it logs
 * that a phone alert would have gone, with ids only.
 */
export const phoneAlertHook: PhoneAlertHook = async (args) => {
  console.log(
    JSON.stringify({
      event: "review_phone_alert_not_built",
      account_id: args.account_id,
      profile_id: args.profile_id,
      review_id: args.review_id,
    }),
  );
  return "not_built";
};

export interface AlertableReview {
  id: string;
  account_id: string;
  profile_id: string;
  platform: ReviewPlatformKey;
  stars: number | null;
  worth_knowing: boolean;
}

/**
 * Claim the review's one alert and write its watch line, inside the
 * caller's transaction when given one. Returns whether this call claimed
 * it: false for a quiet review, or one that has already raised its alert.
 */
export async function claimReviewAlert(
  review: AlertableReview,
  opts: { now?: Date; executor?: DbOrTx } = {},
): Promise<boolean> {
  if (!review.worth_knowing) return false;
  const executor = opts.executor ?? db;
  const at = (opts.now ?? new Date()).toISOString();
  const [claimed] = await executor
    .update(reviews)
    .set({ alerted_at: at })
    .where(
      and(eq(reviews.id, review.id), eq(reviews.worth_knowing, true), isNull(reviews.alerted_at)),
    )
    .returning({ id: reviews.id });
  if (!claimed) return false;
  await executor.insert(watchActivity).values({
    profile_id: review.profile_id,
    at,
    kind: REVIEW_ALERT_KIND,
    detail: alertLine(review.platform, review.stars),
    // Ids and the facts the line states: no reviewer, no words.
    meta: { review_id: review.id, platform: review.platform, stars: review.stars },
  });
  return true;
}

/** After the claim has committed: the phone, best effort, never a reason to undo the watch line. */
export async function pushReviewAlert(
  review: AlertableReview,
  phone: PhoneAlertHook = phoneAlertHook,
): Promise<void> {
  await phone({
    account_id: review.account_id,
    profile_id: review.profile_id,
    review_id: review.id,
    line: lockScreenLine(review.platform, review.stars),
  }).catch(() => "failed" as const);
}
