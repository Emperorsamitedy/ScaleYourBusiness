// TikTok posting's database side — the owner override of 2026-11-08.
//
// lib/execution/providers/tiktok.ts sends; this file remembers, as
// ./publishing.ts does for Meta. The same states and the same at-most-once
// rules (P3-21d): claimed `publishing` before anything is sent, read back
// and never re-sent, `failed` only when nothing went out.
//
// Also here: what /content shows and lets the owner choose for a TikTok
// post before approving it (TikTok's own posting rules — the account's
// nickname, privacy picked by hand from TikTok's live options with no
// default, comments/duets/stitches off unless turned on), and the readback
// of public posts' counts into metric_observations.
//
// Never here: a delete. TikTok's API has none (see the provider).

import { and, eq, gte, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { db } from "../../db";
import {
  businessProfiles,
  connectorSyncs,
  connections,
  contentItems,
  proposals,
  watchActivity,
} from "../../db/schema";
import { logSafeError } from "../core/log-safe";
import type { Observation } from "../connectors/provider";
import { encryptSecret } from "../connectors/secrets";
import { upsertObservations } from "../connectors/service";
import type { ReadbackRunSummary } from "../connectors/sync";
import { tiktokAuditStatus } from "../env";
import { activeExecutionConnection, executionSecret } from "../execution/connections";
import type {
  TikTokCalls,
  TikTokCredential,
  TikTokPostSettings,
  TikTokPrivacy,
  TikTokPublishAttempt,
  TikTokPublishBackend,
  TikTokPublishItem,
} from "../execution/providers/tiktok";
import {
  TIKTOK_PROVIDER,
  TikTokRequestError,
  isTikTokPrivacy,
  offeredPrivacy,
  parseTikTokCredential,
  parseTikTokSettings,
  tiktokPostUrl,
} from "../execution/providers/tiktok";
import type { MediaStore } from "./media";
import { vercelBlobStore } from "./media";
import { mediaOf } from "./media-item";
import { ContentError } from "./plan";
import { releaseMedia } from "./publishing";

type ItemRow = typeof contentItems.$inferSelect;

function toItem(row: ItemRow): TikTokPublishItem {
  return {
    id: row.id,
    profile_id: row.profile_id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    disclosure: row.disclosure,
    media_path: row.media_path,
    status: row.status,
    platform: row.platform,
    platform_post_id: row.platform_post_id,
    platform_url: row.platform_url,
    publish_proposal_id: row.publish_proposal_id,
    publish_attempt: (row.publish_attempt as TikTokPublishAttempt | null) ?? null,
    publish_approved_sha256: row.publish_approved_sha256,
    link: null,
    tiktok_settings: parseTikTokSettings(row.tiktok_settings),
    is_ai_generated: mediaOf(row.provenance)?.is_ai_generated === true,
  };
}

const json = (value: unknown) => sql`${JSON.stringify(value)}::jsonb`;

/** The live tiktok_publish connection's row and credential, or why there is none. */
async function liveRow(
  accountId: string,
): Promise<{ id: string; credential: TikTokCredential } | { refused: string }> {
  const row = await activeExecutionConnection(accountId, TIKTOK_PROVIDER);
  if (!row) {
    return {
      refused: "TikTok posting isn't connected. Connect it on Connections; nothing was sent.",
    };
  }
  if (row.status !== "connected") {
    return {
      refused: `The TikTok connection is ${row.status}. Reconnect it on Connections; nothing was sent.`,
    };
  }
  return { id: row.id, credential: parseTikTokCredential(executionSecret(row)) };
}

/** Store a refreshed credential: TikTok rotated the refresh token, so the old one is dead. */
export async function storeTikTokCredential(
  accountId: string,
  connectionId: string,
  cred: TikTokCredential,
): Promise<void> {
  await db
    .update(connections)
    .set({ encrypted_secret: encryptSecret(JSON.stringify(cred)) })
    .where(
      and(
        eq(connections.id, connectionId),
        eq(connections.account_id, accountId),
        eq(connections.purpose, "execute"),
        eq(connections.provider, TIKTOK_PROVIDER),
        ne(connections.status, "disconnected"),
      ),
    );
}

/** The sign-in stopped working: the connection pauses itself, one watch-log line, until a reconnect. */
export async function pauseTikTok(accountId: string, sentence: string): Promise<void> {
  const flipped = await db
    .update(connections)
    .set({
      status: "paused",
      last_error: sentence,
      failure_count: sql`${connections.failure_count} + 1`,
    })
    .where(
      and(
        eq(connections.account_id, accountId),
        eq(connections.provider, TIKTOK_PROVIDER),
        eq(connections.purpose, "execute"),
        eq(connections.status, "connected"),
      ),
    )
    .returning({ id: connections.id });
  if (flipped.length === 0) return;
  const profiles = await db
    .select({ id: businessProfiles.id })
    .from(businessProfiles)
    .where(eq(businessProfiles.account_id, accountId));
  if (profiles.length > 0) {
    await db.insert(watchActivity).values(
      profiles.map((p) => ({
        profile_id: p.id,
        kind: "connection_paused",
        detail: `TikTok posting paused itself. ${sentence}`,
        meta: { connection_id: flipped[0]?.id ?? null, provider: TIKTOK_PROVIDER },
      })),
    );
  }
  console.log(
    JSON.stringify({
      event: "execution_connection_paused",
      account_id: accountId,
      provider: TIKTOK_PROVIDER,
    }),
  );
}

async function accountOfProfile(profileId: string): Promise<string | null> {
  const [row] = await db
    .select({ account_id: businessProfiles.account_id })
    .from(businessProfiles)
    .where(eq(businessProfiles.id, profileId));
  return row?.account_id ?? null;
}

/** The database behind the TikTok executor. `store` is the media store (Blob by default). */
export function dbTikTokPublishBackend(opts: { store?: MediaStore } = {}): TikTokPublishBackend {
  const store = () => opts.store ?? vercelBlobStore();
  return {
    async item(itemId, profileId) {
      const [row] = await db
        .select()
        .from(contentItems)
        .where(and(eq(contentItems.id, itemId), eq(contentItems.profile_id, profileId)));
      return row ? toItem(row) : null;
    },

    async credential(accountId) {
      const live = await liveRow(accountId);
      return "refused" in live ? live : { connection_id: live.id, credential: live.credential };
    },

    storeCredential: storeTikTokCredential,

    async readMedia(url, maxBytes) {
      const s = store();
      if (!s.get) throw new ContentError("this media store can't read files back", 500);
      return s.get(url, maxBytes);
    },

    async claim(itemId, executionId, attempt) {
      const rows = await db
        .update(contentItems)
        .set({
          status: "publishing",
          platform: "tiktok",
          publish_execution_id: executionId,
          publish_attempt: json(attempt),
          last_error: null,
        })
        .where(
          and(eq(contentItems.id, itemId), inArray(contentItems.status, ["drafted", "queued"])),
        )
        .returning({ id: contentItems.id });
      return rows.length === 1;
    },

    async note(itemId, attempt) {
      await db
        .update(contentItems)
        .set({ publish_attempt: json(attempt) })
        .where(eq(contentItems.id, itemId));
    },

    async published(item, post, accountId) {
      const [row] = await db
        .update(contentItems)
        .set({
          status: "published",
          platform: "tiktok",
          platform_post_id: post.platform_post_id,
          platform_url: post.url,
          published_at: new Date().toISOString(),
          last_error: null,
        })
        .where(and(eq(contentItems.id, item.id), eq(contentItems.status, "publishing")))
        .returning({ id: contentItems.id });
      if (!row) return; // already recorded — a second record is not a second post
      await db.insert(watchActivity).values({
        profile_id: item.profile_id,
        kind: "content_published",
        detail: `Published '${item.title}' to TikTok.`,
        meta: {
          item_id: item.id,
          platform: "tiktok",
          platform_post_id: post.platform_post_id,
          publish_id: post.publish_id,
        },
      });
      // TikTok holds the bytes now (FILE_UPLOAD): the render leaves public storage.
      await releaseMedia(item, store(), accountId);
    },

    async failed(itemId, sentence) {
      const [row] = await db
        .update(contentItems)
        .set({ status: "failed", last_error: sentence })
        .where(eq(contentItems.id, itemId))
        .returning();
      if (row) await releaseMedia(toItem(row), store(), await accountOfProfile(row.profile_id));
    },

    async uncertain(itemId, sentence) {
      await db
        .update(contentItems)
        .set({ last_error: sentence })
        .where(and(eq(contentItems.id, itemId), eq(contentItems.status, "publishing")));
    },

    async deferred(itemId, sentence) {
      await db
        .update(contentItems)
        .set({ last_error: sentence })
        .where(eq(contentItems.id, itemId));
    },

    paused: pauseTikTok,

    async unclaim(itemId, sentence) {
      await db
        .update(contentItems)
        .set({ status: "queued", last_error: sentence })
        .where(
          and(
            eq(contentItems.id, itemId),
            eq(contentItems.status, "publishing"),
            sql`${contentItems.publish_attempt}->>'sent_at' IS NULL`,
          ),
        );
    },

    async lapsed(itemId, sentence, accountId) {
      const [row] = await db
        .update(contentItems)
        .set({ status: "failed", last_error: sentence })
        .where(
          and(eq(contentItems.id, itemId), inArray(contentItems.status, ["drafted", "queued"])),
        )
        .returning();
      if (row) await releaseMedia(toItem(row), store(), accountId);
    },
  };
}

/* ── what /content shows and lets the owner choose ─────────────────── */

async function defaultCalls(): Promise<TikTokCalls> {
  const { tiktokExecution } = await import("../execution/providers/tiktok");
  return tiktokExecution.calls;
}

/** The TikTok account as TikTok describes it now, for the settings form. */
export interface TikTokCreatorView {
  nickname: string | null;
  username: string | null;
  /** What SYB offers: TikTok's own options, and only "only me" while SYB's app is unaudited. */
  privacy_options: TikTokPrivacy[];
  /** Everything TikTok offers this account, audited or not. */
  tiktok_options: TikTokPrivacy[];
  audited: boolean;
  comment_disabled: boolean;
  duet_disabled: boolean;
  stitch_disabled: boolean;
  max_video_post_duration_sec: number | null;
}

/** Read creator_info live (TikTok's rule: the latest, when the post form renders). */
export async function tiktokCreatorView(
  accountId: string,
  opts: { calls?: TikTokCalls; now?: Date } = {},
): Promise<TikTokCreatorView> {
  const live = await liveRow(accountId);
  if ("refused" in live) throw new ContentError(live.refused, 409);
  const calls = opts.calls ?? (await defaultCalls());
  try {
    const { cred, changed } = await calls.fresh(live.credential, opts.now ?? new Date());
    if (changed) await storeTikTokCredential(accountId, live.id, cred);
    const creator = await calls.creatorInfo(cred.access_token, accountId);
    const audit = tiktokAuditStatus();
    return {
      nickname: creator.nickname ?? cred.nickname,
      username: creator.username ?? cred.username,
      privacy_options: offeredPrivacy(creator, audit),
      tiktok_options: creator.privacy_level_options,
      audited: audit === "audited",
      comment_disabled: creator.comment_disabled,
      duet_disabled: creator.duet_disabled,
      stitch_disabled: creator.stitch_disabled,
      max_video_post_duration_sec: creator.max_video_post_duration_sec,
    };
  } catch (error) {
    if (error instanceof TikTokRequestError) {
      if (error.failure.pauses) await pauseTikTok(accountId, error.failure.owner_sentence);
      throw new ContentError(error.failure.owner_sentence, error.failure.pauses ? 409 : 502);
    }
    throw error;
  }
}

function tiktokDetail(action: unknown): { item_id: string } | null {
  const a = (action ?? {}) as {
    kind?: unknown;
    detail?: { item_id?: unknown; platform?: unknown };
  };
  return a.kind === "content_publishing" &&
    a.detail?.platform === "tiktok" &&
    typeof a.detail.item_id === "string"
    ? { item_id: a.detail.item_id }
    : null;
}

export interface TikTokItemState {
  proposal_id: string;
  proposal_status: string;
  settings: TikTokPostSettings | null;
  /** The owner may still choose: a draft whose proposal waits for its decision. */
  can_choose: boolean;
}

/** Per item headed for TikTok: its proposal, the settings chosen, and whether they may change. */
export async function tiktokItemStates(
  profileId: string,
  items: readonly {
    id: string;
    status: string;
    publish_proposal_id: string | null;
    tiktok_settings?: unknown;
  }[],
): Promise<Record<string, TikTokItemState>> {
  const ids = items.map((i) => i.publish_proposal_id).filter((x): x is string => x !== null);
  if (ids.length === 0) return {};
  const rows = await db
    .select({ id: proposals.id, status: proposals.status, action: proposals.action })
    .from(proposals)
    .where(and(eq(proposals.profile_id, profileId), inArray(proposals.id, ids)));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: Record<string, TikTokItemState> = {};
  for (const item of items) {
    const p = item.publish_proposal_id ? byId.get(item.publish_proposal_id) : undefined;
    if (!p || tiktokDetail(p.action)?.item_id !== item.id) continue;
    const [row] =
      item.tiktok_settings !== undefined
        ? [{ tiktok_settings: item.tiktok_settings }]
        : await db
            .select({ tiktok_settings: contentItems.tiktok_settings })
            .from(contentItems)
            .where(eq(contentItems.id, item.id));
    out[item.id] = {
      proposal_id: p.id,
      proposal_status: p.status,
      settings: parseTikTokSettings(row?.tiktok_settings),
      can_choose: item.status === "drafted" && p.status === "pending",
    };
  }
  return out;
}

/**
 * Save the owner's choice for one TikTok post. Only a draft whose TikTok
 * proposal waits for its decision; the privacy must be one SYB offers now
 * (TikTok's live options, "only me" alone while unaudited). Approving the
 * proposal then hashes these settings with the caption and the video.
 */
export async function saveTikTokSettings(args: {
  profileId: string;
  accountId: string;
  itemId: string;
  input: unknown;
  calls?: TikTokCalls;
}): Promise<TikTokPostSettings> {
  const raw = (args.input ?? {}) as Record<string, unknown>;
  if (!isTikTokPrivacy(raw["privacy_level"])) {
    throw new ContentError("choose who can see it on TikTok", 422);
  }
  const [item] = await db
    .select()
    .from(contentItems)
    .where(and(eq(contentItems.id, args.itemId), eq(contentItems.profile_id, args.profileId)));
  if (!item) throw new ContentError("no such content item", 404);
  const state = (await tiktokItemStates(args.profileId, [item]))[item.id];
  if (!state) throw new ContentError("this item isn't headed for TikTok", 409);
  if (!state.can_choose) {
    throw new ContentError(
      "its TikTok settings were approved with it and can't change now — decline it and ask again to change them",
      409,
    );
  }
  const view = await tiktokCreatorView(args.accountId, args.calls ? { calls: args.calls } : {});
  if (!view.privacy_options.includes(raw["privacy_level"])) {
    throw new ContentError(
      view.audited
        ? "TikTok doesn't offer that privacy for this account"
        : "Until TikTok audits SYB's app, posts can only be private (only you can see them)",
      422,
    );
  }
  const flag = (k: string, disabled: boolean) => raw[k] === true && !disabled;
  const settings: TikTokPostSettings = {
    privacy_level: raw["privacy_level"],
    allow_comment: flag("allow_comment", view.comment_disabled),
    allow_duet: flag("allow_duet", view.duet_disabled),
    allow_stitch: flag("allow_stitch", view.stitch_disabled),
    brand_organic: raw["brand_organic"] === true,
  };
  const updated = await db
    .update(contentItems)
    .set({ tiktok_settings: json(settings) })
    .where(and(eq(contentItems.id, item.id), eq(contentItems.status, "drafted")))
    .returning({ id: contentItems.id });
  if (updated.length !== 1) throw new ContentError("the item changed — reload and try again", 409);
  return settings;
}

/* ── readback: public posts' counts ────────────────────────────────── */

export const TIKTOK_INSIGHTS = { horizon_days: 28, max_posts_per_run: 100 } as const;

/** Pure: one public post's counts as observations for the day read. Nothing reported, nothing written. */
export function tiktokObservations(
  postId: string,
  counts: {
    view_count: number | null;
    like_count: number | null;
    comment_count: number | null;
    share_count: number | null;
  },
  day: string,
  observedAt: string,
): Observation[] {
  const out: Observation[] = [];
  const dims = { platform: "tiktok", platform_post_id: postId };
  if (counts.view_count !== null) {
    out.push({
      metric_key: "content.views.daily",
      period_date: day,
      dimensions: dims,
      value_num: counts.view_count,
      observed_at: observedAt,
    });
  }
  const parts = [counts.like_count, counts.comment_count, counts.share_count];
  if (parts.some((p) => p !== null)) {
    out.push({
      metric_key: "content.interactions.daily",
      period_date: day,
      dimensions: dims,
      value_num: parts.reduce<number>((sum, p) => sum + (p ?? 0), 0),
      observed_at: observedAt,
    });
  }
  return out;
}

/**
 * Every connected tiktok_publish connection: published TikTok posts in the
 * horizon. A post TikTok hasn't given a public id for yet (a private post,
 * or one still in moderation) is asked about by its publish_id; once a
 * public id appears it replaces the publish_id on the item. Public posts'
 * counts land as content.views.daily / content.interactions.daily (likes +
 * comments + shares) through video.list. Private (SELF_ONLY) posts have no
 * counts TikTok will give an app: they write nothing (rule 5).
 */
export async function runTikTokPostReadback(
  now = new Date(),
  opts: { calls?: TikTokCalls; accountIds?: readonly string[] } = {},
): Promise<ReadbackRunSummary> {
  const rows = await db
    .select()
    .from(connections)
    .where(
      and(
        eq(connections.purpose, "execute"),
        eq(connections.provider, TIKTOK_PROVIDER),
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
  if (rows.length === 0) return summary;
  const calls = opts.calls ?? (await defaultCalls());
  const since = new Date(now.getTime() - TIKTOK_INSIGHTS.horizon_days * 86_400_000).toISOString();
  for (const row of rows) {
    const started = Date.now();
    let ok = false;
    let observations = 0;
    let posts = 0;
    let error: string | null = null;
    try {
      const { cred, changed } = await calls.fresh(parseTikTokCredential(executionSecret(row)), now);
      if (changed) await storeTikTokCredential(row.account_id, row.id, cred);
      const items = await db
        .select({
          id: contentItems.id,
          platform_post_id: contentItems.platform_post_id,
          publish_attempt: contentItems.publish_attempt,
        })
        .from(contentItems)
        .innerJoin(businessProfiles, eq(businessProfiles.id, contentItems.profile_id))
        .where(
          and(
            eq(businessProfiles.account_id, row.account_id),
            eq(contentItems.status, "published"),
            eq(contentItems.platform, "tiktok"),
            isNotNull(contentItems.platform_post_id),
            gte(contentItems.published_at, since),
          ),
        )
        .limit(TIKTOK_INSIGHTS.max_posts_per_run);
      const publicIds: string[] = [];
      for (const it of items) {
        const publishId = (it.publish_attempt as TikTokPublishAttempt | null)?.publish_id;
        if (publishId && it.platform_post_id === publishId) {
          // Not public yet when it went out: has TikTok given it a public id since?
          const read = await calls
            .status(cred.access_token, publishId, row.account_id)
            .catch(() => null);
          if (read?.kind === "complete" && read.post_id) {
            await db
              .update(contentItems)
              .set({
                platform_post_id: read.post_id,
                platform_url: tiktokPostUrl(cred.username, read.post_id),
              })
              .where(eq(contentItems.id, it.id));
            publicIds.push(read.post_id);
          }
        } else if (it.platform_post_id) {
          publicIds.push(it.platform_post_id);
        }
      }
      posts = publicIds.length;
      const counts = await calls.queryVideos(cred.access_token, publicIds, row.account_id);
      const day = now.toISOString().slice(0, 10);
      const obs = counts.flatMap((c) => tiktokObservations(c.id, c, day, now.toISOString()));
      observations = await upsertObservations(row.id, TIKTOK_PROVIDER, obs);
      ok = true;
    } catch (e) {
      const facts = logSafeError(e);
      error = `${facts.error_name}: ${facts.error_message}`;
      if (e instanceof TikTokRequestError && e.failure.pauses) {
        await pauseTikTok(row.account_id, e.failure.owner_sentence);
      }
    }
    if (ok) summary.ok += 1;
    else summary.failed += 1;
    summary.observations += observations;
    const duration_ms = Date.now() - started;
    console.log(
      JSON.stringify({
        event: "post_readback",
        provider: TIKTOK_PROVIDER,
        account_id: row.account_id,
        connection_id: row.id,
        ok,
        posts,
        observations,
        duration_ms,
        error,
      }),
    );
    try {
      await db.insert(connectorSyncs).values({
        connection_id: row.id,
        account_id: row.account_id,
        kind: "readback",
        duration_ms,
        pages: posts,
        observations_upserted: observations,
        ok,
        error,
      });
    } catch (persist) {
      console.error(
        JSON.stringify({
          event: "post_readback_persist_failed",
          account_id: row.account_id,
          ...logSafeError(persist),
        }),
      );
    }
  }
  return summary;
}
