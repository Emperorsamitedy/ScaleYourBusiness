// Where an item's media lands — P3-52 (footage in) and P3-53 (the AI
// fallback), Session K.
//
// Both paths end the same way: a rendered or generated file on local disk
// becomes the media of a content item, through attachRenderedMedia (the one
// door to object storage), with the item's disclosure re-labelled for what
// the media IS and its provenance saying where it came from. Then the item
// is offered for publishing like any other draft (P3-21a) — the owner
// approves the finished item, generated or filmed, in the same queue.
//
// The destination, by data:
//   - a SHOT LIST is filmed, never published: its media goes on its video
//     item (kind "video", made here the first time). A drafted video item
//     is updated in place; one already approved or gone out is left as it
//     is and a new video item is made
//   - a POST that needs media takes it itself while drafted; once approved
//     it is left as it is and a new video item is made beside it
//
// Real footage always wins (Session K, owner decision 2026-10-26): footage
// replaces generated media in place on a draft, and a generated item that
// was already approved is never published once footage for the same
// source exists (supersededByFootage, checked by publishPlan).

import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { db } from "../../db";
import { contentItems } from "../../db/schema";
import { logSafeError } from "../core/log-safe";
import type { LimitLlm } from "../proposals/hard-limits";
import type { MediaOrigin } from "./disclosure";
import { mediaDisclosureLabel, relabel } from "./disclosure";
import type { MediaStore } from "./media";
import { attachRenderedMedia } from "./media";
import { ContentError } from "./plan";
import type { PublishRun } from "./publish";
import { proposePublishing } from "./publish";

export type ContentItemRow = typeof contentItems.$inferSelect;

/** What made the media — written into the item's provenance as `media`. */
export type MediaSource =
  | {
      kind: "footage";
      render_id: string;
      clips: number;
      metrics: { duration_ms: number; bytes: number; output_s: number; segments: number };
    }
  | {
      kind: "generated";
      media: "image" | "video";
      generation_id: string;
      proposal_id: string;
      provider: string;
      model: string;
      cost: { amount_minor: number; currency: string };
      prompt_sha256: string;
    };

export interface MediaProvenance {
  origin: MediaOrigin;
  /** The shot list or post the media was made for — "the same source". */
  source_item_id: string;
  /** Rule 17: generated media is always flagged; Instagram gets is_ai_generated on every container anyway. */
  is_ai_generated: boolean;
  label: string;
  placed_at: string;
  detail: MediaSource;
}

export function originOf(source: MediaSource): MediaOrigin {
  return source.kind === "footage" ? "footage" : `generated_${source.media}`;
}

/** The media record on an item's provenance, or null. */
export function mediaOf(provenance: unknown): MediaProvenance | null {
  const m = (provenance as { media?: unknown } | null)?.media;
  if (!m || typeof m !== "object") return null;
  const r = m as Partial<MediaProvenance>;
  return typeof r.origin === "string" && typeof r.source_item_id === "string"
    ? (r as MediaProvenance)
    : null;
}

/** Which items can take footage or generated media, and why the rest can't. */
export function mediaTargetRefusal(item: {
  kind: string;
  status: string;
  provenance: unknown;
}): string | null {
  if (item.kind === "shot_list") return null;
  if (item.kind !== "post") {
    return item.kind === "video"
      ? "this is the video already — add footage on its shot list"
      : "only a shot list, or a post that needs a picture or a video, takes media";
  }
  if (item.status === "drafted") return null;
  if (item.status === "queued" && mediaOf(item.provenance)?.is_ai_generated === true) return null;
  return item.status === "queued"
    ? "it's already approved to go out as it is"
    : `it is ${item.status} — its media can't change now`;
}

/** A shot list's title, made into its video's: "Film for Instagram — Autumn menu" → "Autumn menu — video". */
export function videoTitle(target: { title: string; kind: string }): string {
  const base = target.title
    .replace(/^Film for [^—]+— /, "")
    .replace(/^Shot list — /, "")
    .trim();
  return target.kind === "post" ? `${base} (video)` : `${base} — video`;
}

/** The latest drafted video item made for this source (shot list), or null. */
async function draftedVideoFor(target: ContentItemRow): Promise<ContentItemRow | null> {
  const [row] = await db
    .select()
    .from(contentItems)
    .where(
      and(
        eq(contentItems.profile_id, target.profile_id),
        eq(contentItems.kind, "video"),
        eq(contentItems.status, "drafted"),
        sql`${contentItems.provenance}->'media'->>'source_item_id' = ${target.id}`,
      ),
    )
    .orderBy(desc(contentItems.created_at))
    .limit(1);
  return row ?? null;
}

export interface PlaceArgs {
  target: ContentItemRow;
  /** The rendered or generated file on local disk — server-made, never a client path. */
  file: string;
  source: MediaSource;
  /** A video item's caption (a shot list carries none of its own). */
  caption?: string | null;
  scheduledFor?: string | null;
  store: MediaStore;
  limitLlm?: LimitLlm;
  now?: Date;
}

export interface Placed {
  item: ContentItemRow;
  created: boolean;
  publishing: PublishRun;
}

/**
 * Put the media on its destination item, re-label it, and offer it for
 * publishing. Never publishes: the publish proposal is the next yes.
 */
export async function placeMedia(args: PlaceArgs): Promise<Placed> {
  const { target, source } = args;
  const refusal = mediaTargetRefusal(target);
  if (refusal) throw new ContentError(refusal, 409);
  const origin = originOf(source);
  const at = (args.now ?? new Date()).toISOString();

  let dest: ContentItemRow | null =
    target.kind === "post"
      ? target.status === "drafted"
        ? target
        : null
      : await draftedVideoFor(target);
  const kind = dest?.kind ?? "video";
  const label = mediaDisclosureLabel(kind === "post" ? "post" : "video", origin);
  const media: MediaProvenance = {
    origin,
    source_item_id: target.id,
    is_ai_generated: origin !== "footage",
    label,
    placed_at: at,
    detail: source,
  };

  let created = false;
  if (dest === null) {
    const tp = (target.provenance ?? {}) as Record<string, unknown>;
    const caption =
      args.caption?.trim() ||
      (target.kind === "post" ? target.body : videoTitle(target).replace(/ — video$/, ""));
    const [row] = await db
      .insert(contentItems)
      .values({
        profile_id: target.profile_id,
        proposal_id: target.proposal_id,
        goal_id: target.goal_id,
        kind: "video",
        channel_label: target.channel_label,
        scheduled_for: args.scheduledFor ?? target.scheduled_for,
        title: videoTitle(target),
        body: relabel(caption, label),
        disclosure: label,
        provenance: {
          // `item` carries the planned slot's channel_id — publishReadiness reads the platform from it.
          ...(tp.item ? { item: tp.item } : {}),
          ...(Array.isArray(tp.evidence) ? { evidence: tp.evidence } : {}),
          ...(tp.voice_card ? { voice_card: tp.voice_card } : {}),
          made_from: target.id,
          ai_generated: media.is_ai_generated,
          media,
        },
      })
      .returning();
    if (!row) throw new ContentError("could not make the video item", 500);
    dest = row;
    created = true;
  }

  try {
    await attachRenderedMedia({
      itemId: dest.id,
      file: args.file,
      store: args.store,
      expectedProfileId: target.profile_id,
    });
  } catch (error) {
    // A video item with no media would be a lie in the queue: the new row goes with the failure.
    if (created) await db.delete(contentItems).where(eq(contentItems.id, dest.id));
    throw error;
  }

  if (!created) {
    const prov = (dest.provenance ?? {}) as Record<string, unknown>;
    const prev = mediaOf(prov);
    const history = Array.isArray(prov.previous_media) ? (prov.previous_media as unknown[]) : [];
    const caption = kind === "video" && args.caption?.trim() ? args.caption : dest.body;
    await db
      .update(contentItems)
      .set({
        body: relabel(caption, label),
        disclosure: label,
        scheduled_for: args.scheduledFor ?? dest.scheduled_for,
        provenance: {
          ...prov,
          ai_generated: media.is_ai_generated,
          media,
          ...(prev ? { previous_media: [...history, prev] } : {}),
        },
      })
      .where(eq(contentItems.id, dest.id));
  }

  console.log(
    JSON.stringify({
      event: "content_media_placed",
      profile_id: target.profile_id,
      item_id: dest.id,
      source_item_id: target.id,
      origin,
      created,
    }),
  );

  // Logged, never thrown: the media is on the item whatever the proposal does.
  let publishing: PublishRun = { created: [], skipped: [] };
  try {
    publishing = await proposePublishing(target.profile_id, [dest.id], {
      ...(args.limitLlm ? { limitLlm: args.limitLlm } : {}),
      ...(args.now ? { now: args.now } : {}),
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "media_publish_proposal_failed",
        profile_id: target.profile_id,
        item_id: dest.id,
        ...logSafeError(error),
      }),
    );
  }
  const [item] = await db.select().from(contentItems).where(eq(contentItems.id, dest.id));
  return { item: item as ContentItemRow, created, publishing };
}

/**
 * Real footage wins: true when this item's media was generated and footage
 * for the same source now sits on another live item. publishPlan refuses
 * such an item, so an approved generated version never goes out once the
 * owner's own footage exists.
 */
export async function supersededByFootage(item: {
  id: string;
  profile_id: string;
  provenance: unknown;
}): Promise<boolean> {
  const media = mediaOf(item.provenance);
  if (!media?.is_ai_generated) return false;
  const [other] = await db
    .select({ id: contentItems.id })
    .from(contentItems)
    .where(
      and(
        eq(contentItems.profile_id, item.profile_id),
        ne(contentItems.id, item.id),
        inArray(contentItems.status, ["drafted", "queued", "publishing", "published"]),
        sql`${contentItems.provenance}->'media'->>'source_item_id' = ${media.source_item_id}`,
        sql`${contentItems.provenance}->'media'->>'origin' = 'footage'`,
      ),
    )
    .limit(1);
  return other !== undefined;
}

/** Does this source (shot list or post) have the owner's footage on any live item? */
export async function hasFootageFor(profileId: string, sourceItemId: string): Promise<boolean> {
  const [other] = await db
    .select({ id: contentItems.id })
    .from(contentItems)
    .where(
      and(
        eq(contentItems.profile_id, profileId),
        inArray(contentItems.status, ["drafted", "queued", "publishing", "published"]),
        sql`${contentItems.provenance}->'media'->>'source_item_id' = ${sourceItemId}`,
        sql`${contentItems.provenance}->'media'->>'origin' = 'footage'`,
      ),
    )
    .limit(1);
  return other !== undefined;
}
