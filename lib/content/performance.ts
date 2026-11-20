// What performed before — P3-23c (Session D, layer D4).
//
// Shot lists (P3-17) and calendar proposals (P3-15) cite the measured
// per-post outcomes as evidence: "your three Reels out-performed your four
// photo posts 4:1 on Instagram". Only real measured rows count — the
// content.interactions.daily snapshots P3-23a stores — and the counts, the
// medians and the ratio are arithmetic here, never a model's words.
//
// Same age, or no comparison: every post is taken at day
// EVIDENCE.age_days after it went out (Meta's post figures are lifetime
// totals, so a month-old post would beat a week-old one on time alone). A
// post with no snapshot that day is left out. A format needs at least
// EVIDENCE.min_posts_per_format such posts, a platform at least two such
// formats, and the weaker format a median above zero (a ratio over nothing
// is not a ratio); otherwise there is no evidence line at all.

import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { db } from "../../db";
import { businessProfiles, contentItems, executions } from "../../db/schema";
import { POST_READBACK, loadPostSnapshots, median } from "../trust/post-readback";
import { shiftDay } from "../trust/series";

export const EVIDENCE = {
  /** Every post is compared at this many days after it went out. */
  age_days: POST_READBACK.judge_age_days,
  /** Fewer measured posts of a format than this: the format isn't cited. */
  min_posts_per_format: 3,
  /** Below this ratio the formats "did about the same". */
  outperform_at: 1.1,
} as const;

export type PostFormat = "reel" | "photo" | "text";

const FORMAT_WORD: Readonly<Record<PostFormat, string>> = {
  reel: "Reels",
  photo: "photo posts",
  text: "text posts",
};

const PLATFORM_WORD = { facebook: "Facebook", instagram: "Instagram" } as const;

const NUMBER_WORD = [
  "no",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
];
const countWord = (n: number) => NUMBER_WORD[n] ?? String(n);

/** Pure: the format a published item went out as, from its kind and the op that published it. */
export function formatOf(
  platform: "facebook" | "instagram",
  kind: string,
  op: string | null,
): PostFormat | null {
  if (kind === "video") return "reel";
  if (platform === "instagram") return "photo"; // Instagram needs media; a non-video is an image
  if (op === "publish_page_photo") return "photo";
  if (op === "publish_page_post") return "text";
  return null;
}

export interface FormatStat {
  format: PostFormat;
  posts: number;
  /** Median interactions at EVIDENCE.age_days. */
  median: number;
}

export interface PerformanceEvidence {
  line: string;
  platform: "facebook" | "instagram";
  metric: "content.interactions.daily";
  age_days: number;
  /** Strongest first. */
  formats: FormatStat[];
  /** strongest ÷ next, two decimals; null when they did about the same. */
  ratio: number | null;
  /** How the line was computed, with the numbers in it. */
  arithmetic: string;
}

/** Pure: "4:1" for ratios of 2 and up, one decimal below. */
export function ratioWord(r: number): string {
  return r >= 2 ? `${Math.round(r)}:1` : `${(Math.round(r * 10) / 10).toFixed(1)}:1`;
}

const fig = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));

/**
 * Pure: the evidence for one platform, or null when there is too little.
 * `values` holds each format's per-post interactions at the same age.
 */
export function compareFormats(
  platform: "facebook" | "instagram",
  values: ReadonlyMap<PostFormat, readonly number[]>,
): PerformanceEvidence | null {
  const stats: FormatStat[] = [...values.entries()]
    .filter(([, v]) => v.length >= EVIDENCE.min_posts_per_format)
    .map(([format, v]) => ({ format, posts: v.length, median: median(v) as number }))
    .sort((a, b) => b.median - a.median || b.posts - a.posts);
  if (stats.length < 2) return null;
  const [top, next] = stats as [FormatStat, FormatStat];
  if (next.median <= 0) return null;
  const r = top.median / next.median;
  const where = PLATFORM_WORD[platform];
  const tail =
    `a median of ${fig(top.median)} interactions in their first ${EVIDENCE.age_days} days, ` +
    `against ${fig(next.median)}`;
  const line =
    r >= EVIDENCE.outperform_at
      ? `Your ${countWord(top.posts)} ${FORMAT_WORD[top.format]} out-performed your ${countWord(next.posts)} ${FORMAT_WORD[next.format]} ${ratioWord(r)} on ${where}: ${tail}.`
      : `Your ${countWord(top.posts)} ${FORMAT_WORD[top.format]} and your ${countWord(next.posts)} ${FORMAT_WORD[next.format]} did about the same on ${where}: ${tail}.`;
  return {
    line,
    platform,
    metric: "content.interactions.daily",
    age_days: EVIDENCE.age_days,
    formats: stats,
    ratio: r >= EVIDENCE.outperform_at ? Math.round(r * 100) / 100 : null,
    arithmetic: `${fig(top.median)} ÷ ${fig(next.median)} = ${r.toFixed(2)} (medians of measured interactions on day ${EVIDENCE.age_days}; ${top.posts} and ${next.posts} posts)`,
  };
}

/** The profile's per-post evidence: the platform with the most measured posts that has a comparison. */
export async function performanceEvidence(profileId: string): Promise<PerformanceEvidence | null> {
  const [profile] = await db
    .select({ account_id: businessProfiles.account_id })
    .from(businessProfiles)
    .where(eq(businessProfiles.id, profileId));
  if (!profile) return null;
  const items = await db
    .select({
      kind: contentItems.kind,
      platform: contentItems.platform,
      platform_post_id: contentItems.platform_post_id,
      published_at: contentItems.published_at,
      op: executions.op,
    })
    .from(contentItems)
    .leftJoin(executions, eq(executions.id, contentItems.publish_execution_id))
    .where(
      and(
        eq(contentItems.profile_id, profileId),
        inArray(contentItems.status, ["published", "withdrawn"]),
        inArray(contentItems.platform, ["facebook", "instagram"]),
        isNotNull(contentItems.platform_post_id),
        isNotNull(contentItems.published_at),
      ),
    );

  const candidates: PerformanceEvidence[] = [];
  for (const platform of ["instagram", "facebook"] as const) {
    const mine = items.filter((i) => i.platform === platform);
    if (mine.length === 0) continue;
    const snapshots = await loadPostSnapshots(
      profile.account_id,
      platform,
      mine.map((i) => i.platform_post_id as string),
    );
    const values = new Map<PostFormat, number[]>();
    for (const i of mine) {
      const format = formatOf(platform, i.kind, i.op ?? null);
      if (format === null) continue;
      const day = shiftDay((i.published_at as string).slice(0, 10), EVIDENCE.age_days);
      const v = snapshots.get(i.platform_post_id as string)?.get(day)?.interactions;
      if (v === null || v === undefined) continue;
      values.set(format, [...(values.get(format) ?? []), v]);
    }
    const evidence = compareFormats(platform, values);
    if (evidence) candidates.push(evidence);
  }
  candidates.sort(
    (a, b) =>
      b.formats.reduce((n, f) => n + f.posts, 0) - a.formats.reduce((n, f) => n + f.posts, 0),
  );
  return candidates[0] ?? null;
}

/** The evidence as a scenario assumption, marked measured (the queue shows its basis). */
export function evidenceAssumption(e: PerformanceEvidence) {
  return {
    statement: e.line,
    value: null,
    source_field: null,
    measured: `measured per post · ${e.metric} · ${e.arithmetic}`,
    sensitivity: "medium" as const,
  };
}
