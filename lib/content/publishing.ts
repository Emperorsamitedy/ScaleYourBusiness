// The publish path's database side — P3-21b/c/d/e (Session D, layer D2).
//
// lib/execution/providers/meta.ts sends; this file remembers. The Meta
// executor holds no database import of its own (the provider map stays
// importable without one) and reaches the item through PublishBackend,
// implemented here:
//
//   claim      drafted|queued → publishing, conditionally, BEFORE anything
//              is sent — with the run's execution id and what it will send
//   note       sent_at and the platform's interim ids as they happen
//   published  the platform's id and link, published_at, one watch-log
//              line ("Published 'Autumn menu' to Instagram."), and the
//              render released from public storage now the platform has it
//   failed     nothing went out; the sentence says why
//   uncertain  stays `publishing`: "I may have posted this — check the Page"
//   withdrawn  the undo: status withdrawn, the platform id kept forever
//   paused     P3-24b: Meta refused the sign-in — the connection pauses
//              itself and holds every queued item (lib/execution/pause.ts)
//   unclaim    P3-24c: the stop came on between steps, before sent_at —
//              publishing → queued, nothing having gone out
//
// Also here: the due runner's route for a publish proposal (publishPlan),
// the sweep that reconciles a run that died mid-publish by reading back
// (reconcilePublishing — never by posting again), and Withdraw for
// /content, which goes through the engine's undoExecution like any undo.

import { markLabellingPublished } from "../growth/library";
import { and, eq, inArray, lt, or, sql } from "drizzle-orm";
import { db } from "../../db";
import {
  businessProfiles,
  contentItems,
  executions,
  proposals,
  watchActivity,
} from "../../db/schema";
import { logSafeError } from "../core/log-safe";
import { activeExecutionConnection, executionSecret } from "../execution/connections";
import { pauseExecutionConnection } from "../execution/pause";
import type { DispatchPlan } from "../execution/due";
import { isHalted, undoExecution } from "../execution/engine";
import type { ExecutionRow } from "../execution/engine";
import type {
  MetaPublishProvider,
  PublishAttempt,
  PublishBackend,
  PublishItem,
  PublishPlatform,
  ReconcileOutcome,
} from "../execution/providers/meta";
import { parseMetaExecutionCredential, publishOpFor } from "../execution/providers/meta";
import { ProposalError, recordExecution } from "../proposals/service";
import type { ProposalRow } from "../proposals/service";
import type { MediaStore } from "./media";
import { vercelBlobStore } from "./media";
import { supersededByFootage } from "./media-item";
import { ContentError } from "./plan";
import { isPublishProposal } from "./publish";

const LABEL: Readonly<Record<PublishPlatform, string>> = {
  facebook: "Facebook",
  instagram: "Instagram",
};

type ItemRow = typeof contentItems.$inferSelect;

function toPublishItem(row: ItemRow): PublishItem {
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
    publish_attempt: (row.publish_attempt as PublishAttempt | null) ?? null,
    publish_approved_sha256: row.publish_approved_sha256,
    link: linkOf(row.provenance),
  };
}

/** The link a post carries, when its provenance names one — https only, never guessed from the text. */
function linkOf(provenance: unknown): string | null {
  const link = (provenance as { link?: unknown } | null)?.link;
  if (typeof link !== "string") return null;
  try {
    return new URL(link).protocol === "https:" ? link : null;
  } catch {
    return null;
  }
}

const json = (value: unknown) => sql`${JSON.stringify(value)}::jsonb`;

async function accountOfProfile(profileId: string): Promise<string | null> {
  const [row] = await db
    .select({ account_id: businessProfiles.account_id })
    .from(businessProfiles)
    .where(eq(businessProfiles.id, profileId));
  return row?.account_id ?? null;
}

/** The render leaves public storage once the platform holds it (or it will never go out). */
export async function releaseMedia(
  item: Pick<PublishItem, "id" | "media_path">,
  store: MediaStore,
  accountId: string | null,
) {
  if (!item.media_path) return;
  try {
    await store.del(item.media_path);
    await db.update(contentItems).set({ media_path: null }).where(eq(contentItems.id, item.id));
    console.log(
      JSON.stringify({
        event: "content_media_released",
        account_id: accountId,
        item_id: item.id,
        store: store.kind,
      }),
    );
  } catch (error) {
    // The post stands; a render left in storage is tidied later, never a failed publish.
    console.error(
      JSON.stringify({
        event: "content_media_release_failed",
        account_id: accountId,
        item_id: item.id,
        ...logSafeError(error),
      }),
    );
  }
}

/** The database behind the Meta publish executor. `store` is the media store (Blob by default). */
export function dbPublishBackend(opts: { store?: MediaStore } = {}): PublishBackend {
  const store = () => opts.store ?? vercelBlobStore();
  return {
    async item(itemId, profileId) {
      const [row] = await db
        .select()
        .from(contentItems)
        .where(and(eq(contentItems.id, itemId), eq(contentItems.profile_id, profileId)));
      return row ? toPublishItem(row) : null;
    },

    async credential(accountId) {
      const row = await activeExecutionConnection(accountId, "meta_publish");
      if (!row) {
        return {
          refused: "Meta publishing isn't connected. Connect it on Connections; nothing was sent.",
        };
      }
      if (row.status !== "connected") {
        return {
          refused: `The Meta publishing connection is ${row.status}. Reconnect it on Connections; nothing was sent.`,
        };
      }
      return parseMetaExecutionCredential(executionSecret(row), "meta_publish");
    },

    async claim(itemId, executionId, platform, attempt) {
      const rows = await db
        .update(contentItems)
        .set({
          status: "publishing",
          platform,
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
          platform: post.platform,
          platform_post_id: post.platform_post_id,
          platform_url: post.url,
          published_at: new Date().toISOString(),
          last_error: null,
        })
        .where(and(eq(contentItems.id, item.id), eq(contentItems.status, "publishing")))
        .returning({ id: contentItems.id });
      if (!row) return; // already recorded — a second record is not a second post
      // §9.3: the labelling record says when it went out (the approval names who said yes).
      await markLabellingPublished(item.id, item.media_path ?? null, null);
      await db.insert(watchActivity).values({
        profile_id: item.profile_id,
        kind: "content_published",
        detail: `Published '${item.title}' to ${LABEL[post.platform]}.`,
        meta: {
          item_id: item.id,
          platform: post.platform,
          platform_post_id: post.platform_post_id,
        },
      });
      await releaseMedia(item, store(), accountId);
    },

    async failed(itemId, sentence, opts = {}) {
      const [row] = await db
        .update(contentItems)
        .set({ status: "failed", last_error: sentence })
        .where(eq(contentItems.id, itemId))
        .returning();
      // Review D #10: a render that will never go out leaves public storage.
      if (row && !opts.keepMedia) {
        await releaseMedia(toPublishItem(row), store(), await accountOfProfile(row.profile_id));
      }
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

    async withdrawn(item, platform, accountId) {
      const [row] = await db
        .update(contentItems)
        .set({ status: "withdrawn", last_error: null })
        .where(and(eq(contentItems.id, item.id), eq(contentItems.status, "published")))
        .returning({ id: contentItems.id });
      if (!row) return;
      await db.insert(watchActivity).values({
        profile_id: item.profile_id,
        kind: "content_withdrawn",
        detail: `Withdrew '${item.title}' from ${LABEL[platform]}.`,
        meta: { item_id: item.id, platform, platform_post_id: item.platform_post_id },
      });
      await releaseMedia(item, store(), accountId);
    },

    async paused({ account_id, failure, item_id }) {
      await pauseExecutionConnection({
        accountId: account_id,
        provider: "meta_publish",
        failure,
        itemId: item_id ?? null,
        source: "publish",
      });
    },

    async lapsed(itemId, sentence, accountId) {
      const [row] = await db
        .update(contentItems)
        .set({ status: "failed", last_error: sentence })
        .where(
          and(eq(contentItems.id, itemId), inArray(contentItems.status, ["drafted", "queued"])),
        )
        .returning();
      if (row) await releaseMedia(toPublishItem(row), store(), accountId);
    },

    async unclaim(itemId, sentence) {
      // Only while nothing was sent: sent_at goes down just before the call
      // that makes a post public, so its absence proves nothing went out.
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
  };
}

interface PublishDetail {
  item_id?: unknown;
  platform?: unknown;
  target?: unknown;
}

function detailOf(proposal: Pick<ProposalRow, "action">): PublishDetail {
  return ((proposal.action as { detail?: PublishDetail } | null)?.detail ?? {}) as PublishDetail;
}

/**
 * The due runner's route for a per-item publish proposal (P3-21b). Built
 * from the database — the approved proposal and its own item — never from
 * a client. Null plan = unroutable, with the reason.
 */
export async function publishPlan(
  proposal: ProposalRow,
): Promise<{ plan: DispatchPlan } | { unroutable: string }> {
  if (!isPublishProposal(proposal.action)) return { unroutable: "not a publish proposal" };
  const d = detailOf(proposal);
  // 2026-11-08: TikTok posting, its own provider and its one op.
  if (d.platform === "tiktok") return tiktokPublishPlan(proposal, d);
  if (d.platform !== "facebook" && d.platform !== "instagram") {
    return { unroutable: "the publish proposal names no platform" };
  }
  const [item] = await db
    .select()
    .from(contentItems)
    .where(
      and(
        eq(contentItems.id, d.item_id as string),
        eq(contentItems.profile_id, proposal.profile_id),
        eq(contentItems.publish_proposal_id, proposal.id),
      ),
    );
  if (!item) return { unroutable: "the item this proposal publishes is gone" };
  // Session K: real footage wins — an approved generated version never goes out once it exists.
  if (await supersededByFootage(item)) {
    return {
      unroutable: "your own footage for this replaced the generated version, so it isn't published",
    };
  }
  const op = publishOpFor(d.platform, item.media_path);
  if (op === null) {
    return { unroutable: `nothing SYB publishes fits this item on ${LABEL[d.platform]}` };
  }
  return {
    plan: {
      provider: "meta_publish",
      op,
      params: { item_id: item.id, platform: d.platform, target: d.target ?? null },
    },
  };
}

/** The TikTok route: the approved proposal and its own item, never a client. */
async function tiktokPublishPlan(
  proposal: ProposalRow,
  d: PublishDetail,
): Promise<{ plan: DispatchPlan } | { unroutable: string }> {
  const [item] = await db
    .select()
    .from(contentItems)
    .where(
      and(
        eq(contentItems.id, d.item_id as string),
        eq(contentItems.profile_id, proposal.profile_id),
        eq(contentItems.publish_proposal_id, proposal.id),
      ),
    );
  if (!item) return { unroutable: "the item this proposal publishes is gone" };
  if (await supersededByFootage(item)) {
    return {
      unroutable: "your own footage for this replaced the generated version, so it isn't published",
    };
  }
  if (item.media_path === null)
    return { unroutable: "TikTok needs a video, and this item has none" };
  return {
    plan: {
      provider: "tiktok_publish",
      op: "publish_tiktok_video",
      params: { item_id: item.id, platform: "tiktok", target: d.target ?? null },
    },
  };
}

/** How long a `running` execution may sit before the sweep treats its run as dead. */
export const STALE_RUN_MS = 15 * 60_000;
/** The sweep reads back for this long after a send; after that the owner's note stands. */
export const RECONCILE_WINDOW_MS = 7 * 86_400_000;

export interface ReconcileSummary {
  checked: number;
  published: number;
  not_sent: number;
  uncertain: number;
}

/**
 * P3-21d: the sweep. Every item left `publishing` by a run that failed or
 * died (its execution `failed`, or `running` and stale) is READ BACK —
 * never re-posted. Found → published, and the execution and proposal
 * record it. Provably never sent → failed. Otherwise it stays
 * `publishing` with "I may have posted this — check the Page". A halted
 * account is skipped: the stop covers reads made on its behalf too.
 */
export async function reconcilePublishing(
  opts: {
    provider?: MetaPublishProvider;
    /** 2026-11-08: TikTok items read back through their own provider. */
    tiktokProvider?: Pick<MetaPublishProvider, "reconcile">;
    now?: () => Date;
    profileId?: string;
  } = {},
): Promise<ReconcileSummary> {
  const now = opts.now ?? (() => new Date());
  const summary: ReconcileSummary = { checked: 0, published: 0, not_sent: 0, uncertain: 0 };
  const stale = new Date(now().getTime() - STALE_RUN_MS).toISOString();
  const conditions = [
    eq(contentItems.status, "publishing"),
    or(
      eq(executions.status, "failed"),
      and(eq(executions.status, "running"), lt(executions.started_at, stale)),
    ),
  ];
  if (opts.profileId) conditions.push(eq(contentItems.profile_id, opts.profileId));
  const rows = await db
    .select({ item: contentItems, execution: executions, account_id: businessProfiles.account_id })
    .from(contentItems)
    .innerJoin(executions, eq(executions.id, contentItems.publish_execution_id))
    .innerJoin(businessProfiles, eq(businessProfiles.id, contentItems.profile_id))
    .where(and(...conditions));
  if (rows.length === 0) return summary;

  const meta = async () =>
    opts.provider ?? (await import("../execution/providers/meta")).metaExecution.publish;
  const tiktok = async () =>
    opts.tiktokProvider ?? (await import("../execution/providers/tiktok")).tiktokPublishExecutor;

  for (const { item, execution, account_id } of rows) {
    const sentAt = (item.publish_attempt as PublishAttempt | null)?.sent_at;
    if (sentAt && now().getTime() - Date.parse(sentAt) > RECONCILE_WINDOW_MS) continue;
    if (await isHalted(account_id)) continue;
    const [proposal] = item.publish_proposal_id
      ? await db.select().from(proposals).where(eq(proposals.id, item.publish_proposal_id))
      : [];
    if (!proposal) continue;
    summary.checked += 1;
    const d = detailOf(proposal);
    let outcome: ReconcileOutcome;
    try {
      const provider = item.platform === "tiktok" ? await tiktok() : await meta();
      outcome = await provider.reconcile(
        { item_id: item.id, platform: d.platform, target: d.target },
        { profile_id: item.profile_id, account_id },
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "content_reconcile_failed",
          account_id,
          item_id: item.id,
          ...logSafeError(error),
        }),
      );
      summary.uncertain += 1;
      continue;
    }
    summary[outcome.kind === "found" ? "published" : outcome.kind] += 1;
    await settleExecution(execution, proposal, outcome, now());
    console.log(
      JSON.stringify({
        event: "content_reconciled",
        account_id,
        item_id: item.id,
        execution_id: execution.id,
        outcome: outcome.kind,
      }),
    );
  }
  return summary;
}

/** What the read-back found, recorded on the execution and the proposal. */
async function settleExecution(
  execution: ExecutionRow,
  proposal: ProposalRow,
  outcome: ReconcileOutcome,
  at: Date,
): Promise<void> {
  if (outcome.kind === "found") {
    await db
      .update(executions)
      .set({
        status: "succeeded",
        result: json(outcome.post),
        error: null,
        finished_at: at.toISOString(),
      })
      .where(
        and(eq(executions.id, execution.id), inArray(executions.status, ["failed", "running"])),
      );
    if (proposal.status === "approved") {
      try {
        await recordExecution({ proposalId: proposal.id, result: outcome.post });
      } catch (error) {
        if (!(error instanceof ProposalError)) throw error;
      }
    }
    return;
  }
  // Nothing new is known, or nothing was sent: a dead run is closed as failed, honestly.
  await db
    .update(executions)
    .set({ status: "failed", error: outcome.sentence, finished_at: at.toISOString() })
    .where(and(eq(executions.id, execution.id), eq(executions.status, "running")));
}

/**
 * Withdraw on /content (P3-21e): the stored undo, through the engine's
 * undoExecution — halt, watch and ownership checks included. Deletes the
 * post on Meta; the item becomes `withdrawn` and keeps its platform id.
 */
export async function withdrawItem(args: {
  itemId: string;
  profileId: string;
  userId: string;
  provider?: MetaPublishProvider;
}): Promise<ExecutionRow> {
  const [item] = await db
    .select()
    .from(contentItems)
    .where(and(eq(contentItems.id, args.itemId), eq(contentItems.profile_id, args.profileId)));
  if (!item) throw new ContentError("no such content item", 404);
  if (item.status !== "published") {
    throw new ContentError(
      `only a published post can be withdrawn — this one is ${item.status}`,
      409,
    );
  }
  if (item.platform === "tiktok") {
    // TikTok's API has no delete: the op was labelled irreversible before approval.
    const { TIKTOK_NO_UNDO } = await import("../execution/providers/tiktok");
    throw new ContentError(TIKTOK_NO_UNDO, 409);
  }
  if (!item.publish_execution_id) {
    throw new ContentError("this post has no stored undo — check the Page by hand", 409);
  }
  return undoExecution({
    executionId: item.publish_execution_id,
    userId: args.userId,
    expectedProfileId: args.profileId,
    ...(args.provider ? { provider: args.provider } : {}),
  });
}
