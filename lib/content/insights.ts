// Per-post readback — P3-23a (Session D, layer D4).
//
// Every published post's own figures, into metric_observations, pulled by
// the daily connector-sync cron (lib/connectors/sync.ts runs this after the
// measure connections — the same runner, reads only).
//
// THROUGH THE EXECUTE CONNECTION'S READ-ONLY SCOPES. The posts were
// published through the meta_publish execute connection, and only its token
// can read their insights. The reads are the GETs META_READBACK_REQUESTS
// names in lib/execution/providers/meta.ts, each relying on a declared
// readback scope and never a write scope; the source-scan gate there holds
// the request list closed. A MEASURE connection never runs this: the runner
// selects execute meta_publish rows only, and a direct call on any other
// row is skipped by name (`not_execute`, `not_publishing`) — so a read-only
// connection cannot gain these reads by accident, and the measure sync
// still never walks an execute row (P3-20b).
//
// WHAT LANDS. content.views.daily, content.reach.daily and
// content.interactions.daily with dimensions {platform, platform_post_id},
// period_date = the day read (UTC), value = the post's lifetime total as
// Meta reported it then (Meta has no per-day post figures). One row per
// post, metric and day; a re-read the same day replaces it (the upsert's
// natural key). A figure Meta leaves out writes no row — unavailable is not
// zero (rule 5). Every post published in the last POST_INSIGHTS.horizon_days
// is re-read every run, which is what absorbs Meta's 48-hour lag: a late
// count lands in the next day's snapshot.
//
// OUT OF EVERY BUSINESS-WIDE SUM. The rows carry dimensions beyond
// currency, so the existing dimension filter (the v0.0.12 rule: anomaly
// detection, the watch's signals, the derived facts, the trust series)
// skips them. insights.test.ts proves it against all four.
//
// A SIGN-IN META REFUSES pauses the connection (P3-24b, lib/execution/
// pause.ts): the reason on the row, every queued post held for the
// reconnect, one watch-log line. A paused row is not read again until the
// owner reconnects — the runner walks connected rows only.
//
// Structured logs carry the account id; no token is ever logged or stored
// outside the encrypted secret.

import { and, eq, gte, inArray, isNotNull } from "drizzle-orm";
import { db } from "../../db";
import { businessProfiles, connections, connectorSyncs, contentItems } from "../../db/schema";
import { logSafeError } from "../core/log-safe";
import type { Observation } from "../connectors/provider";
import { upsertObservations } from "../connectors/service";
import type { ReadbackRunSummary } from "../connectors/sync";
import { withAdvisoryLock } from "../connectors/sync";
import { decryptSecret } from "../connectors/secrets";
import type {
  MetaReadback,
  PostFigures,
  PostInsightsTarget,
  PublishPlatform,
} from "../execution/providers/meta";
import { MetaRequestError, parseMetaExecutionCredential } from "../execution/providers/meta";
import { pausesConnection } from "../execution/meta-errors";
import { pauseExecutionConnection } from "../execution/pause";

export const POST_INSIGHTS = {
  /** Posts published within this many days are re-read on every run. */
  horizon_days: 28,
  /** A hard cap on posts read per connection per run (each is one Graph call). */
  max_posts_per_run: 100,
} as const;

export const POST_METRICS = [
  "content.views.daily",
  "content.reach.daily",
  "content.interactions.daily",
] as const;

export type PostReadbackSkip =
  "locked" | "not_found" | "not_execute" | "not_publishing" | "not_connected";

export interface PostReadbackOutcome {
  connection_id: string;
  account_id: string | null;
  ok: boolean;
  skipped: PostReadbackSkip | null;
  posts: number;
  observations: number;
  /** Posts Meta gave nothing for, with the reason — a gap per post, never a failed run. */
  unreadable: { platform_post_id: string; reason: string }[];
  error: string | null;
  /** P3-24b: Meta refused the sign-in, and the connection paused itself. */
  paused: boolean;
  duration_ms: number;
}

const FIGURE_METRIC: Readonly<Record<keyof PostFigures, (typeof POST_METRICS)[number]>> = {
  views: "content.views.daily",
  reach: "content.reach.daily",
  interactions: "content.interactions.daily",
};

/** Pure: one post's figures as observations for the day read. Null figures write nothing. */
export function postObservations(
  post: { platform: PublishPlatform; platform_post_id: string },
  figures: PostFigures,
  day: string,
  observedAt: string,
): Observation[] {
  const out: Observation[] = [];
  for (const key of Object.keys(FIGURE_METRIC) as (keyof PostFigures)[]) {
    const value = figures[key];
    if (value === null) continue;
    out.push({
      metric_key: FIGURE_METRIC[key],
      period_date: day,
      dimensions: { platform: post.platform, platform_post_id: post.platform_post_id },
      value_num: value,
      observed_at: observedAt,
    });
  }
  return out;
}

async function defaultReadback(): Promise<MetaReadback> {
  const { metaReadback } = await import("../execution/providers/meta");
  return metaReadback;
}

function errorText(error: unknown): string {
  const facts = logSafeError(error);
  return `${facts.error_name}: ${facts.error_message}`;
}

/** The posts to read for one account: published, on a Meta platform, within the horizon. */
async function postsToRead(accountId: string, now: Date) {
  const since = new Date(now.getTime() - POST_INSIGHTS.horizon_days * 86_400_000).toISOString();
  return db
    .select({
      id: contentItems.id,
      kind: contentItems.kind,
      platform: contentItems.platform,
      platform_post_id: contentItems.platform_post_id,
    })
    .from(contentItems)
    .innerJoin(businessProfiles, eq(businessProfiles.id, contentItems.profile_id))
    .where(
      and(
        eq(businessProfiles.account_id, accountId),
        eq(contentItems.status, "published"),
        inArray(contentItems.platform, ["facebook", "instagram"]),
        isNotNull(contentItems.platform_post_id),
        gte(contentItems.published_at, since),
      ),
    )
    .orderBy(contentItems.published_at)
    .limit(POST_INSIGHTS.max_posts_per_run);
}

/** Read one execute connection's posts. Never throws for a provider failure — it is recorded. */
export async function syncPostInsights(
  connectionId: string,
  now = new Date(),
  opts: { readback?: MetaReadback } = {},
): Promise<PostReadbackOutcome> {
  const started = Date.now();
  const outcome: PostReadbackOutcome = {
    connection_id: connectionId,
    account_id: null,
    ok: false,
    skipped: null,
    posts: 0,
    observations: 0,
    unreadable: [],
    error: null,
    paused: false,
    duration_ms: 0,
  };

  return withAdvisoryLock(
    `post_readback:${connectionId}`,
    async () => {
      const [row] = await db.select().from(connections).where(eq(connections.id, connectionId));
      if (!row) {
        outcome.skipped = "not_found";
        return outcome;
      }
      outcome.account_id = row.account_id;
      // A measure connection never gains these reads: they belong to the
      // publishing consent's declared readback scopes, and to nothing else.
      if (row.purpose !== "execute") {
        outcome.skipped = "not_execute";
        return outcome;
      }
      if (row.provider !== "meta_publish") {
        outcome.skipped = "not_publishing";
        return outcome;
      }
      if (row.status !== "connected") {
        outcome.skipped = "not_connected";
        return outcome;
      }

      try {
        if (row.encrypted_secret === null) {
          throw new Error("no credential at rest: reconnect Meta publishing");
        }
        const cred = parseMetaExecutionCredential(
          decryptSecret(row.encrypted_secret),
          "meta_publish",
        );
        const items = await postsToRead(row.account_id, now);
        const targets: PostInsightsTarget[] = items.flatMap((i) =>
          (i.platform === "facebook" || i.platform === "instagram") && i.platform_post_id
            ? [
                {
                  platform: i.platform,
                  platform_post_id: i.platform_post_id,
                  // publish_page_video is the Reels path only (P3-21b).
                  reel: i.platform === "facebook" && i.kind === "video",
                },
              ]
            : [],
        );
        outcome.posts = targets.length;
        if (targets.length > 0) {
          const readback = opts.readback ?? (await defaultReadback());
          const results = await readback.read(cred, targets, row.account_id);
          const day = now.toISOString().slice(0, 10);
          const observations: Observation[] = [];
          for (const r of results) {
            if ("unreadable" in r.insights) {
              outcome.unreadable.push({
                platform_post_id: r.post.platform_post_id,
                reason: r.insights.unreadable,
              });
              continue;
            }
            observations.push(
              ...postObservations(r.post, r.insights.figures, day, now.toISOString()),
            );
          }
          outcome.observations = await upsertObservations(row.id, row.provider, observations);
        }
        outcome.ok = true;
      } catch (error) {
        outcome.error = errorText(error);
        // P3-24b: a sign-in Meta refuses pauses the execute connection, the
        // same as a refused publish would — with the reason on the row, the
        // queued posts held for the reconnect, and one watch-log line. Any
        // other failure leaves the connection as it is; the run says what.
        if (error instanceof MetaRequestError && pausesConnection(error.failure)) {
          await pauseExecutionConnection({
            accountId: row.account_id,
            provider: "meta_publish",
            failure: error.failure,
            source: "readback",
          });
          outcome.paused = true;
        }
      }

      outcome.duration_ms = Date.now() - started;
      await recordReadback(outcome);
      return outcome;
    },
    () => {
      outcome.skipped = "locked";
      outcome.duration_ms = Date.now() - started;
      return outcome;
    },
  );
}

async function recordReadback(outcome: PostReadbackOutcome): Promise<void> {
  console.log(
    JSON.stringify({
      event: "post_readback",
      account_id: outcome.account_id,
      connection_id: outcome.connection_id,
      ok: outcome.ok,
      posts: outcome.posts,
      observations: outcome.observations,
      unreadable: outcome.unreadable.length,
      paused: outcome.paused,
      duration_ms: outcome.duration_ms,
      error: outcome.error,
    }),
  );
  if (outcome.account_id === null) return;
  try {
    await db.insert(connectorSyncs).values({
      connection_id: outcome.connection_id,
      account_id: outcome.account_id,
      kind: "readback",
      duration_ms: outcome.duration_ms,
      pages: outcome.posts,
      observations_upserted: outcome.observations,
      ok: outcome.ok,
      error: outcome.error,
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "post_readback_persist_failed",
        account_id: outcome.account_id,
        message: errorText(error),
      }),
    );
  }
}

/** Every connected meta_publish execute connection, one after another. */
export async function runPostReadback(
  now = new Date(),
  opts: { readback?: MetaReadback; accountIds?: readonly string[] } = {},
): Promise<ReadbackRunSummary> {
  const rows = await db
    .select({ id: connections.id })
    .from(connections)
    .where(
      and(
        eq(connections.purpose, "execute"),
        eq(connections.provider, "meta_publish"),
        eq(connections.status, "connected"),
        opts.accountIds ? inArray(connections.account_id, [...opts.accountIds]) : undefined,
      ),
    )
    .orderBy(connections.created_at);
  const summary: ReadbackRunSummary = {
    connections: rows.length,
    ok: 0,
    failed: 0,
    skipped: 0,
    observations: 0,
  };
  for (const { id } of rows) {
    const outcome = await syncPostInsights(id, now, opts);
    if (outcome.skipped) summary.skipped += 1;
    else if (outcome.ok) summary.ok += 1;
    else summary.failed += 1;
    summary.observations += outcome.observations;
  }
  return summary;
}
