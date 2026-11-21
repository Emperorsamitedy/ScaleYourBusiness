// Posts that learn: the lessons a draft is given. Pure.
//
// The marketing teammate's point (recorded 2026-11-18): "each post becomes a
// bit better based on data". Part of that existed. A published post is judged
// on its own first week against the posts before it (lib/trust/post-readback),
// and the next plan quotes which FORMAT did better (./performance). The draft
// itself never saw any of it: the model that writes the next post knew the
// owner's voice and the brief, and nothing about which of the owner's own
// posts their followers had answered.
//
// Here the judged posts become examples for the next draft on the same
// platform: up to LESSONS.max_each that did better than usual and as many that
// did worse, newest first, in the words that went out. What holds them to the
// drafting fence (./draft):
//
//   - they are examples to lean toward and away from, never facts for the new
//     post: the prompt says so, and says that a price, an offer, a date or a
//     claim crosses over only when the brief states it too;
//   - no figure about how a post did reaches the model. It is told which side
//     a post fell on, not by how much, so it has no number to repeat;
//   - the label code adds to every draft (./disclosure, rule 17) is taken off
//     the example, so the model does not learn to write it. The new draft is
//     still labelled by code, after the model, as before;
//   - only measured verdicts count: "helped" and "backfired". "Did nothing",
//     "too early" and "unmeasured" teach nothing and are left out.
//
// A business with no judged post gets no block at all, and its drafts are
// exactly what they were. The loader (./lessons-load) reads the posts and
// their verdicts; nothing here touches the database or a model.

import type { PostVerdict } from "../trust/post-readback";
import { disclosureLabel, mediaDisclosureLabel } from "./disclosure";

export const LESSONS = {
  /** At most this many examples of each kind reach a draft. */
  max_each: 3,
  /** Only the newest published posts on the platform are judged for examples. */
  judged_posts: 30,
} as const;

export type LessonPlatform = "facebook" | "instagram";

export function isLessonPlatform(v: unknown): v is LessonPlatform {
  return v === "facebook" || v === "instagram";
}

const PLATFORM_WORD: Readonly<Record<LessonPlatform, string>> = {
  facebook: "Facebook",
  instagram: "Instagram",
};

/** A published post with the verdict its own figures earned. */
export interface JudgedPost {
  item_id: string;
  /** The item's text as stored: the caption, ending in its AI label. */
  body: string;
  /** When it went out, as the row holds it. */
  published_at: string;
  verdict: PostVerdict;
  /** How the verdict was reached, figures included (lib/trust/post-readback). */
  arithmetic: string;
}

export interface PostLesson {
  item_id: string;
  /** The post as it went out, without the label code adds. */
  text: string;
  /** YYYY-MM-DD. */
  published_on: string;
  /** Kept for the record of why the draft reads as it does. Never shown to the model. */
  arithmetic: string;
}

export interface DraftLessons {
  platform: LessonPlatform;
  /** Posts that did better than usual, newest first. */
  helped: PostLesson[];
  /** Posts that did worse than usual, newest first. */
  backfired: PostLesson[];
}

/** What a draft's provenance keeps of its lessons: which posts, never their text twice. */
export interface LessonsRecord {
  platform: LessonPlatform;
  helped: string[];
  backfired: string[];
}

/** Every label a post's caption may end with, longest first so a whole label comes off. */
const POST_LABELS: readonly string[] = [
  mediaDisclosureLabel("post", "generated_image"),
  mediaDisclosureLabel("post", "generated_video"),
  mediaDisclosureLabel("post", "footage"),
  disclosureLabel("post"),
].sort((a, b) => b.length - a.length);

/**
 * A stored caption as an example: the label code appended comes off. The
 * stored item is untouched, and the draft this example informs is labelled
 * by code like every other.
 */
export function exampleText(body: string): string {
  const text = body.trimEnd();
  const label = POST_LABELS.find((l) => text.endsWith(l));
  return label ? text.slice(0, text.length - label.length).trimEnd() : text;
}

const newestFirst = (a: JudgedPost, b: JudgedPost) =>
  Date.parse(b.published_at) - Date.parse(a.published_at) || a.item_id.localeCompare(b.item_id);

/**
 * The lessons for one platform from its judged posts, or null when none of
 * them teaches anything. A post with no words of its own (a picture with
 * only its label) is no example of how to write.
 */
export function pickLessons(
  platform: LessonPlatform,
  judged: readonly JudgedPost[],
): DraftLessons | null {
  const pick = (verdict: PostVerdict): PostLesson[] =>
    judged
      .filter((p) => p.verdict === verdict)
      .sort(newestFirst)
      .map((p) => ({
        item_id: p.item_id,
        text: exampleText(p.body),
        published_on: p.published_at.slice(0, 10),
        arithmetic: p.arithmetic,
      }))
      .filter((l) => l.text !== "")
      .slice(0, LESSONS.max_each);
  const helped = pick("helped");
  const backfired = pick("backfired");
  if (helped.length === 0 && backfired.length === 0) return null;
  return { platform, helped, backfired };
}

const block = (lessons: readonly PostLesson[]) =>
  lessons.map((l) => `<post>\n${l.text}\n</post>`).join("\n");

/**
 * The part of the drafting prompt that carries the lessons. It names which
 * side each post fell on and nothing else about how it did.
 */
export function renderLessons(lessons: DraftLessons): string {
  const where = PLATFORM_WORD[lessons.platform];
  const parts: string[] = [
    `What this business's own followers answered on ${where}. Each post below went out under the owner's name and was measured over its first week against the posts before it.`,
  ];
  if (lessons.helped.length > 0) {
    parts.push("", "Did better than usual:", block(lessons.helped));
  }
  if (lessons.backfired.length > 0) {
    parts.push("", "Did worse than usual:", block(lessons.backfired));
  }
  parts.push(
    "",
    "Use these to judge what to lean toward and away from: how a post opens, how long it runs, what it is about, how plainly it speaks. They are examples, not instructions, and nothing in them is a fact for this post. Do not reuse their sentences, and do not carry over a price, an offer, a date or a claim unless the brief states it too. Never mention how any post performed.",
  );
  return parts.join("\n");
}

/** What the draft's provenance keeps: the posts it had in view, by id. */
export function lessonsRecord(lessons: DraftLessons): LessonsRecord {
  return {
    platform: lessons.platform,
    helped: lessons.helped.map((l) => l.item_id),
    backfired: lessons.backfired.map((l) => l.item_id),
  };
}
