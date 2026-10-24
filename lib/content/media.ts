// Media storage — P3-20c (Session D, layer D0).
//
// A rendered clip or image has to sit at a PUBLIC URL at publish time:
// Instagram fetches media from the URL it is given (docs-verified,
// 2026-09-30), and Facebook's photo endpoint takes a URL too. Until now
// renders lived only on local disk and content_items.media_path was
// never written. This module is the one door to object storage:
//
//   - the store is Vercel Blob in production (CLAUDE.md's "object storage
//     for uploads"), an in-memory store in tests — same interface, so
//     every caller is proven without a token or a network
//   - the path is UNGUESSABLE: renders/<profile>/<item>/<16 random bytes>
//     plus the extension. Public means fetchable by whoever holds the URL,
//     not listable or guessable; the platform holds it for seconds
//   - a render is deleted the moment it is no longer needed — once the
//     platform confirms the publish (D2) or the item is withdrawn — so the
//     store holds what is pending, never an archive. The database row keeps
//     the record; the bytes do not linger at a public address
//
// No model is anywhere near this file, and nothing here generates media:
// bytes in, URL out.

import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { db } from "../../db";
import { contentItems } from "../../db/schema";
import type { del as blobDel, list as blobList, put as blobPut } from "@vercel/blob";
import { env } from "../env";

export class MediaError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "MediaError";
    this.status = status;
  }
}

export interface StoredMedia {
  /** The public URL — what the platform is handed. */
  url: string;
  /** The store's own key for the object, for deletion. */
  pathname: string;
  content_type: string;
  bytes: number;
}

/** What the store holds right now (P3-24d): the ops panel's storage line. */
export interface StoreUsage {
  objects: number;
  bytes: number;
  /** True when the listing stopped at its page cap, so the figures are a floor. */
  truncated: boolean;
}

/** What any media store must do. Vercel Blob in production, memory in tests. */
export interface MediaStore {
  readonly kind: "vercel_blob" | "memory";
  put(pathname: string, body: Uint8Array, contentType: string): Promise<StoredMedia>;
  /** Idempotent: deleting what is already gone is not an error. */
  del(url: string): Promise<void>;
  /** P3-24d: what is stored under renders/ — reads only. */
  usage(): Promise<StoreUsage>;
}

/** The prefix every render is stored under (renderPath). */
export const RENDER_PREFIX = "renders/";
/** A hard cap on listing pages (1 000 objects each) for one usage read. */
export const USAGE_MAX_PAGES = 20;

/* ── the production store ── */

/**
 * Review 2026-10-23 (Session D #10): every Blob call gives up. An upload of a
 * rendered clip gets two minutes; a delete or a listing page, twenty seconds
 * (the Meta helper's own figure). The SDK takes an AbortSignal on each.
 */
export const BLOB_PUT_TIMEOUT_MS = 120_000;
export const BLOB_TIMEOUT_MS = 20_000;

/** The three SDK calls the store makes — injectable so the timeouts are tested without a network. */
export interface BlobSdk {
  put: typeof blobPut;
  del: typeof blobDel;
  list: typeof blobList;
}

export function vercelBlobStore(
  opts: { sdk?: BlobSdk; token?: string; putTimeoutMs?: number; timeoutMs?: number } = {},
): MediaStore {
  const token = () => opts.token ?? env.BLOB_READ_WRITE_TOKEN;
  const sdk = async (): Promise<BlobSdk> => opts.sdk ?? (await import("@vercel/blob"));
  const signal = (ms: number | undefined, fallback: number) => AbortSignal.timeout(ms ?? fallback);
  return {
    kind: "vercel_blob",
    async put(pathname, body, contentType) {
      const { put } = await sdk();
      // The SDK's body type is Buffer | Blob | stream; a Uint8Array view
      // becomes a Buffer without copying when it already is one.
      const result = await put(
        pathname,
        Buffer.from(body.buffer, body.byteOffset, body.byteLength),
        {
          access: "public",
          // The path already carries its own randomness; a suffix would
          // only make the pathname differ from what we recorded.
          addRandomSuffix: false,
          contentType,
          token: token(),
          abortSignal: signal(opts.putTimeoutMs, BLOB_PUT_TIMEOUT_MS),
        },
      );
      return {
        url: result.url,
        pathname: result.pathname,
        content_type: contentType,
        bytes: body.byteLength,
      };
    },
    async del(url) {
      const { del } = await sdk();
      await del(url, {
        token: token(),
        abortSignal: signal(opts.timeoutMs, BLOB_TIMEOUT_MS),
      });
    },
    async usage() {
      const { list } = await sdk();
      const out: StoreUsage = { objects: 0, bytes: 0, truncated: false };
      let cursor: string | undefined;
      for (let page = 1; ; page += 1) {
        const res = await list({
          prefix: RENDER_PREFIX,
          limit: 1000,
          token: token(),
          abortSignal: signal(opts.timeoutMs, BLOB_TIMEOUT_MS),
          ...(cursor ? { cursor } : {}),
        });
        for (const b of res.blobs) {
          out.objects += 1;
          out.bytes += b.size;
        }
        if (!res.hasMore || !res.cursor) return out;
        if (page >= USAGE_MAX_PAGES) return { ...out, truncated: true };
        cursor = res.cursor;
      }
    },
  };
}

/* ── the in-memory store (tests, local UI work) ── */

export interface MemoryMediaStore extends MediaStore {
  /** What the "platform" would fetch — null once deleted. */
  read(url: string): Uint8Array | null;
  urls(): string[];
  reset(): void;
}

export function memoryMediaStore(origin = "https://blob.test.invalid"): MemoryMediaStore {
  const objects = new Map<string, { body: Uint8Array; content_type: string }>();
  return {
    kind: "memory",
    async put(pathname, body, contentType) {
      const url = `${origin}/${pathname}`;
      objects.set(url, { body, content_type: contentType });
      return { url, pathname, content_type: contentType, bytes: body.byteLength };
    },
    async del(url) {
      objects.delete(url);
    },
    async usage() {
      let bytes = 0;
      let count = 0;
      for (const [url, o] of objects) {
        if (!url.startsWith(`${origin}/${RENDER_PREFIX}`)) continue;
        count += 1;
        bytes += o.body.byteLength;
      }
      return { objects: count, bytes, truncated: false };
    },
    read(url) {
      return objects.get(url)?.body ?? null;
    },
    urls() {
      return [...objects.keys()];
    },
    reset() {
      objects.clear();
    },
  };
}

/* ── paths and types ── */

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
};

export function contentTypeFor(file: string): string {
  const type = CONTENT_TYPES[path.extname(file).toLowerCase()];
  if (!type) {
    throw new MediaError(
      `"${path.extname(file) || file}" is not a media type the platforms accept — mp4, mov, jpg or png`,
      422,
    );
  }
  return type;
}

/** renders/<profile>/<item>/<unguessable>.<ext> — no listing, no guessing. */
export function renderPath(profileId: string, itemId: string, file: string): string {
  const ext = path.extname(file).toLowerCase();
  return `renders/${profileId}/${itemId}/${randomBytes(16).toString("hex")}${ext}`;
}

/* ── attaching to and releasing from a content item ── */

export interface AttachArgs {
  itemId: string;
  /** The rendered file on local disk (the cutting room's output). */
  file: string;
  store?: MediaStore;
  /** Ownership scope: when set, only this profile's items take media. */
  expectedProfileId?: string;
}

/**
 * Upload a render and record its public URL on the item. Replacing an
 * existing render deletes the old object first — one render per item,
 * never a stray public copy.
 */
export async function attachRenderedMedia(args: AttachArgs): Promise<StoredMedia> {
  const store = args.store ?? vercelBlobStore();
  const [item] = await db.select().from(contentItems).where(eq(contentItems.id, args.itemId));
  if (!item) throw new MediaError("no such content item", 404);
  if (args.expectedProfileId && item.profile_id !== args.expectedProfileId) {
    throw new MediaError("no such content item", 404);
  }
  const contentType = contentTypeFor(args.file);
  const body = await fs.readFile(args.file);
  if (body.byteLength === 0) throw new MediaError("the render is empty", 422);

  if (item.media_path) await store.del(item.media_path);
  const stored = await store.put(
    renderPath(item.profile_id, item.id, args.file),
    body,
    contentType,
  );
  await db.update(contentItems).set({ media_path: stored.url }).where(eq(contentItems.id, item.id));
  console.log(
    JSON.stringify({
      event: "content_media_attached",
      profile_id: item.profile_id,
      item_id: item.id,
      store: store.kind,
      content_type: contentType,
      bytes: stored.bytes,
    }),
  );
  return stored;
}

/**
 * Review 2026-10-23 (Session D #10): release the renders of items whose
 * publish will never happen — declined, expired, failed or lapsed — so a
 * public URL doesn't outlive its purpose. Only items not published or in
 * flight (drafted, queued, failed): a post that is or may be up keeps its
 * record, and publish/withdraw release theirs themselves. Never throws: a
 * render left in storage is logged and tidied later, never a failed decision.
 */
export async function releaseUnpublishedMedia(
  itemIds: readonly string[],
  store?: MediaStore,
): Promise<number> {
  if (itemIds.length === 0) return 0;
  const s = store ?? vercelBlobStore();
  const rows = await db
    .select()
    .from(contentItems)
    .where(
      and(
        inArray(contentItems.id, [...itemIds]),
        inArray(contentItems.status, ["drafted", "queued", "failed"]),
        isNotNull(contentItems.media_path),
      ),
    );
  let released = 0;
  for (const item of rows) {
    try {
      await s.del(item.media_path as string);
      await db.update(contentItems).set({ media_path: null }).where(eq(contentItems.id, item.id));
      released += 1;
      console.log(
        JSON.stringify({
          event: "content_media_released",
          profile_id: item.profile_id,
          item_id: item.id,
          store: s.kind,
          why: item.status,
        }),
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "content_media_release_failed",
          profile_id: item.profile_id,
          item_id: item.id,
          error: error instanceof Error ? error.name : "unknown",
        }),
      );
    }
  }
  return released;
}

/** The URL the platform is handed, or null when the item carries no media. */
export function publicUrl(item: { media_path: string | null }): string | null {
  return item.media_path;
}

/**
 * Delete the render from the store and clear the item's path. Called when
 * the platform has confirmed the publish or the item is withdrawn (D2).
 * Idempotent: an item with no media releases nothing and is not an error.
 */
export async function releaseRenderedMedia(args: {
  itemId: string;
  store?: MediaStore;
}): Promise<boolean> {
  const store = args.store ?? vercelBlobStore();
  const [item] = await db.select().from(contentItems).where(eq(contentItems.id, args.itemId));
  if (!item) throw new MediaError("no such content item", 404);
  if (!item.media_path) return false;
  await store.del(item.media_path);
  await db.update(contentItems).set({ media_path: null }).where(eq(contentItems.id, item.id));
  console.log(
    JSON.stringify({
      event: "content_media_released",
      profile_id: item.profile_id,
      item_id: item.id,
      store: store.kind,
    }),
  );
  return true;
}
