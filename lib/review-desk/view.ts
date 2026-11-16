// What /reviews shows — idea 45 (I-45.4). Read-only apart from creating the
// business's reviews address on first view and pruning what has passed its
// year. The reviewer's public name and the words go to the owner's own
// screen only.

import { desc, eq } from "drizzle-orm";
import { db } from "../../db";
import { reviews } from "../../db/schema";
import { googleBusinessEnv, supportInboundDomain } from "../env";
import { activeExecutionConnection } from "../execution/connections";
import { googleWriteConsentCurrent } from "../google-business/consent";
import { googleReadWords } from "../google-business/reasons";
import { GOOGLE_NEEDS, GOOGLE_NOT_SET_UP, GOOGLE_WHAT_IT_CAN_DO } from "../google-business/words";
import type { Tr } from "../i18n/tr";
import { englishTr } from "../i18n/tr";
import { reviewAddress } from "../reviews/inbound";
import type { ReviewPlatformKey } from "../reviews/parse";
import { PLATFORM_LABELS, REVIEW_PLATFORMS } from "../reviews/parse";
import { REVIEW_RETENTION_DAYS, pruneExpiredReviews } from "../reviews/store";
import { REVIEW_DRAFTS_PER_REVIEW } from "./draft";
import type { ReplyState } from "./post";
import { googleReviewName, replyStates } from "./post";
import { ensureReviewSettings } from "./settings";

/** The most reviews the screen lists, newest first. */
export const REVIEWS_SHOWN = 200;

export interface ReviewItem {
  id: string;
  platform: ReviewPlatformKey;
  platform_label: string;
  stars: number | null;
  reviewer: string | null;
  text: string | null;
  link: string | null;
  reviewed_at: string;
  read_by: "parser" | "model" | "owner" | "unread" | "api";
  source: "email" | "paste" | "google";
  worth_knowing: boolean;
  draft: string | null;
  drafts_left: number;
  /** I-45a lifted: a Google review ScaleX may post a reply under, and that reply's state. */
  post: { can: boolean; state: ReplyState | null };
}

export interface ReviewsView {
  today: string;
  forwarding: {
    configured: boolean;
    address: string | null;
    /** Review 2026-10-30: Gmail's latest forwarding confirmation to the address, if one came. */
    gmail: { code: string | null; link: string | null; at: string } | null;
  };
  /** I-45a: reading reviews straight from Google Business Profile, under its own consent. */
  google: {
    configured: boolean;
    connected: boolean;
    /** The connection is there but Google stopped accepting it. */
    failed: boolean;
    /** I-45a lifted: the connection's consent covers posting replies. False = reconnect to allow it. */
    can_post: boolean;
    location_title: string | null;
    last_read: { at: string; words: string | null } | null;
    what_it_can_do: string;
    not_set_up: string | null;
    needs: readonly string[];
  };
  reviews: ReviewItem[];
  platforms: { key: ReviewPlatformKey; label: string }[];
  retention_days: number;
  drafts_per_review: number;
}

const asPlatform = (p: string): ReviewPlatformKey =>
  p in PLATFORM_LABELS ? (p as ReviewPlatformKey) : "other";

/**
 * L-4b: the last read's outcome is said in `tr` ("reviewsWords", English
 * by default). Reviews, reviewers and drafts are content, as stored.
 */
export async function loadReviewsView(
  profileId: string,
  now = new Date(),
  tr: Tr = englishTr("reviewsWords"),
): Promise<ReviewsView> {
  const settings = await ensureReviewSettings(profileId);
  await pruneExpiredReviews(now, profileId);
  const rows = await db
    .select()
    .from(reviews)
    .where(eq(reviews.profile_id, profileId))
    .orderBy(desc(reviews.reviewed_at), desc(reviews.received_at))
    .limit(REVIEWS_SHOWN);
  const domain = supportInboundDomain();
  const google = await activeExecutionConnection(settings.account_id, "google_business_reviews");
  const googleConfigured = googleBusinessEnv() !== null;
  const canPost = google !== null && (await googleWriteConsentCurrent(settings.account_id));
  const states = await replyStates(profileId);
  return {
    today: now.toISOString().slice(0, 10),
    forwarding: {
      configured: domain !== null,
      address: domain ? reviewAddress(settings.inbound_token, domain) : null,
      gmail: settings.gmail_confirmation ?? null,
    },
    google: {
      configured: googleConfigured,
      connected: google !== null,
      failed: google?.status === "failed",
      can_post: canPost,
      location_title: google ? settings.google_location_title : null,
      last_read:
        google && settings.google_read_at
          ? {
              at: settings.google_read_at,
              words: googleReadWords(settings.google_read_outcome, tr),
            }
          : null,
      what_it_can_do: GOOGLE_WHAT_IT_CAN_DO,
      not_set_up: googleConfigured ? null : GOOGLE_NOT_SET_UP,
      needs: GOOGLE_NEEDS,
    },
    reviews: rows.map((r) => {
      const platform = asPlatform(r.platform);
      return {
        id: r.id,
        platform,
        platform_label: PLATFORM_LABELS[platform],
        stars: r.stars,
        reviewer: r.reviewer,
        text: r.text,
        link: r.link,
        reviewed_at: r.reviewed_at,
        read_by: r.read_by as ReviewItem["read_by"],
        source: r.source as ReviewItem["source"],
        worth_knowing: r.worth_knowing,
        draft: r.draft,
        drafts_left: Math.max(0, REVIEW_DRAFTS_PER_REVIEW - r.draft_calls),
        post: { can: canPost && googleReviewName(r) !== null, state: states.get(r.id) ?? null },
      };
    }),
    platforms: [...REVIEW_PLATFORMS, "other" as const].map((key) => ({
      key,
      label: PLATFORM_LABELS[key],
    })),
    retention_days: REVIEW_RETENTION_DAYS,
    drafts_per_review: REVIEW_DRAFTS_PER_REVIEW,
  };
}
