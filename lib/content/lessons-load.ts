// Posts that learn: reading the lessons (see ./lessons for what they are and
// what holds them to the drafting fence).
//
// The business's newest published posts on one platform, each judged on its
// own measured first week by the verdict that already exists
// (lib/trust/post-readback: against the median of the posts before it, at the
// same age). Reads only; no model is called and nothing is written.
//
// Only posts count, and only ones still up: a video's figures are the
// video's, not its caption's, and a post the owner took down again is no
// example of what to write, whatever it measured.

import { and, desc, eq, isNotNull } from "drizzle-orm";
import { db } from "../../db";
import { contentItems } from "../../db/schema";
import { enumCode } from "../core/enum-value";
import { readCurrentField } from "../profile/field-store";
import { postOutcome } from "../trust/post-readback";
import type { DraftLessons, JudgedPost, LessonPlatform } from "./lessons";
import { LESSONS, isLessonPlatform, pickLessons } from "./lessons";

/** The lessons a business's own posts on one platform hold, or null when none is judged yet. */
export async function lessonsFor(
  profileId: string,
  platform: LessonPlatform,
): Promise<DraftLessons | null> {
  const posts = await db
    .select({
      id: contentItems.id,
      profile_id: contentItems.profile_id,
      status: contentItems.status,
      platform: contentItems.platform,
      platform_post_id: contentItems.platform_post_id,
      published_at: contentItems.published_at,
      body: contentItems.body,
    })
    .from(contentItems)
    .where(
      and(
        eq(contentItems.profile_id, profileId),
        eq(contentItems.kind, "post"),
        eq(contentItems.status, "published"),
        eq(contentItems.platform, platform),
        isNotNull(contentItems.platform_post_id),
        isNotNull(contentItems.published_at),
      ),
    )
    .orderBy(desc(contentItems.published_at))
    .limit(LESSONS.judged_posts);

  const judged: JudgedPost[] = [];
  for (const post of posts) {
    const outcome = await postOutcome(post);
    judged.push({
      item_id: post.id,
      body: post.body,
      published_at: post.published_at as string,
      verdict: outcome.verdict,
      arithmetic: outcome.arithmetic,
    });
  }
  return pickLessons(platform, judged);
}

/**
 * The lessons for a planned slot: its channel's platform decides whose posts
 * are looked at. A channel that is not Facebook or Instagram has no measured
 * posts, so no lessons.
 */
export async function lessonsForChannel(
  profileId: string,
  channelId: string,
): Promise<DraftLessons | null> {
  const field = await readCurrentField<unknown>(profileId, `channels.${channelId}.platform`);
  const platform = enumCode(field?.value);
  return isLessonPlatform(platform) ? lessonsFor(profileId, platform) : null;
}
