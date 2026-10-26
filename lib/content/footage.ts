// Footage in — P3-52 (Session K), the path the 2026-10-15 status found
// missing: the owner uploads clips against a shot list, the cutting room
// (P3-18, ./edit) renders them, attachRenderedMedia puts the render on its
// item, and the item is offered for publishing (P3-21a).
//
// Uploads, two ways, chosen by environment (configuredMediaStore):
//   - production, with BLOB_READ_WRITE_TOKEN: the browser uploads STRAIGHT
//     to Vercel Blob — a function can't take a request body over 4.5 MB,
//     and phone clips run to hundreds. SYB grants each upload first
//     (issueClipUpload): the signed-in owner, a shot list of theirs, an
//     allowed type, a declared size under the cap, a pathname SYB chose.
//     The grant is a client token scoped to that one pathname, that one
//     type and that size, valid 30 minutes. The upload is then CONFIRMED
//     (confirmClipUpload) by asking Blob itself what landed — the browser's
//     word is never taken for the URL, the size or the type
//   - development without a token: the clip comes through the route
//     (storeClipDirect, capped lower) to the local disk store, its first
//     bytes checked for an MP4/QuickTime container
//   - production without a token: refused, honestly ("uploads aren't set up")
//
// Rendering runs where FFmpeg can: right after the response that asked for
// it (the route's `after`), and again on the cron sweep (sweepRenders) for
// any run that was cut short. If the binary isn't on the server, the run
// waits with the sentence that says so — nothing is lost and no attempt is
// spent. Attempts are capped at three, in code and in the database.
//
// Clips are released from storage once their render is on the item: the
// row stays as the record, the bytes go.

import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, asc, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import { db } from "../../db";
import { businessProfiles, contentItems, footageClips, footageRenders } from "../../db/schema";
import { logSafeError } from "../core/log-safe";
import { env } from "../env";
import type { LimitLlm } from "../proposals/hard-limits";
import { EditError, editClips, ffmpegAvailable, probe } from "./edit";
import type { ClipCut, ProbeResult } from "./edit";
import type { MediaStore } from "./media";
import { MediaError, configuredMediaStore } from "./media";
import type { ContentItemRow } from "./media-item";
import { mediaTargetRefusal, placeMedia } from "./media-item";
import { ContentError } from "./plan";

/* ── the limits, stated once ── */

/** The types the cutting room takes. Phones film MP4 (Android) and QuickTime (iPhone). */
export const FOOTAGE_TYPES: Readonly<Record<string, ".mp4" | ".mov">> = {
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
};
const MB = 1024 * 1024;
/** One clip, uploaded straight to Blob. A 30 s 4K phone clip is ~175 MB. */
export const MAX_CLIP_BYTES = 200 * MB;
/** One clip through the route (development only) — the request body is held in memory. */
export const MAX_DIRECT_CLIP_BYTES = 100 * MB;
/** Everything under one item — a function's /tmp is 512 MB, and the render needs room too. */
export const MAX_ITEM_FOOTAGE_BYTES = 400 * MB;
export const MAX_CLIPS_PER_ITEM = 8;
/** How long an upload grant (client token) lives. */
export const UPLOAD_GRANT_MS = 30 * 60_000;
/** Hard attempt cap (CLAUDE.md: every retry loop has one) — the database checks it too. */
export const MAX_RENDER_ATTEMPTS = 3;
/** A run "rendering" this long died with its function; the sweep may take it again. */
export const STALE_RENDER_MS = 15 * 60_000;
/** Reels: 3–90 s (P3-21b). The cut aims for a minute at most. */
export const REEL_MIN_S = 3;
export const REEL_MAX_S = 90;
export const TARGET_S = 60;
export const MIN_CUT_S = 2;
export const ON_SCREEN_MAX = 120;
/** Instagram's caption limit. */
export const CAPTION_MAX = 2200;

export type ClipRow = typeof footageClips.$inferSelect;
export type RenderRow = typeof footageRenders.$inferSelect;

/* ── the item a clip is for ── */

async function targetItem(profileId: string, itemId: string): Promise<ContentItemRow> {
  const [item] = await db
    .select()
    .from(contentItems)
    .where(and(eq(contentItems.id, itemId), eq(contentItems.profile_id, profileId)));
  // Ownership (2026-09-26 review): foreign = missing, 404.
  if (!item) throw new ContentError("no such content item", 404);
  const refusal = mediaTargetRefusal(item);
  if (refusal) throw new ContentError(`footage can't go on this: ${refusal}`, 409);
  return item;
}

function extensionFor(contentType: string): ".mp4" | ".mov" {
  const ext = FOOTAGE_TYPES[contentType];
  if (!ext) {
    throw new ContentError("clips must be MP4 or MOV video — what a phone camera records", 415);
  }
  return ext;
}

/** renders/<profile>/<item>/clip-<32 hex>.<ext> — chosen here, unguessable, never the browser's. */
export function clipPath(profileId: string, itemId: string, ext: string): string {
  return `renders/${profileId}/${itemId}/clip-${randomBytes(16).toString("hex")}${ext}`;
}

/** The file's own name, for the owner's list only: no path, no control characters, 80 chars. */
export function clipLabel(name: unknown): string {
  const raw = typeof name === "string" ? name : "";
  const base = raw.split(/[\\/]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f<>]/g, "").trim();
  return clean.slice(0, 80) || "clip";
}

/** An MP4 or QuickTime file has "ftyp" (or an old QuickTime atom) at byte 4. */
export function looksLikeVideoContainer(head: Uint8Array): boolean {
  if (head.byteLength < 12) return false;
  const atom = String.fromCharCode(head[4]!, head[5]!, head[6]!, head[7]!);
  return ["ftyp", "moov", "mdat", "wide", "free", "skip"].includes(atom);
}

async function liveClips(itemId: string): Promise<ClipRow[]> {
  return db
    .select()
    .from(footageClips)
    .where(
      and(eq(footageClips.item_id, itemId), inArray(footageClips.status, ["issued", "uploaded"])),
    )
    .orderBy(asc(footageClips.created_at));
}

/** The count and total-size caps, against what the item already holds. */
async function assertRoom(itemId: string, bytes: number, now: Date): Promise<void> {
  const floor = now.getTime() - UPLOAD_GRANT_MS;
  // An issued grant past its window can no longer land, so it no longer counts.
  const live = (await liveClips(itemId)).filter(
    (c) => c.status === "uploaded" || Date.parse(c.created_at) > floor,
  );
  if (live.length >= MAX_CLIPS_PER_ITEM) {
    throw new ContentError(
      `that's ${MAX_CLIPS_PER_ITEM} clips already — cut these, or remove one first`,
      409,
    );
  }
  const held = live.reduce((n, c) => n + (c.bytes ?? c.declared_bytes), 0);
  if (held + bytes > MAX_ITEM_FOOTAGE_BYTES) {
    throw new ContentError(
      `these clips would come to more than ${MAX_ITEM_FOOTAGE_BYTES / MB} MB for one video — shorter clips, or fewer`,
      413,
    );
  }
}

function assertSize(bytes: unknown, cap: number): number {
  if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes <= 0) {
    throw new ContentError("the clip's size is required", 422);
  }
  if (bytes > cap) {
    throw new ContentError(`a clip can be up to ${cap / MB} MB — this one is bigger`, 413);
  }
  return bytes;
}

/* ── production: a grant, the browser's upload, a confirmation ── */

export type MintClientToken = (args: {
  pathname: string;
  contentType: string;
  maxBytes: number;
  validUntil: number;
}) => Promise<string>;

/** The real minting: a Blob client token scoped to one pathname, type and size. */
export const blobClientToken: MintClientToken = async (a) => {
  const { generateClientTokenFromReadWriteToken } = await import("@vercel/blob/client");
  return generateClientTokenFromReadWriteToken({
    token: env.BLOB_READ_WRITE_TOKEN,
    pathname: a.pathname,
    allowedContentTypes: [a.contentType],
    maximumSizeInBytes: a.maxBytes,
    validUntil: a.validUntil,
    addRandomSuffix: false,
    allowOverwrite: false,
  });
};

export interface UploadGrant {
  clip_id: string;
  pathname: string;
  token: string;
  content_type: string;
  max_bytes: number;
  valid_until: string;
}

export async function issueClipUpload(args: {
  profileId: string;
  itemId: string;
  contentType: unknown;
  bytes: unknown;
  name: unknown;
  mint?: MintClientToken;
  now?: Date;
}): Promise<UploadGrant> {
  const now = args.now ?? new Date();
  await targetItem(args.profileId, args.itemId);
  const contentType = typeof args.contentType === "string" ? args.contentType : "";
  const ext = extensionFor(contentType);
  const bytes = assertSize(args.bytes, MAX_CLIP_BYTES);
  await assertRoom(args.itemId, bytes, now);

  const pathname = clipPath(args.profileId, args.itemId, ext);
  const validUntil = now.getTime() + UPLOAD_GRANT_MS;
  const token = await (args.mint ?? blobClientToken)({
    pathname,
    contentType,
    maxBytes: MAX_CLIP_BYTES,
    validUntil,
  });
  const [row] = await db
    .insert(footageClips)
    .values({
      profile_id: args.profileId,
      item_id: args.itemId,
      status: "issued",
      store: "vercel_blob",
      pathname,
      content_type: contentType,
      declared_bytes: bytes,
      label: clipLabel(args.name),
      created_at: now.toISOString(),
    })
    .returning();
  return {
    clip_id: row!.id,
    pathname,
    token,
    content_type: contentType,
    max_bytes: MAX_CLIP_BYTES,
    valid_until: new Date(validUntil).toISOString(),
  };
}

/** What the store says landed at a pathname — Blob's `head`, injectable for tests. */
export type HeadClip = (
  pathname: string,
) => Promise<{ url: string; size: number; contentType: string } | null>;

export const blobHead: HeadClip = async (pathname) => {
  const { head } = await import("@vercel/blob");
  try {
    const h = await head(pathname, {
      token: env.BLOB_READ_WRITE_TOKEN,
      abortSignal: AbortSignal.timeout(20_000),
    });
    return { url: h.url, size: h.size, contentType: h.contentType };
  } catch (error) {
    if (error instanceof Error && error.name === "BlobNotFoundError") return null;
    throw error;
  }
};

const BLOB_URL = /^https:\/\/[a-z0-9-]+\.public\.blob\.vercel-storage\.com\//;

export async function confirmClipUpload(args: {
  profileId: string;
  itemId: string;
  clipId: unknown;
  head?: HeadClip;
  now?: Date;
}): Promise<ClipRow> {
  const now = args.now ?? new Date();
  if (typeof args.clipId !== "string") throw new ContentError("clip_id is required", 422);
  const [clip] = await db
    .select()
    .from(footageClips)
    .where(
      and(
        eq(footageClips.id, args.clipId),
        eq(footageClips.item_id, args.itemId),
        eq(footageClips.profile_id, args.profileId),
      ),
    );
  if (!clip) throw new ContentError("no such clip", 404);
  if (clip.status !== "issued") return clip; // confirmed already — idempotent
  if (Date.parse(clip.created_at) + UPLOAD_GRANT_MS < now.getTime()) {
    throw new ContentError(
      "that upload took longer than its 30-minute window — upload it again",
      410,
    );
  }
  const landed = await (args.head ?? blobHead)(clip.pathname);
  if (!landed) throw new ContentError("the clip hasn't arrived in storage — upload it again", 409);
  if (!BLOB_URL.test(landed.url) || !landed.url.endsWith(`/${clip.pathname}`)) {
    throw new ContentError("the stored clip isn't where SYB put it — upload it again", 409);
  }
  // The token capped size and type at the store; checked again here, from the store's own answer.
  if (
    landed.size <= 0 ||
    landed.size > MAX_CLIP_BYTES ||
    landed.contentType !== clip.content_type
  ) {
    throw new ContentError("what arrived isn't the clip that was granted — upload it again", 422);
  }
  const [row] = await db
    .update(footageClips)
    .set({
      status: "uploaded",
      url: landed.url,
      bytes: landed.size,
      uploaded_at: now.toISOString(),
    })
    .where(and(eq(footageClips.id, clip.id), eq(footageClips.status, "issued")))
    .returning();
  return row ?? clip;
}

/* ── development: through the route, to the local store ── */

export async function storeClipDirect(args: {
  profileId: string;
  itemId: string;
  name: unknown;
  contentType: unknown;
  body: Uint8Array;
  store: MediaStore;
  now?: Date;
}): Promise<ClipRow> {
  const now = args.now ?? new Date();
  if (args.store.kind === "vercel_blob") {
    throw new ContentError("with Blob storage set up, clips upload straight to it", 409);
  }
  await targetItem(args.profileId, args.itemId);
  const contentType = typeof args.contentType === "string" ? args.contentType : "";
  const ext = extensionFor(contentType);
  const bytes = assertSize(args.body.byteLength, MAX_DIRECT_CLIP_BYTES);
  if (!looksLikeVideoContainer(args.body.subarray(0, 12))) {
    throw new ContentError("that file isn't an MP4 or MOV video, whatever its name says", 415);
  }
  await assertRoom(args.itemId, bytes, now);
  const pathname = clipPath(args.profileId, args.itemId, ext);
  const stored = await args.store.put(pathname, args.body, contentType);
  const [row] = await db
    .insert(footageClips)
    .values({
      profile_id: args.profileId,
      item_id: args.itemId,
      status: "uploaded",
      store: args.store.kind,
      pathname,
      url: stored.url,
      content_type: contentType,
      declared_bytes: bytes,
      bytes,
      label: clipLabel(args.name),
      created_at: now.toISOString(),
      uploaded_at: now.toISOString(),
    })
    .returning();
  return row!;
}

/** Remove a clip before it's cut: the bytes leave storage, the row stays as `released`. */
export async function removeClip(args: {
  profileId: string;
  clipId: unknown;
  store: MediaStore;
}): Promise<void> {
  if (typeof args.clipId !== "string") throw new ContentError("clip_id is required", 422);
  const [clip] = await db
    .select()
    .from(footageClips)
    .where(and(eq(footageClips.id, args.clipId), eq(footageClips.profile_id, args.profileId)));
  if (!clip) throw new ContentError("no such clip", 404);
  if (clip.status === "released") return;
  if (clip.status === "used") throw new ContentError("that clip is in a finished video", 409);
  if (clip.url) await args.store.del(clip.url);
  await db
    .update(footageClips)
    .set({ status: "released", released_at: new Date().toISOString() })
    .where(eq(footageClips.id, clip.id));
}

/* ── the cut, decided by arithmetic ── */

export interface PlannedCut extends ClipCut {
  clip_id: string;
}

/**
 * Pure: how the clips are cut into one Reel. Every clip in the owner's
 * order, each from its start, each at most its share of a minute (never
 * under two seconds where the clip has them); the whole between 3 and 90
 * seconds or it is refused by name. No model decides what to keep.
 */
export function cutPlan(
  clips: readonly (ProbeResult & { clip_id: string; input: string })[],
): PlannedCut[] {
  const usable = clips.filter((c) => c.duration_s >= 0.5);
  if (usable.length === 0) throw new EditError("none of these clips has any footage in it", 422);
  const share = Math.max(MIN_CUT_S, TARGET_S / usable.length);
  const cuts = usable.map((c) => ({
    clip_id: c.clip_id,
    input: c.input,
    start: 0,
    duration: Math.floor(Math.min(c.duration_s, share) * 100) / 100,
    has_audio: c.has_audio,
  }));
  const total = cuts.reduce((n, c) => n + c.duration, 0);
  if (total < REEL_MIN_S) {
    throw new EditError(
      `a Reel needs at least ${REEL_MIN_S} seconds, and these clips come to ${total.toFixed(1)}`,
      422,
    );
  }
  if (total > REEL_MAX_S) throw new EditError(`the cut came to over ${REEL_MAX_S} seconds`, 422);
  return cuts;
}

/* ── asking for a render, and running one ── */

export async function requestRender(args: {
  profileId: string;
  itemId: string;
  userId: string;
  onScreen?: unknown;
  caption?: unknown;
  scheduledFor?: unknown;
}): Promise<RenderRow> {
  const target = await targetItem(args.profileId, args.itemId);
  const clips = (await liveClips(args.itemId)).filter((c) => c.status === "uploaded");
  if (clips.length === 0) throw new ContentError("upload at least one clip first", 422);

  const onScreen = typeof args.onScreen === "string" ? args.onScreen.trim() : "";
  if (onScreen.length > ON_SCREEN_MAX) {
    throw new ContentError(`the on-screen line can be up to ${ON_SCREEN_MAX} characters`, 422);
  }
  const caption = typeof args.caption === "string" ? args.caption.trim() : "";
  if (target.kind === "shot_list" && caption === "") {
    throw new ContentError("the video needs a caption — what the post says under it", 422);
  }
  if (caption.length > CAPTION_MAX) {
    throw new ContentError(`a caption can be up to ${CAPTION_MAX} characters`, 422);
  }
  let date: string | null = null;
  if (typeof args.scheduledFor === "string" && args.scheduledFor !== "") {
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(args.scheduledFor) ||
      Number.isNaN(Date.parse(args.scheduledFor))
    ) {
      throw new ContentError("the date must be a day, like 2026-11-02", 422);
    }
    date = args.scheduledFor;
  }

  try {
    const [row] = await db
      .insert(footageRenders)
      .values({
        profile_id: args.profileId,
        item_id: args.itemId,
        clip_ids: clips.map((c) => c.id),
        on_screen: onScreen || null,
        caption: caption || null,
        scheduled_for: date,
        requested_by: args.userId,
      })
      .returning();
    return row!;
  } catch (error) {
    // The one-live-run index: a second "cut it" while one is queued or running.
    if (/footage_renders_one_live_uq/.test(String((error as { cause?: unknown }).cause ?? error))) {
      throw new ContentError("a cut is already under way for this", 409);
    }
    throw error;
  }
}

export interface RenderOutcome {
  render_id: string;
  status: "rendered" | "waiting" | "retrying" | "failed" | "skipped";
  item_id?: string;
  note?: string;
}

/** Errors whose cause is the footage or the request, not the moment: retrying changes nothing. */
function isFinal(error: unknown): boolean {
  if (error instanceof EditError || error instanceof MediaError || error instanceof ContentError) {
    return error.status < 500;
  }
  return false;
}

function sentenceOf(error: unknown): string {
  if (error instanceof EditError || error instanceof MediaError || error instanceof ContentError) {
    return error.message;
  }
  return "something went wrong while cutting it";
}

async function accountOf(profileId: string): Promise<string | null> {
  const [row] = await db
    .select({ account_id: businessProfiles.account_id })
    .from(businessProfiles)
    .where(eq(businessProfiles.id, profileId));
  return row?.account_id ?? null;
}

export const WAITING_FOR_FFMPEG =
  "The cutting room can't run on this server (FFmpeg isn't here). Your clips are safe; the cut waits for the next run that can do it.";

/**
 * Run one render: claim it (conditionally — two runners never cut the same
 * clips), read the clips back, cut, put the render on its item, release the
 * clips, offer the item for publishing. Every outcome is written on the row.
 */
export async function runRender(
  renderId: string,
  opts: {
    store?: MediaStore;
    now?: () => Date;
    limitLlm?: LimitLlm;
    /** Is the binary here? Injectable so the "not available" path is a test, not a hope. */
    ffmpeg?: () => boolean;
  } = {},
): Promise<RenderOutcome> {
  const now = opts.now ?? (() => new Date());
  const stale = new Date(now().getTime() - STALE_RENDER_MS).toISOString();
  const [run] = await db
    .update(footageRenders)
    .set({
      status: "rendering",
      attempts: sql`${footageRenders.attempts} + 1`,
      started_at: now().toISOString(),
    })
    .where(
      and(
        eq(footageRenders.id, renderId),
        lt(footageRenders.attempts, MAX_RENDER_ATTEMPTS),
        or(
          eq(footageRenders.status, "queued"),
          and(eq(footageRenders.status, "rendering"), lt(footageRenders.started_at, stale)),
        ),
      ),
    )
    .returning();
  if (!run) return { render_id: renderId, status: "skipped" };
  const accountId = await accountOf(run.profile_id);

  // The honest "not available here": no attempt spent, the run waits.
  if (!(opts.ffmpeg ?? ffmpegAvailable)()) {
    await db
      .update(footageRenders)
      .set({ status: "queued", attempts: run.attempts - 1, note: WAITING_FOR_FFMPEG })
      .where(eq(footageRenders.id, run.id));
    console.log(
      JSON.stringify({ event: "footage_render_waiting", account_id: accountId, render_id: run.id }),
    );
    return { render_id: run.id, status: "waiting", note: WAITING_FOR_FFMPEG };
  }

  const store = opts.store ?? configuredMediaStore();
  const dir = path.join(os.tmpdir(), `syb-render-${run.id}`);
  try {
    if (!store) throw new MediaError("media storage isn't set up on this server", 503);
    const [target] = await db
      .select()
      .from(contentItems)
      .where(and(eq(contentItems.id, run.item_id), eq(contentItems.profile_id, run.profile_id)));
    if (!target) throw new ContentError("the item these clips were for is gone", 404);
    const ids = (Array.isArray(run.clip_ids) ? run.clip_ids : []) as string[];
    const clips = await db
      .select()
      .from(footageClips)
      .where(and(inArray(footageClips.id, ids), eq(footageClips.status, "uploaded")));
    if (clips.length !== ids.length || ids.length === 0) {
      throw new ContentError("a clip in this cut is gone — upload it again and cut again", 409);
    }
    const ordered = ids.map((id) => clips.find((c) => c.id === id)!);

    await fs.mkdir(dir, { recursive: true });
    const probed: (ProbeResult & { clip_id: string; input: string })[] = [];
    for (const [i, clip] of ordered.entries()) {
      if (!store.get) throw new MediaError("this media store can't read clips back", 503);
      const body = await store.get(clip.url as string, MAX_CLIP_BYTES);
      const file = path.join(dir, `in-${i}${FOOTAGE_TYPES[clip.content_type] ?? ".mp4"}`);
      await fs.writeFile(file, body);
      let p: ProbeResult;
      try {
        p = await probe(file);
      } catch (error) {
        if (error instanceof EditError) throw error;
        throw new EditError(`"${clip.label}" isn't a video the cutting room can read`, 422);
      }
      probed.push({ ...p, clip_id: clip.id, input: file });
    }
    const cuts = cutPlan(probed);
    const output = path.join(dir, "render.mp4");
    const edit = await editClips({
      output,
      cuts,
      aspect: "vertical",
      account_id: accountId ?? run.profile_id,
      ...(run.on_screen ? { caption: run.on_screen } : {}),
    });
    const outputS = Math.round(cuts.reduce((n, c) => n + c.duration, 0) * 100) / 100;
    const metrics = {
      duration_ms: edit.duration_ms,
      bytes: edit.bytes,
      output_s: outputS,
      segments: cuts.length,
    };

    const placed = await placeMedia({
      target,
      file: output,
      source: { kind: "footage", render_id: run.id, clips: cuts.length, metrics },
      caption: run.caption,
      scheduledFor: run.scheduled_for,
      store,
      ...(opts.limitLlm ? { limitLlm: opts.limitLlm } : {}),
      now: now(),
    });

    // The render is on the item; the clips' bytes go. The rows stay as the record.
    for (const clip of ordered) {
      try {
        await store.del(clip.url as string);
        await db
          .update(footageClips)
          .set({ status: "released", released_at: now().toISOString() })
          .where(eq(footageClips.id, clip.id));
      } catch (error) {
        await db.update(footageClips).set({ status: "used" }).where(eq(footageClips.id, clip.id));
        console.error(
          JSON.stringify({
            event: "footage_clip_release_failed",
            account_id: accountId,
            clip_id: clip.id,
            ...logSafeError(error),
          }),
        );
      }
    }

    const published = placed.publishing.created.length > 0;
    const skipped = placed.publishing.skipped[0]?.reason;
    const note = published
      ? "Cut. Its publish proposal is in your queue."
      : skipped
        ? `Cut. Not proposed for publishing yet: ${skipped}.`
        : "Cut.";
    await db
      .update(footageRenders)
      .set({
        status: "rendered",
        result_item_id: placed.item.id,
        metrics,
        note,
        finished_at: now().toISOString(),
      })
      .where(eq(footageRenders.id, run.id));
    console.log(
      JSON.stringify({
        event: "footage_rendered",
        account_id: accountId,
        render_id: run.id,
        item_id: placed.item.id,
        ...metrics,
      }),
    );
    return { render_id: run.id, status: "rendered", item_id: placed.item.id, note };
  } catch (error) {
    const final = isFinal(error) || run.attempts >= MAX_RENDER_ATTEMPTS;
    const sentence = sentenceOf(error);
    const note = final
      ? `The cut failed: ${sentence}.`
      : `That try failed (${sentence}); it tries again on the next run — attempt ${run.attempts} of ${MAX_RENDER_ATTEMPTS}.`;
    await db
      .update(footageRenders)
      .set({
        status: final ? "failed" : "queued",
        note,
        ...(final ? { finished_at: now().toISOString() } : {}),
      })
      .where(eq(footageRenders.id, run.id));
    console.error(
      JSON.stringify({
        event: "footage_render_failed",
        account_id: accountId,
        render_id: run.id,
        attempt: run.attempts,
        final,
        ...logSafeError(error),
      }),
    );
    return { render_id: run.id, status: final ? "failed" : "retrying", note };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/**
 * The cron's sweep: every queued run with attempts left, and every run a
 * dead function left `rendering`, one at a time, until the time budget is
 * spent (the route's maxDuration is 300 s; a run started is a run finished).
 */
export async function sweepRenders(
  opts: { store?: MediaStore; now?: () => Date; budgetMs?: number; limitLlm?: LimitLlm } = {},
): Promise<{ ran: RenderOutcome[]; left: number }> {
  const now = opts.now ?? (() => new Date());
  const startedAt = Date.now();
  const budget = opts.budgetMs ?? 200_000;
  const stale = new Date(now().getTime() - STALE_RENDER_MS).toISOString();
  const due = await db
    .select({ id: footageRenders.id })
    .from(footageRenders)
    .where(
      and(
        lt(footageRenders.attempts, MAX_RENDER_ATTEMPTS),
        or(
          eq(footageRenders.status, "queued"),
          and(eq(footageRenders.status, "rendering"), lt(footageRenders.started_at, stale)),
        ),
      ),
    )
    .orderBy(asc(footageRenders.created_at));
  const ran: RenderOutcome[] = [];
  for (const { id } of due) {
    if (Date.now() - startedAt > budget) break;
    ran.push(await runRender(id, opts));
    // Without FFmpeg here, nothing else will cut either.
    if (ran[ran.length - 1]?.status === "waiting") break;
  }
  return { ran, left: due.length - ran.length };
}

/* ── what /content shows ── */

export interface FootageView {
  clips: { id: string; label: string; bytes: number | null; status: ClipRow["status"] }[];
  render: {
    id: string;
    status: RenderRow["status"];
    note: string | null;
    result_item_id: string | null;
    attempts: number;
    metrics: unknown;
  } | null;
}

export type UploadMode = "blob" | "direct" | "off";

/** How clips get uploaded here, by environment. */
export function uploadMode(store: MediaStore | null = configuredMediaStore()): UploadMode {
  if (!store) return "off";
  return store.kind === "vercel_blob" ? "blob" : "direct";
}

/** For each item that can take footage: its clips (still held) and its latest render. */
export async function footageView(
  profileId: string,
  itemIds: readonly string[],
): Promise<Record<string, FootageView>> {
  if (itemIds.length === 0) return {};
  const [clips, renders] = await Promise.all([
    db
      .select()
      .from(footageClips)
      .where(
        and(
          eq(footageClips.profile_id, profileId),
          inArray(footageClips.item_id, [...itemIds]),
          eq(footageClips.status, "uploaded"),
        ),
      )
      .orderBy(asc(footageClips.created_at)),
    db
      .select()
      .from(footageRenders)
      .where(
        and(
          eq(footageRenders.profile_id, profileId),
          inArray(footageRenders.item_id, [...itemIds]),
        ),
      )
      .orderBy(desc(footageRenders.created_at)),
  ]);
  const out: Record<string, FootageView> = {};
  for (const id of itemIds) {
    const r = renders.find((x) => x.item_id === id);
    out[id] = {
      clips: clips
        .filter((c) => c.item_id === id)
        .map((c) => ({ id: c.id, label: c.label, bytes: c.bytes, status: c.status })),
      render: r
        ? {
            id: r.id,
            status: r.status,
            note: r.note,
            result_item_id: r.result_item_id,
            attempts: r.attempts,
            metrics: r.metrics,
          }
        : null,
    };
  }
  return out;
}
