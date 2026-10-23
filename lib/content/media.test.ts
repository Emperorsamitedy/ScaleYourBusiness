// P3-20c — media storage: a rendered fixture clip lands in the (in-memory)
// store at a public, unguessable URL, the item records it, replacing a
// render deletes the old object, and releasing deletes the object and
// clears the path. No token, no network.

import "dotenv/config";
import { promises as fs } from "node:fs";
import path from "node:path";
import { eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "../../db";
import {
  accounts,
  businessProfiles,
  contentItems,
  fieldRecords,
  intakeEvents,
  proposals,
} from "../../db/schema";
import { bootstrapIntake } from "../intake/service";
import { createProposal } from "../proposals/service";
import { ffmpegAvailable, makeTestClip } from "./edit";
import {
  BLOB_PUT_TIMEOUT_MS,
  BLOB_TIMEOUT_MS,
  MediaError,
  attachRenderedMedia,
  contentTypeFor,
  memoryMediaStore,
  publicUrl,
  releaseRenderedMedia,
  renderPath,
  vercelBlobStore,
} from "./media";
import type { BlobSdk } from "./media";

const TMP = path.join(process.cwd(), ".data", "test-renders");
const created: { account_id: string; profile_id: string }[] = [];

const scenario = {
  assumptions: [],
  base_case: { case: "base", statement: "t", profit_delta_monthly: null, formula: null },
  downside_case: { case: "downside", statement: "t", profit_delta_monthly: null, formula: null },
  upside_case: { case: "upside", statement: "t", profit_delta_monthly: null, formula: null },
  breakeven_condition: "none — fixture",
} as never;

async function freshItem() {
  const s = await bootstrapIntake();
  created.push(s);
  const proposal = await createProposal({
    profile_id: s.profile_id,
    module: "content",
    action: { kind: "content_publishing", summary: "fixture plan" },
    scenario,
    reversibility: { level: "easy", if_you_change_your_mind: "discard the draft" },
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  });
  const [item] = await db
    .insert(contentItems)
    .values({
      profile_id: s.profile_id,
      proposal_id: proposal.id,
      kind: "video",
      channel_label: "Instagram",
      scheduled_for: "2026-11-02",
      title: "Autumn menu",
      body: "The soup is back.\n\nAI-assisted edit of real footage. No AI-generated imagery.",
      disclosure: "AI-assisted edit of real footage. No AI-generated imagery.",
      provenance: { test: true },
    })
    .returning();
  return { ...s, item: item! };
}

afterAll(async () => {
  const ids = created.map((s) => s.profile_id);
  if (ids.length > 0) {
    await db.delete(contentItems).where(inArray(contentItems.profile_id, ids));
    await db.delete(proposals).where(inArray(proposals.profile_id, ids));
    await db.delete(intakeEvents).where(inArray(intakeEvents.profile_id, ids));
    await db.delete(fieldRecords).where(inArray(fieldRecords.profile_id, ids));
    await db.delete(businessProfiles).where(inArray(businessProfiles.id, ids));
  }
  for (const s of created) await db.delete(accounts).where(eq(accounts.id, s.account_id));
});

describe("P3-20c — paths and types", () => {
  it("the render path is unguessable and scoped to profile and item", () => {
    const a = renderPath("profile-1", "item-1", "clip.mp4");
    const b = renderPath("profile-1", "item-1", "clip.mp4");
    expect(a).toMatch(/^renders\/profile-1\/item-1\/[0-9a-f]{32}\.mp4$/);
    expect(a).not.toBe(b);
  });

  it("only the media types the platforms accept get a content type", () => {
    expect(contentTypeFor("x.mp4")).toBe("video/mp4");
    expect(contentTypeFor("x.JPG")).toBe("image/jpeg");
    expect(contentTypeFor("x.png")).toBe("image/png");
    expect(() => contentTypeFor("x.gif")).toThrow(MediaError);
    expect(() => contentTypeFor("x.exe")).toThrow(/not a media type/);
  });
});

describe("P3-20c — attach and release", () => {
  it("an image lands in the store at a public URL, the item records it, and release deletes it", async () => {
    const { item, profile_id } = await freshItem();
    const store = memoryMediaStore();
    const file = path.join(TMP, `media-${item.id}.png`);
    await fs.mkdir(TMP, { recursive: true });
    // A PNG header is enough: the store takes bytes, it does not decode them.
    await fs.writeFile(
      file,
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]),
    );

    const stored = await attachRenderedMedia({ itemId: item.id, file, store });
    expect(stored.content_type).toBe("image/png");
    expect(stored.bytes).toBe(11);
    expect(stored.url).toMatch(
      new RegExp(
        `^https://blob\\.test\\.invalid/renders/${profile_id}/${item.id}/[0-9a-f]{32}\\.png$`,
      ),
    );
    expect(store.read(stored.url)).not.toBeNull();

    const [row] = await db.select().from(contentItems).where(eq(contentItems.id, item.id));
    expect(row?.media_path).toBe(stored.url);
    expect(publicUrl(row!)).toBe(stored.url);

    expect(await releaseRenderedMedia({ itemId: item.id, store })).toBe(true);
    expect(store.read(stored.url)).toBeNull();
    const [after] = await db.select().from(contentItems).where(eq(contentItems.id, item.id));
    expect(after?.media_path).toBeNull();
    // Releasing again is a quiet no-op, not an error.
    expect(await releaseRenderedMedia({ itemId: item.id, store })).toBe(false);
  });

  it("replacing a render deletes the previous object — one public copy per item, never two", async () => {
    const { item } = await freshItem();
    const store = memoryMediaStore();
    await fs.mkdir(TMP, { recursive: true });
    const first = path.join(TMP, `media-${item.id}-a.jpg`);
    const second = path.join(TMP, `media-${item.id}-b.jpg`);
    await fs.writeFile(first, Buffer.from("first"));
    await fs.writeFile(second, Buffer.from("second"));

    const a = await attachRenderedMedia({ itemId: item.id, file: first, store });
    const b = await attachRenderedMedia({ itemId: item.id, file: second, store });
    expect(b.url).not.toBe(a.url);
    expect(store.urls()).toEqual([b.url]);
  });

  it("refuses an unknown item, a foreign profile, an empty file and a type the platforms reject", async () => {
    const { item } = await freshItem();
    const other = await freshItem();
    const store = memoryMediaStore();
    const empty = path.join(TMP, `media-${item.id}-empty.mp4`);
    await fs.writeFile(empty, Buffer.alloc(0));

    await expect(
      attachRenderedMedia({ itemId: crypto.randomUUID(), file: empty, store }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      attachRenderedMedia({
        itemId: item.id,
        file: empty,
        store,
        expectedProfileId: other.profile_id,
      }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(attachRenderedMedia({ itemId: item.id, file: empty, store })).rejects.toThrow(
      /empty/,
    );
    await expect(
      attachRenderedMedia({ itemId: item.id, file: "clip.webm", store }),
    ).rejects.toThrow(/not a media type/);
    expect(store.urls()).toEqual([]);
  });

  it.skipIf(!ffmpegAvailable())(
    "a rendered fixture clip from the cutting room's own test-clip generator lands as video/mp4",
    async () => {
      const { item } = await freshItem();
      const store = memoryMediaStore();
      const clip = path.join(TMP, `media-${item.id}.mp4`);
      await makeTestClip(clip, 1);

      const stored = await attachRenderedMedia({ itemId: item.id, file: clip, store });
      expect(stored.content_type).toBe("video/mp4");
      expect(stored.bytes).toBeGreaterThan(1000);
      expect(store.read(stored.url)?.byteLength).toBe(stored.bytes);
      await releaseRenderedMedia({ itemId: item.id, store });
      expect(store.urls()).toEqual([]);
    },
    60_000,
  );
});

describe("review 2026-10-23, Session D #10 — every Blob call gives up", () => {
  /** A fake SDK: records each call's options; `hang` never answers until the signal aborts. */
  function fakeSdk(hang: boolean) {
    const seen: { call: string; signal: AbortSignal | undefined }[] = [];
    const wait = (
      call: string,
      opts: { abortSignal?: AbortSignal } | undefined,
      value: unknown,
    ) => {
      seen.push({ call, signal: opts?.abortSignal });
      if (!hang) return Promise.resolve(value);
      return new Promise((_, reject) => {
        opts?.abortSignal?.addEventListener("abort", () => reject(new Error(`${call} aborted`)));
      });
    };
    const sdk = {
      put: (pathname: string, _body: unknown, opts: { abortSignal?: AbortSignal }) =>
        wait("put", opts, { url: `https://blob.test/${pathname}`, pathname }),
      del: (_url: unknown, opts: { abortSignal?: AbortSignal }) => wait("del", opts, undefined),
      list: (opts: { abortSignal?: AbortSignal }) =>
        wait("list", opts, { blobs: [], hasMore: false, cursor: undefined }),
    } as unknown as BlobSdk;
    return { sdk, seen };
  }

  it("put, del and list each carry an AbortSignal, and answer normally when the store answers", async () => {
    const { sdk, seen } = fakeSdk(false);
    const store = vercelBlobStore({ sdk, token: "test" });
    await store.put("renders/p/i/x.jpg", new Uint8Array([1]), "image/jpeg");
    await store.del("https://blob.test/renders/p/i/x.jpg");
    expect(await store.usage()).toEqual({ objects: 0, bytes: 0, truncated: false });
    expect(seen.map((s) => s.call)).toEqual(["put", "del", "list"]);
    for (const s of seen) expect(s.signal).toBeInstanceOf(AbortSignal);
    expect(BLOB_PUT_TIMEOUT_MS).toBe(120_000);
    expect(BLOB_TIMEOUT_MS).toBe(20_000);
  });

  it("a store that never answers is given up on, instead of holding the run", async () => {
    const { sdk } = fakeSdk(true);
    const store = vercelBlobStore({ sdk, token: "test", putTimeoutMs: 20, timeoutMs: 20 });
    await expect(store.del("https://blob.test/x.jpg")).rejects.toThrow(/del aborted/);
    await expect(store.put("renders/p/i/x.jpg", new Uint8Array([1]), "image/jpeg")).rejects.toThrow(
      /put aborted/,
    );
    await expect(store.usage()).rejects.toThrow(/list aborted/);
  });
});
