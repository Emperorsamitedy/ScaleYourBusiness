// "Paste a review" — idea 45 (I-45.4). The owner types or pastes a review
// they saw (a platform with no notification email, or before forwarding
// is set up). No model: the owner says the platform and the stars, and the
// words are kept as given. It files through the same path as a forwarded
// one, so the same bounds, the same key, the same one alert and the same
// 365 days apply.

import type { ReviewPlatformKey } from "../reviews/parse";
import { REVIEW_LIMITS, isPlatformKey, platformLink } from "../reviews/parse";
import type { FileOutcome } from "../reviews/store";
import { fileReview } from "../reviews/store";
import { ReviewDeskError, ensureReviewSettings } from "./settings";

export interface PastedReview {
  platform: ReviewPlatformKey;
  stars: number;
  text: string | null;
  reviewer: string | null;
  link: string | null;
  /** YYYY-MM-DD; null = today. */
  date: string | null;
}

const optional = (v: unknown, max: number, what: string): string | null => {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw new ReviewDeskError(`${what} should be text`, 422);
  const t = v.trim();
  if (t === "") return null;
  if (t.length > max) throw new ReviewDeskError(`${what} is longer than ${max} characters`, 422);
  return t;
};

/** The form's body, checked. Pure. Throws a ReviewDeskError (422) saying what to fix. */
export function readPaste(body: Record<string, unknown>, now: Date): PastedReview {
  if (!isPlatformKey(body.platform)) {
    throw new ReviewDeskError("choose where the review was left", 422);
  }
  const stars = Number(body.stars);
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) {
    throw new ReviewDeskError("choose how many stars, 1 to 5", 422);
  }
  const text = optional(body.text, REVIEW_LIMITS.text_chars, "The review");
  const reviewer = optional(body.reviewer, REVIEW_LIMITS.reviewer_chars, "The name");
  const rawLink = optional(body.link, REVIEW_LIMITS.link_chars, "The link");
  const link = rawLink ? platformLink(rawLink, body.platform) : null;
  if (rawLink && !link) {
    throw new ReviewDeskError(
      body.platform === "other"
        ? "the link should start with https://"
        : `that link isn't on ${body.platform === "google" ? "Google" : "that site"}'s own pages`,
      422,
    );
  }
  const rawDate = optional(body.date, 10, "The date");
  let date: string | null = null;
  if (rawDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(rawDate) || Number.isNaN(Date.parse(`${rawDate}T12:00:00Z`))) {
      throw new ReviewDeskError("the date should look like 2026-10-27", 422);
    }
    if (rawDate > now.toISOString().slice(0, 10)) {
      throw new ReviewDeskError("the date can't be in the future", 422);
    }
    date = rawDate;
  }
  return { platform: body.platform, stars, text, reviewer, link, date };
}

export async function pasteReview(
  profileId: string,
  pasted: PastedReview,
  now = new Date(),
): Promise<FileOutcome> {
  const settings = await ensureReviewSettings(profileId);
  return fileReview(
    {
      profile_id: profileId,
      account_id: settings.account_id,
      platform: pasted.platform,
      source: "paste",
      read_by: "owner",
      stars: pasted.stars,
      reviewer: pasted.reviewer,
      text: pasted.text,
      link: pasted.link,
      reviewed_at: pasted.date ? `${pasted.date}T12:00:00.000Z` : null,
      received_at: now.toISOString(),
      provider_id: null,
      fallback_id: null,
      sender_auth: null,
    },
    now,
  );
}
