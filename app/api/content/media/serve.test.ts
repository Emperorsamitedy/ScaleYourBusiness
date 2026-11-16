// The /content gallery reads an item's media back by ITEM id: no door, no
// media; another business's item is not found; the caller's own item comes
// back private, and its storage address never leaves the server. The store
// is the in-memory one; the access and the item lookup are stubs.

import "dotenv/config";
import { describe, expect, it, vi } from "vitest";
import { tileMedia } from "../../../../components/content/content-view";
import { LOCAL_MEDIA_ORIGIN, memoryMediaStore } from "../../../../lib/content/media";
import { type ServeDeps, serveItemMedia } from "./serve";

const MINE = { profile_id: "11111111-1111-4111-8111-111111111111", account_id: "acct-mine" };
const THEIRS = { profile_id: "22222222-2222-4222-8222-222222222222", account_id: "acct-theirs" };
const ITEM = "64e2a1a7-b362-4bef-9f5f-318a2d4a0aaa";
const BYTES = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

async function world(access: ServeDeps["access"]) {
  const store = memoryMediaStore();
  const stored = await store.put(
    `renders/${MINE.profile_id}/${ITEM}/0123456789abcdef0123456789abcdef.png`,
    BYTES,
    "image/png",
  );
  // The route's query is scoped the same way: an item answers only for its own business.
  const mediaPathOf = vi.fn(async (profileId: string, itemId: string) =>
    profileId === MINE.profile_id && itemId === ITEM ? stored.url : null,
  );
  return { store, stored, mediaPathOf, deps: { access, mediaPathOf, store: () => store } };
}

describe("GET /api/content/media — an item's media, for its own business only", () => {
  it("refuses without the door, before anything is looked up", async () => {
    const w = await world(async () => null);
    const res = await serveItemMedia({ itemId: ITEM, range: null }, w.deps);
    expect(res.status).toBe(401);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(w.mediaPathOf).not.toHaveBeenCalled();
  });

  it("serves the caller's own item privately, without its storage address", async () => {
    const w = await world(async () => MINE);
    const res = await serveItemMedia({ itemId: ITEM, range: null }, w.deps);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toMatch(/^private/);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(BYTES);
    expect(JSON.stringify([...res.headers])).not.toContain(w.stored.url);
    expect(w.mediaPathOf).toHaveBeenCalledWith(MINE.profile_id, ITEM);
  });

  it("finds nothing for another business's item, a malformed id or no id", async () => {
    const w = await world(async () => THEIRS);
    const other = await serveItemMedia({ itemId: ITEM, range: null }, w.deps);
    expect(other.status).toBe(404);
    expect(await other.json()).toEqual({ error: "no such media" });
    expect(w.mediaPathOf).toHaveBeenCalledWith(THEIRS.profile_id, ITEM);
    w.mediaPathOf.mockClear();
    for (const itemId of ["../../etc/passwd", w.stored.url, null]) {
      expect((await serveItemMedia({ itemId, range: null }, w.deps)).status).toBe(404);
    }
    expect(w.mediaPathOf).not.toHaveBeenCalled();
  });

  it("opens only what the store itself holds, and says when there is no store", async () => {
    const w = await world(async () => MINE);
    const stray = { ...w.deps, mediaPathOf: async () => "https://elsewhere.example/a/b.png" };
    expect((await serveItemMedia({ itemId: ITEM, range: null }, stray)).status).toBe(404);
    const none = { ...w.deps, store: () => null };
    expect((await serveItemMedia({ itemId: ITEM, range: null }, none)).status).toBe(503);
  });

  it("answers one byte range, and refuses one it can't meet", async () => {
    const w = await world(async () => MINE);
    const part = await serveItemMedia({ itemId: ITEM, range: "bytes=2-5" }, w.deps);
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(BYTES.slice(2, 6));
    const tail = await serveItemMedia({ itemId: ITEM, range: "bytes=-3" }, w.deps);
    expect(new Uint8Array(await tail.arrayBuffer())).toEqual(BYTES.slice(7));
    const past = await serveItemMedia({ itemId: ITEM, range: "bytes=40-" }, w.deps);
    expect(past.status).toBe(416);
    expect(past.headers.get("content-range")).toBe("bytes */10");
  });

  it("is where a tile for the dev store's media points, by item id and never by path", () => {
    const stored = `${LOCAL_MEDIA_ORIGIN}/renders/${MINE.profile_id}/${ITEM}/0123456789abcdef.mp4`;
    const tile = tileMedia({ id: ITEM, media_path: stored });
    expect(tile).toEqual({ kind: "video", src: `/api/content/media?item_id=${ITEM}&v=89abcdef` });
    expect(tile?.src).not.toContain("renders/");
  });
});
