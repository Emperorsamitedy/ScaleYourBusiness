// The reviews address, the OWNER side — idea 45 (I-45.1).
//
// Creating and rotating the token in r-<token>@<SUPPORT_INBOUND_DOMAIN>.
// The stranger tier (lib/reviews) only reads the row this writes; the
// rule-21 structural test keeps lib/review-desk out of its reach.

import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { businessProfiles, reviewSettings } from "../../db/schema";
import type { ReviewSettingsRow } from "../reviews/store";

export class ReviewDeskError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "ReviewDeskError";
    this.status = status;
  }
}

export async function reviewSettingsFor(profileId: string): Promise<ReviewSettingsRow | null> {
  const [row] = await db
    .select()
    .from(reviewSettings)
    .where(eq(reviewSettings.profile_id, profileId));
  return row ?? null;
}

/** The business's reviews settings, created on first call with a fresh token. */
export async function ensureReviewSettings(profileId: string): Promise<ReviewSettingsRow> {
  const existing = await reviewSettingsFor(profileId);
  if (existing) return existing;
  const [profile] = await db
    .select({ account_id: businessProfiles.account_id })
    .from(businessProfiles)
    .where(eq(businessProfiles.id, profileId));
  if (!profile) throw new ReviewDeskError("no such business", 404);
  const [row] = await db
    .insert(reviewSettings)
    .values({ profile_id: profileId, account_id: profile.account_id })
    .onConflictDoNothing()
    .returning();
  return row ?? ((await reviewSettingsFor(profileId)) as ReviewSettingsRow);
}

/**
 * A new reviews address. Mail to the old one stops filing the moment this
 * returns (it is dropped), so the owner must update their forwarding.
 */
export async function rotateReviewToken(profileId: string): Promise<ReviewSettingsRow> {
  await ensureReviewSettings(profileId);
  const [row] = await db
    .update(reviewSettings)
    .set({
      inbound_token: randomBytes(16).toString("hex"),
      inbound_rotated_at: new Date().toISOString(),
    })
    .where(eq(reviewSettings.profile_id, profileId))
    .returning();
  if (!row) throw new ReviewDeskError("no such business", 404);
  console.log(JSON.stringify({ event: "review_address_rotated", account_id: row.account_id }));
  return row;
}
