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
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { contentItems } from "../../db/schema";
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

/** What any media store must do. Vercel Blob in production, memory in tests. */
export interface MediaStore {
  readonly kind: "vercel_blob" | "memory";
  put(pathname: string, body: Uint8Array, contentType: string): Promise<StoredMedia>;
  /** Idempotent: deleting what is already gone is not an error. */
  del(url: string): Promise<void>;
}

/* ── the production store ── */

export function vercelBlobStore(): MediaStore {
  return {
    kind: "vercel_blob",
    async put(pathname, body, contentType) {
      const { put } = await import("@vercel/blob");
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
          token: env.BLOB_READ_WRITE_TOKEN,
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
      const { del } = await import("@vercel/blob");
      await del(url, { token: env.BLOB_READ_WRITE_TOKEN });
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
