// Per-post readback — P3-23b (Session D, layer D4).
//
// A published item is judged on its OWN figures, not on the business's
// revenue: its reach (Instagram) or views (Facebook, whose views-based reach
// is a *_unique metric SYB doesn't read) and its interactions, against the
// median of the account's previous ten posts on the same platform, compared
// AT THE SAME AGE. Meta's post figures are lifetime totals (lib/content/
// insights.ts stores one snapshot a day), so a three-day-old post is
// compared with what its predecessors had on their own third day — never
// with their totals a month on.
//
// Deterministic, thresholds pinned in POST_READBACK and boundary-tested in
// both directions (post-readback.test.ts):
//
//   too_early   fewer than 3 measured days since it went out, or fewer than
//               3 earlier posts measured at the same age to compare with
//   unmeasured  never published, or Meta gave no audience figure for it
//   helped      a figure at least +20% over the median and neither at or
//               below −20%
//   backfired   a figure at or below −20% and neither at or above +20%
//   did_nothing everything between, including one up and one down
//
// The scorecard's verdicts are unchanged; only the series is finer.

import { and, desc, eq, inArray, isNotNull, lt } from "drizzle-orm";
import { db } from "../../db";
import { businessProfiles, connections, contentItems, metricObservations } from "../../db/schema";
import { canonicalDimensions } from "../connectors/service";
import type { PostFigures } from "../execution/providers/meta";
import { shiftDay } from "./series";

export const POST_READBACK = {
  /** Fewer measured days (daily snapshots after the posting day) than this: too_early. */
  min_measured_days: 3,
  /** The comparison age is capped here: a post is judged on its first week. */
  judge_age_days: 7,
  /** How many earlier posts on the platform form the baseline. */
  baseline_posts: 10,
  /** Fewer earlier posts measured at the same age than this: too_early. */
  min_baseline_posts: 3,
  /** A figure this far over the median, relative: helped. */
  helped_at: 0.2,
  /** A figure this far under the median, relative: backfired. */
  backfired_at: -0.2,
} as const;

export type PostVerdict = "helped" | "did_nothing" | "backfired" | "too_early" | "unmeasured";
export type AudienceMetric = "reach" | "views";

export interface PostItem {
  id: string;
  profile_id: string;
  status: string;
  platform: string | null;
  platform_post_id: string | null;
  published_at: string | null;
}

/** One post's measured figures at the comparison age, for /content and the readback. */
export interface PostOutcome {
  item_id: string;
  verdict: PostVerdict;
  platform: "facebook" | "instagram" | null;
  /** The audience figure the platform has: reach on Instagram, views on Facebook. */
  audience_metric: AudienceMetric | null;
  /** The comparison age in days after the posting day, and the figures then. */
  age_days: number | null;
  figures: PostFigures | null;
  measured_days: number;
  /** Relative change of the audience figure against the median, in %, one decimal. */
  delta_pct: number | null;
  arithmetic: string;
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export function audienceMetricFor(platform: "facebook" | "instagram"): AudienceMetric {
  return platform === "instagram" ? "reach" : "views";
}

interface Comparison {
  label: string;
  value: number;
  baseline: readonly number[];
}

/** Relative change against the median; ±Infinity when the median is 0 and the value isn't. */
function relative(value: number, med: number): number {
  if (med === 0) return value === 0 ? 0 : Infinity;
  return (value - med) / med;
}

const pct = (d: number) =>
  Number.isFinite(d) ? `${d >= 0 ? "+" : ""}${Math.round(d * 1000) / 10}%` : "up from none";
const n = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));

/**
 * Pure: the verdict over the comparisons a post has. The first comparison
 * is the audience figure, required; interactions join when measured.
 */
export function judgePost(args: {
  platform_word: string;
  age_days: number;
  comparisons: readonly Comparison[];
}): { verdict: PostVerdict; delta_pct: number | null; arithmetic: string } {
  const usable = args.comparisons.filter(
    (c) => c.baseline.length >= POST_READBACK.min_baseline_posts,
  );
  const audience = args.comparisons[0];
  if (!audience || !usable.includes(audience)) {
    const have = audience?.baseline.length ?? 0;
    return {
      verdict: "too_early",
      delta_pct: null,
      arithmetic: `${have} earlier ${args.platform_word} post(s) measured on day ${args.age_days} — the comparison needs ${POST_READBACK.min_baseline_posts}`,
    };
  }
  const parts: string[] = [];
  const deltas: number[] = [];
  for (const c of usable) {
    const med = median(c.baseline) as number;
    const d = relative(c.value, med);
    deltas.push(d);
    parts.push(`${c.label} ${n(c.value)} against a median of ${n(med)} (${pct(d)})`);
  }
  const up = deltas.some((d) => d >= POST_READBACK.helped_at);
  const down = deltas.some((d) => d <= POST_READBACK.backfired_at);
  const verdict: PostVerdict = up && !down ? "helped" : down && !up ? "backfired" : "did_nothing";
  const first = deltas[0] as number;
  return {
    verdict,
    delta_pct: Number.isFinite(first) ? Math.round(first * 1000) / 10 : null,
    arithmetic:
      `on day ${args.age_days} after posting: ${parts.join("; ")}, across your previous ` +
      `${audience.baseline.length} ${args.platform_word} post(s) at the same age ` +
      `(thresholds: helped at +${POST_READBACK.helped_at * 100}%, backfired at ${POST_READBACK.backfired_at * 100}%, either figure)`,
  };
}

/** Whole days from the posting day to a snapshot day. */
export function ageInDays(publishedDay: string, day: string): number {
  return Math.round(
    (Date.parse(`${day}T00:00:00Z`) - Date.parse(`${publishedDay}T00:00:00Z`)) / 86_400_000,
  );
}

/** Snapshots per post: platform_post_id → day → figures. */
export type PostSnapshots = Map<string, Map<string, PostFigures>>;

const METRIC_FIGURE: Readonly<Record<string, keyof PostFigures>> = {
  "content.views.daily": "views",
  "content.reach.daily": "reach",
  "content.interactions.daily": "interactions",
};

/** Every measured snapshot of these posts, from the account's Meta publishing connection(s). */
export async function loadPostSnapshots(
  accountId: string,
  platform: "facebook" | "instagram",
  postIds: readonly string[],
): Promise<PostSnapshots> {
  const out: PostSnapshots = new Map();
  if (postIds.length === 0) return out;
  const conns = await db
    .select({ id: connections.id })
    .from(connections)
    .where(
      and(
        eq(connections.account_id, accountId),
        eq(connections.provider, "meta_publish"),
        eq(connections.purpose, "execute"),
      ),
    );
  if (conns.length === 0) return out;
  const keys = postIds.map((id) => canonicalDimensions({ platform, platform_post_id: id }));
  const rows = await db
    .select({
      metric_key: metricObservations.metric_key,
      dimensions: metricObservations.dimensions,
      period_date: metricObservations.period_date,
      value_num: metricObservations.value_num,
    })
    .from(metricObservations)
    .where(
      and(
        inArray(
          metricObservations.connection_id,
          conns.map((c) => c.id),
        ),
        inArray(metricObservations.metric_key, Object.keys(METRIC_FIGURE)),
        inArray(metricObservations.dimension_key, keys),
      ),
    );
  for (const r of rows) {
    const id = r.dimensions?.platform_post_id;
    const figure = METRIC_FIGURE[r.metric_key];
    if (!id || !figure || r.value_num === null) continue;
    const byDay = out.get(id) ?? new Map<string, PostFigures>();
    const f = byDay.get(r.period_date) ?? { views: null, reach: null, interactions: null };
    f[figure] = Number(r.value_num);
    byDay.set(r.period_date, f);
    out.set(id, byDay);
  }
  return out;
}

/**
 * Pure: the comparison age for a post — the latest snapshot within the
 * first week, else (connected late) its earliest — and how many measured
 * days it has. Day 0, the posting day itself, is partial and never counts.
 */
export function comparisonAge(
  publishedDay: string,
  snapshots: ReadonlyMap<string, PostFigures> | undefined,
): { age: number | null; measured_days: number } {
  const ages = [...(snapshots?.keys() ?? [])]
    .map((d) => ageInDays(publishedDay, d))
    .filter((a) => a >= 1)
    .sort((a, b) => a - b);
  if (ages.length === 0) return { age: null, measured_days: 0 };
  const inWeek = ages.filter((a) => a <= POST_READBACK.judge_age_days);
  return {
    age: inWeek.length > 0 ? inWeek[inWeek.length - 1]! : ages[0]!,
    measured_days: ages.length,
  };
}

const WORD: Readonly<Record<"facebook" | "instagram", string>> = {
  facebook: "Facebook",
  instagram: "Instagram",
};

/** Judge one published item on its own figures. */
export async function postOutcome(item: PostItem): Promise<PostOutcome> {
  const base: PostOutcome = {
    item_id: item.id,
    verdict: "unmeasured",
    platform: null,
    audience_metric: null,
    age_days: null,
    figures: null,
    measured_days: 0,
    delta_pct: null,
    arithmetic: "",
  };
  const platform =
    item.platform === "facebook" || item.platform === "instagram" ? item.platform : null;
  if (
    platform === null ||
    item.platform_post_id === null ||
    item.published_at === null ||
    (item.status !== "published" && item.status !== "withdrawn")
  ) {
    return { ...base, arithmetic: "not published — nothing to measure" };
  }
  base.platform = platform;
  const audienceMetric = audienceMetricFor(platform);
  base.audience_metric = audienceMetric;

  const [profile] = await db
    .select({ account_id: businessProfiles.account_id })
    .from(businessProfiles)
    .where(eq(businessProfiles.id, item.profile_id));
  if (!profile) return { ...base, arithmetic: "no business for this item" };

  const earlier = await db
    .select({
      platform_post_id: contentItems.platform_post_id,
      published_at: contentItems.published_at,
    })
    .from(contentItems)
    .where(
      and(
        eq(contentItems.profile_id, item.profile_id),
        eq(contentItems.platform, platform),
        inArray(contentItems.status, ["published", "withdrawn"]),
        isNotNull(contentItems.platform_post_id),
        lt(contentItems.published_at, item.published_at),
      ),
    )
    .orderBy(desc(contentItems.published_at))
    .limit(POST_READBACK.baseline_posts);

  const snapshots = await loadPostSnapshots(profile.account_id, platform, [
    item.platform_post_id,
    ...earlier.flatMap((e) => (e.platform_post_id ? [e.platform_post_id] : [])),
  ]);
  const publishedDay = item.published_at.slice(0, 10);
  const own = snapshots.get(item.platform_post_id);
  const { age, measured_days } = comparisonAge(publishedDay, own);
  base.measured_days = measured_days;
  if (age === null || measured_days < POST_READBACK.min_measured_days) {
    return {
      ...base,
      verdict: "too_early",
      arithmetic: `${measured_days} measured day(s) since ${publishedDay}: the verdict needs ${POST_READBACK.min_measured_days}`,
    };
  }
  base.age_days = age;
  const figures = own?.get(shiftDay(publishedDay, age)) ?? null;
  base.figures = figures;
  const audience = figures?.[audienceMetric] ?? null;
  if (figures === null || audience === null) {
    return {
      ...base,
      arithmetic: `Meta gave no ${audienceMetric} for this post on day ${age} — nothing to compare`,
    };
  }

  const atSameAge = (key: keyof PostFigures): number[] =>
    earlier.flatMap((e) => {
      if (!e.platform_post_id || !e.published_at) return [];
      const day = shiftDay(e.published_at.slice(0, 10), age);
      const v = snapshots.get(e.platform_post_id)?.get(day)?.[key];
      return v === null || v === undefined ? [] : [v];
    });
  const comparisons: Comparison[] = [
    { label: audienceMetric, value: audience, baseline: atSameAge(audienceMetric) },
  ];
  if (figures.interactions !== null) {
    comparisons.push({
      label: "interactions",
      value: figures.interactions,
      baseline: atSameAge("interactions"),
    });
  }
  const judged = judgePost({ platform_word: WORD[platform], age_days: age, comparisons });
  return { ...base, ...judged };
}

/** The outcomes of a profile's published items, for /content. Items never published are left out. */
export async function postOutcomes(profileId: string): Promise<Record<string, PostOutcome>> {
  const items = await db
    .select({
      id: contentItems.id,
      profile_id: contentItems.profile_id,
      status: contentItems.status,
      platform: contentItems.platform,
      platform_post_id: contentItems.platform_post_id,
      published_at: contentItems.published_at,
    })
    .from(contentItems)
    .where(
      and(
        eq(contentItems.profile_id, profileId),
        inArray(contentItems.status, ["published", "withdrawn"]),
      ),
    );
  const out: Record<string, PostOutcome> = {};
  for (const item of items) out[item.id] = await postOutcome(item);
  return out;
}
