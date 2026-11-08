// TikTok posting — the provider, against a fake TikTok API and an in-memory
// backend. No real network: the global fetch fails the test if touched, and
// every assertion about what was sent reads the fake's own call log.
//
// What these tests hold, each with a passing and a failing case:
//   · the request fence: only the registered paths, only FILE_UPLOAD, no
//     video.manage, the upload only to a tiktokapis.com host;
//   · rule 17: no init without its disclosure, is_aigc on generated clips;
//   · the access rule: unaudited means SELF_ONLY, by name;
//   · at most once: claimed before anything is sent, sent_at just before the
//     last chunk, a lost answer read back by publish_id — never re-sent;
//   · irreversible honestly: no undo is captured, and undo says why;
//   · the 2-hour token: refreshed near expiry, rotated pair stored, scopes
//     still exactly the consent's.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { EXECUTION_SCOPE_REGISTRY } from "../scopes";
import type { FakeTikTokOptions as FakeOpts } from "./tiktok-fake";
import { FAKE_TIKTOK_UPLOAD_URL as UPLOAD, fakeTikTok } from "./tiktok-fake";
import type {
  TikTokCredential,
  TikTokPostSettings,
  TikTokPublishAttempt,
  TikTokPublishBackend,
  TikTokPublishItem,
  TikTokPublishedPost,
} from "./tiktok";
import {
  TIKTOK_MAY_HAVE_POSTED,
  TIKTOK_NOT_AS_APPROVED,
  TIKTOK_NO_SETTINGS,
  TIKTOK_NO_UNDO,
  TIKTOK_REQUESTS,
  TIKTOK_SINGLE_CHUNK_MAX,
  TIKTOK_STILL_PROCESSING,
  TIKTOK_CHUNK_BYTES,
  approvedTikTokHash,
  chunkPlan,
  classifyTikTokError,
  createTikTokExecution,
  failReasonSentence,
  offeredPrivacy,
  parseTikTokJson,
  parseTikTokSettings,
  scopeList,
  tiktokDisclosureViolation,
  tiktokPostUrl,
  uploadTargetAllowed,
  uploadableMedia,
} from "./tiktok";

const realFetchUsed = vi.fn(async () => {
  throw new Error("a real fetch was attempted in a TikTok test");
});
beforeAll(() => vi.stubGlobal("fetch", realFetchUsed));
afterAll(() => {
  expect(realFetchUsed).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

const LABEL = "AI-generated video. Not real footage.";
const FOOTAGE = "AI-assisted edit of real footage. No AI-generated imagery.";
const MEDIA = "https://blob.test.invalid/renders/p/i/abc.mp4";
const OPEN_ID = "open-id-1";
const NOW = new Date("2026-11-08T10:00:00Z");
const noSleep = async () => undefined;

const SETTINGS: TikTokPostSettings = {
  privacy_level: "SELF_ONLY",
  allow_comment: true,
  allow_duet: false,
  allow_stitch: false,
  brand_organic: true,
};

function cred(over: Partial<TikTokCredential> = {}): TikTokCredential {
  return {
    v: 1,
    open_id: OPEN_ID,
    access_token: "act.fake",
    refresh_token: "rft.fake",
    access_expires_at: NOW.getTime() + 3_600_000,
    refresh_expires_at: NOW.getTime() + 100 * 86_400_000,
    scopes: ["user.info.basic", "video.list", "video.publish"],
    username: "corner_cafe",
    nickname: "Corner Café",
    ...over,
  };
}

function item(over: Partial<TikTokPublishItem> = {}): TikTokPublishItem {
  const base: TikTokPublishItem = {
    id: "item-1",
    profile_id: "profile-1",
    kind: "video",
    title: "Autumn menu",
    body: `The soup is back.\n\n${LABEL}`,
    disclosure: LABEL,
    media_path: MEDIA,
    status: "queued",
    platform: null,
    platform_post_id: null,
    platform_url: null,
    publish_proposal_id: "proposal-1",
    publish_attempt: null,
    publish_approved_sha256: null,
    link: null,
    tiktok_settings: SETTINGS,
    is_ai_generated: true,
    ...over,
  };
  return {
    ...base,
    publish_approved_sha256:
      over.publish_approved_sha256 === undefined
        ? approvedTikTokHash(base)
        : over.publish_approved_sha256,
  };
}

/* ── an in-memory backend ── */

function memoryBackend(start: TikTokPublishItem, credential = cred()) {
  const state = {
    item: { ...start },
    credential,
    stored: [] as TikTokCredential[],
    paused: [] as string[],
    log: [] as string[],
  };
  const backend: TikTokPublishBackend = {
    async item(id) {
      return id === state.item.id ? { ...state.item } : null;
    },
    async credential() {
      return { connection_id: "conn-1", credential: state.credential };
    },
    async storeCredential(_a, _c, c) {
      state.stored.push(c);
      state.credential = c;
    },
    async claim(_id, _exec, attempt) {
      if (state.item.status !== "drafted" && state.item.status !== "queued") return false;
      state.item = { ...state.item, status: "publishing", publish_attempt: { ...attempt } };
      state.log.push("claim");
      return true;
    },
    async readMedia(url, max) {
      if (url !== MEDIA) throw new Error("not ours");
      const bytes = new Uint8Array(1024);
      if (bytes.byteLength > max) throw new Error("too big");
      return bytes;
    },
    async note(_id, attempt: TikTokPublishAttempt) {
      state.item = { ...state.item, publish_attempt: { ...attempt } };
      state.log.push(`note:${Object.keys(attempt).sort().join(",")}`);
    },
    async published(_i, post: TikTokPublishedPost) {
      if (state.item.status !== "publishing") return;
      state.item = {
        ...state.item,
        status: "published",
        platform: "tiktok",
        platform_post_id: post.platform_post_id,
        platform_url: post.url,
      };
    },
    async failed(_id, sentence) {
      state.item = { ...state.item, status: "failed", last_error: sentence } as TikTokPublishItem;
    },
    async uncertain(_id, sentence) {
      state.log.push(`uncertain:${sentence}`);
    },
    async deferred(_id, sentence) {
      state.log.push(`deferred:${sentence}`);
    },
    async paused(_a, sentence) {
      state.paused.push(sentence);
    },
    async unclaim(_id, sentence) {
      if (state.item.publish_attempt?.sent_at === undefined) {
        state.item = { ...state.item, status: "queued" };
        state.log.push(`unclaim:${sentence}`);
      }
    },
    async lapsed(_id, sentence) {
      state.item = { ...state.item, status: "failed" };
      state.log.push(`lapsed:${sentence}`);
    },
  };
  return { backend, state };
}

const params = { item_id: "item-1", platform: "tiktok", target: { open_id: OPEN_ID } };
const ctx = (over: Record<string, unknown> = {}) => ({
  profile_id: "profile-1",
  account_id: "account-1",
  execution_id: "exec-1",
  attempt: 1,
  ...over,
});

function harness(
  start: TikTokPublishItem,
  fake: FakeOpts = {},
  audit: "unaudited" | "audited" = "unaudited",
) {
  const api = fakeTikTok(fake);
  const mem = memoryBackend(start);
  const exec = createTikTokExecution({
    fetch: api.fetch,
    sleep: noSleep,
    now: () => NOW,
    app: () => ({ client_key: "ck", client_secret: "cs" }),
    audit: () => audit,
    backend: mem.backend,
  });
  return { api, mem, exec };
}

/* ── the pure pieces ── */

describe("TikTok — the pure pieces", () => {
  it("says each TikTok refusal once, pausing only for a sign-in TikTok no longer accepts", () => {
    expect(classifyTikTokError(401, "access_token_invalid")).toMatchObject({
      kind: "auth",
      pauses: true,
      retryable: false,
    });
    expect(classifyTikTokError(401, "scope_not_authorized")).toMatchObject({
      kind: "scope",
      pauses: true,
    });
    expect(classifyTikTokError(429, "rate_limit_exceeded")).toMatchObject({
      kind: "rate_limit",
      retryable: true,
      pauses: false,
    });
    expect(
      classifyTikTokError(403, "unaudited_client_can_only_post_to_private_accounts"),
    ).toMatchObject({ kind: "unaudited", retryable: false });
    expect(classifyTikTokError(403, "spam_risk_too_many_posts")).toMatchObject({
      kind: "posting_limit",
      retryable: true,
    });
    expect(classifyTikTokError(503, null)).toMatchObject({ kind: "unavailable", retryable: true });
    expect(classifyTikTokError(400, "something_new").owner_sentence).toBe(
      "TikTok refused with something_new.",
    );
  });

  it("reads TikTok's comma-separated scopes as a sorted set", () => {
    expect(scopeList("video.publish,user.info.basic, video.list")).toEqual([
      "user.info.basic",
      "video.list",
      "video.publish",
    ]);
    expect(scopeList(undefined)).toEqual([]);
  });

  it("cuts a file by TikTok's chunk rules: one chunk up to 64 MB, else 10 MB chunks with the remainder on the last", () => {
    expect(chunkPlan(1024)).toEqual({
      chunk_size: 1024,
      total_chunk_count: 1,
      ranges: [[0, 1023]],
    });
    expect(chunkPlan(TIKTOK_SINGLE_CHUNK_MAX).total_chunk_count).toBe(1);
    const big = TIKTOK_SINGLE_CHUNK_MAX + 5 * 1024 * 1024 + 7;
    const plan = chunkPlan(big);
    expect(plan.chunk_size).toBe(TIKTOK_CHUNK_BYTES);
    expect(plan.total_chunk_count).toBe(Math.floor(big / TIKTOK_CHUNK_BYTES));
    expect(plan.ranges.at(-1)?.[1]).toBe(big - 1);
    // Contiguous, nothing skipped.
    for (let i = 1; i < plan.ranges.length; i += 1) {
      expect(plan.ranges[i]?.[0]).toBe((plan.ranges[i - 1]?.[1] ?? 0) + 1);
    }
    expect(() => chunkPlan(0)).toThrow(/empty/);
  });

  it("uploads only to an https tiktokapis.com host, and only a video SYB stores", () => {
    expect(uploadTargetAllowed(UPLOAD)).toBe(true);
    expect(uploadTargetAllowed("https://evil.example/upload")).toBe(false);
    expect(uploadTargetAllowed("http://open-upload.tiktokapis.com/x")).toBe(false);
    expect(uploadTargetAllowed("https://tiktokapis.com.evil.example/x")).toBe(false);
    expect(uploadableMedia(MEDIA)).toBe(true);
    expect(uploadableMedia("https://blob.test.invalid/a.jpg")).toBe(false);
    expect(uploadableMedia(null)).toBe(false);
  });

  it("rule 17: an init without its disclosure, or a generated clip without is_aigc, is refused", () => {
    const good = {
      post_info: { title: `Hi\n\n${LABEL}`, is_aigc: true },
      source_info: { source: "FILE_UPLOAD" },
      _expect_aigc: true,
    };
    expect(tiktokDisclosureViolation(good)).toBeNull();
    expect(
      tiktokDisclosureViolation({ ...good, post_info: { ...good.post_info, title: "Hi" } }),
    ).toMatch(/disclosure/);
    expect(
      tiktokDisclosureViolation({ ...good, post_info: { title: good.post_info.title } }),
    ).toMatch(/is_aigc is missing/);
    expect(
      tiktokDisclosureViolation({ ...good, post_info: { ...good.post_info, is_aigc: false } }),
    ).toMatch(/generated media/);
    expect(
      tiktokDisclosureViolation({ ...good, source_info: { source: "PULL_FROM_URL" } }),
    ).toMatch(/FILE_UPLOAD/);
    // Real footage: disclosed as an edit, and is_aigc false is honest.
    expect(
      tiktokDisclosureViolation({
        post_info: { title: `Hi\n\n${FOOTAGE}`, is_aigc: false },
        source_info: { source: "FILE_UPLOAD" },
        _expect_aigc: false,
      }),
    ).toBeNull();
  });

  it("offers only 'Only me' while SYB's app is unaudited, and TikTok's own options once audited", () => {
    const creator = { privacy_level_options: ["PUBLIC_TO_EVERYONE", "SELF_ONLY"] as never };
    expect(offeredPrivacy(creator, "unaudited")).toEqual(["SELF_ONLY"]);
    expect(offeredPrivacy(creator, "audited")).toEqual(["PUBLIC_TO_EVERYONE", "SELF_ONLY"]);
    expect(
      offeredPrivacy({ privacy_level_options: ["PUBLIC_TO_EVERYONE"] as never }, "unaudited"),
    ).toEqual([]);
  });

  it("the approval hash covers the caption, the video and the TikTok settings", () => {
    const a = item();
    expect(approvedTikTokHash(a)).toBe(a.publish_approved_sha256);
    expect(
      approvedTikTokHash({
        ...a,
        tiktok_settings: { ...SETTINGS, privacy_level: "PUBLIC_TO_EVERYONE" },
      }),
    ).not.toBe(a.publish_approved_sha256);
    expect(
      approvedTikTokHash({ ...a, media_path: "https://blob.test.invalid/other.mp4" }),
    ).not.toBe(a.publish_approved_sha256);
    expect(approvedTikTokHash({ ...a, body: "changed" })).not.toBe(a.publish_approved_sha256);
  });

  it("settings parse strictly: an unknown privacy is no settings at all", () => {
    expect(parseTikTokSettings({ ...SETTINGS })).toEqual(SETTINGS);
    expect(parseTikTokSettings({ privacy_level: "EVERYONE" })).toBeNull();
    expect(parseTikTokSettings(null)).toBeNull();
  });

  it("keeps an int64 post id exact — JSON.parse alone would round it", () => {
    expect(String((JSON.parse('{"a":[7300000000000000001]}') as { a: number[] }).a[0])).not.toBe(
      "7300000000000000001",
    );
    expect(
      parseTikTokJson('{"a":[7300000000000000001],"b":12,"c":"7300000000000000001x"}'),
    ).toEqual({
      a: ["7300000000000000001"],
      b: 12,
      c: "7300000000000000001x",
    });
  });

  it("links to a public post only with a numeric post id and the handle", () => {
    expect(tiktokPostUrl("corner_cafe", "7300000000000000001")).toBe(
      "https://www.tiktok.com/@corner_cafe/video/7300000000000000001",
    );
    expect(tiktokPostUrl(null, "7300000000000000001")).toBeNull();
    expect(tiktokPostUrl("corner_cafe", "v_pub_file~v2-1.123")).toBeNull();
  });

  it("every TikTok failure reason ends 'Nothing was published'", () => {
    for (const r of ["duration_check_failed", "spam_risk_text", null, "brand_new_reason"]) {
      expect(failReasonSentence(r)).toMatch(/Nothing was published\.$/);
    }
  });
});

/* ── the build gate ── */

describe("TikTok — the request fence (a source scan, failing the build)", () => {
  const source = readFileSync(join(process.cwd(), "lib/execution/providers/tiktok.ts"), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("names only the registered API paths, on TikTok's one API host", () => {
    const paths = [...code.matchAll(/["'`](\/v2\/[^"'`]*)["'`]/g)].map((m) => m[1]);
    const registered = Object.values(TIKTOK_REQUESTS).map((r) => r.path as string);
    expect(paths.length).toBeGreaterThan(0);
    for (const p of paths) expect(registered).toContain(p);
    expect([...code.matchAll(/https:\/\/[a-z.-]+/g)].map((m) => m[0]).sort()).toEqual(
      ["https://open.tiktokapis.com", "https://www.tiktok.com", "https://www.tiktok.com"].sort(),
    );
  });

  it("never sends PULL_FROM_URL, never names video.manage or video.upload, and is POST/PUT only", () => {
    expect(code).not.toMatch(/PULL_FROM_URL/);
    expect(code).not.toMatch(/video\.manage|video\.upload/);
    expect(code).not.toMatch(/method:\s*"(GET|DELETE|PATCH)"/);
    // The registry declares every request's scope from the consent's own list.
    const allowed = new Set([
      ...EXECUTION_SCOPE_REGISTRY.tiktok_publish.write_scopes,
      ...EXECUTION_SCOPE_REGISTRY.tiktok_publish.readback_scopes,
    ] as string[]);
    for (const r of Object.values(TIKTOK_REQUESTS))
      for (const s of r.scopes) expect(allowed.has(s)).toBe(true);
  });
});

/* ── the executor ── */

describe("TikTok — preflight (reads only; a refusal leaves the proposal approved)", () => {
  it("goes ahead for an item as approved, private, on the approved account", async () => {
    const h = harness(item());
    expect(await h.exec.publish.preflight!("publish_tiktok_video", params, ctx())).toBeNull();
    // creator_info was read live, as TikTok requires before a post.
    expect(h.api.calls.map((c) => c.url)).toEqual([
      "https://open.tiktokapis.com/v2/post/publish/creator_info/query/",
    ]);
  });

  it("refuses by name when what would go out isn't what was approved", async () => {
    const h = harness(item({ publish_approved_sha256: "0".repeat(64) }));
    expect(await h.exec.publish.preflight!("publish_tiktok_video", params, ctx())).toEqual({
      code: "refused",
      message: TIKTOK_NOT_AS_APPROVED,
    });
    expect(h.api.calls).toEqual([]);
  });

  it("refuses an item with no settings chosen", async () => {
    const h = harness(item({ tiktok_settings: null }));
    expect(await h.exec.publish.preflight!("publish_tiktok_video", params, ctx())).toEqual({
      code: "refused",
      message: TIKTOK_NO_SETTINGS,
    });
  });

  it("unaudited: anything but SELF_ONLY is refused before TikTok refuses it at init", async () => {
    const pub = item({ tiktok_settings: { ...SETTINGS, privacy_level: "PUBLIC_TO_EVERYONE" } });
    const h = harness(pub);
    const r = await h.exec.publish.preflight!("publish_tiktok_video", params, ctx());
    expect(r?.code).toBe("refused");
    expect(r?.message).toMatch(/only lets SYB post privately/);
    // Audited, the same post goes ahead.
    const audited = harness(pub, {}, "audited");
    expect(await audited.exec.publish.preflight!("publish_tiktok_video", params, ctx())).toBeNull();
  });

  it("refuses a privacy TikTok no longer offers this account", async () => {
    const h = harness(item(), { creator: { privacy_level_options: ["FOLLOWER_OF_CREATOR"] } });
    const r = await h.exec.publish.preflight!("publish_tiktok_video", params, ctx());
    expect(r?.message).toMatch(/no longer offers the privacy/);
  });

  it("a sign-in TikTok refuses pauses the connection; a rate limit only defers", async () => {
    const auth = harness(item(), {
      refuse: { creator_info: { status: 401, code: "access_token_invalid" } },
    });
    const r = await auth.exec.publish.preflight!("publish_tiktok_video", params, ctx());
    expect(r?.code).toBe("refused");
    expect(auth.mem.state.paused).toHaveLength(1);
    const slow = harness(item(), {
      refuse: { creator_info: { status: 429, code: "rate_limit_exceeded" } },
    });
    const d = await slow.exec.publish.preflight!("publish_tiktok_video", params, ctx());
    expect(d?.code).toBe("deferred");
    expect(slow.mem.state.paused).toHaveLength(0);
  });

  it("refuses an approval for a different TikTok account than the one connected now", async () => {
    const h = harness(item());
    const r = await h.exec.publish.preflight!(
      "publish_tiktok_video",
      { ...params, target: { open_id: "someone-else" } },
      ctx(),
    );
    expect(r?.message).toMatch(/different TikTok account/);
  });
});

describe("TikTok — execute, at most once", () => {
  it("claims, uploads by FILE_UPLOAD with sent_at before the last chunk, and records TikTok's id", async () => {
    const h = harness(item(), {
      statuses: [
        { status: "PROCESSING_UPLOAD" },
        { status: "PUBLISH_COMPLETE", publicaly_available_post_id: [] },
      ],
    });
    const post = (await h.exec.publish.execute(
      "publish_tiktok_video",
      params,
      ctx(),
    )) as TikTokPublishedPost;
    // SELF_ONLY: no public post id, so the publish_id is the id SYB keeps.
    expect(post).toEqual({
      platform: "tiktok",
      platform_post_id: "v_pub_file~v2-1.123",
      url: null,
      publish_id: "v_pub_file~v2-1.123",
      public_post: false,
    });
    expect(h.mem.state.item.status).toBe("published");
    // Claimed before anything was sent; sent_at noted after init, before the last chunk.
    expect(h.mem.state.log.slice(0, 3)).toEqual([
      "claim",
      "note:caption_sha256,publish_id,started_at",
      "note:caption_sha256,publish_id,sent_at,started_at",
    ]);
    const init = h.api.calls.find((c) => c.url.endsWith("/video/init/"));
    expect(init?.body).toEqual({
      post_info: {
        title: `The soup is back.\n\n${LABEL}`,
        privacy_level: "SELF_ONLY",
        disable_comment: false,
        disable_duet: true,
        // The account has stitches off: off whatever the owner chose.
        disable_stitch: true,
        brand_content_toggle: false,
        brand_organic_toggle: true,
        is_aigc: true,
      },
      source_info: {
        source: "FILE_UPLOAD",
        video_size: 1024,
        chunk_size: 1024,
        total_chunk_count: 1,
      },
    });
    const put = h.api.calls.filter((c) => c.url === UPLOAD);
    expect(put).toHaveLength(1);
    expect(put[0]?.init.method).toBe("PUT");
    expect(put[0]?.init.headers["content-range"]).toBe("bytes 0-1023/1024");
  });

  it("real footage goes out with is_aigc false and its own honest label", async () => {
    const h = harness(
      item({ body: `Fresh bread.\n\n${FOOTAGE}`, disclosure: FOOTAGE, is_ai_generated: false }),
    );
    await h.exec.publish.execute("publish_tiktok_video", params, ctx());
    const init = h.api.calls.find((c) => c.url.endsWith("/video/init/"));
    expect((init?.body?.["post_info"] as { is_aigc?: unknown }).is_aigc).toBe(false);
  });

  it("a public post keeps its public id and link", async () => {
    const h = harness(
      item({ tiktok_settings: { ...SETTINGS, privacy_level: "PUBLIC_TO_EVERYONE" } }),
      {
        statuses: [
          '{"status":"PUBLISH_COMPLETE","publicaly_available_post_id":[7300000000000000001]}',
        ],
      },
      "audited",
    );
    const post = (await h.exec.publish.execute(
      "publish_tiktok_video",
      params,
      ctx(),
    )) as TikTokPublishedPost;
    expect(post.platform_post_id).toBe("7300000000000000001");
    expect(post.url).toBe("https://www.tiktok.com/@corner_cafe/video/7300000000000000001");
    expect(post.public_post).toBe(true);
  });

  it("a lost answer on the last chunk is never re-sent: it stays publishing and is read back by publish_id", async () => {
    const h = harness(item(), { loseLastChunk: true });
    await expect(
      h.exec.publish.execute("publish_tiktok_video", params, ctx()),
    ).rejects.toMatchObject({
      message: TIKTOK_MAY_HAVE_POSTED,
      retryable: true,
    });
    expect(h.mem.state.item.status).toBe("publishing");
    expect(h.mem.state.item.publish_attempt?.sent_at).toBeDefined();
    const putsBefore = h.api.calls.filter((c) => c.url === UPLOAD).length;
    // The engine's next attempt reads back instead.
    const post = (await h.exec.publish.execute(
      "publish_tiktok_video",
      params,
      ctx({ attempt: 2 }),
    )) as TikTokPublishedPost;
    expect(post.publish_id).toBe("v_pub_file~v2-1.123");
    expect(h.api.calls.filter((c) => c.url === UPLOAD).length).toBe(putsBefore);
    expect(h.api.calls.filter((c) => c.url.endsWith("/video/init/")).length).toBe(1);
    expect(h.mem.state.item.status).toBe("published");
  });

  it("still processing after the polls: uncertain, retryable, and the sweep settles it later", async () => {
    const h = harness(item(), { statuses: [{ status: "PROCESSING_UPLOAD" }] });
    await expect(
      h.exec.publish.execute("publish_tiktok_video", params, ctx()),
    ).rejects.toMatchObject({
      message: TIKTOK_STILL_PROCESSING,
      retryable: true,
    });
    expect(h.mem.state.item.status).toBe("publishing");
    // reconcile: complete now.
    const settled = createTikTokExecution({
      fetch: fakeTikTok({
        statuses: [{ status: "PUBLISH_COMPLETE", publicaly_available_post_id: [] }],
      }).fetch,
      sleep: noSleep,
      now: () => NOW,
      app: () => ({ client_key: "ck", client_secret: "cs" }),
      audit: () => "unaudited",
      backend: h.mem.backend,
    });
    const outcome = await settled.publish.reconcile(params, ctx());
    expect(outcome.kind).toBe("found");
    expect(h.mem.state.item.status).toBe("published");
  });

  it("TikTok's FAILED is a definite 'nothing was published'", async () => {
    const h = harness(item(), {
      statuses: [{ status: "FAILED", fail_reason: "duration_check_failed" }],
    });
    await expect(
      h.exec.publish.execute("publish_tiktok_video", params, ctx()),
    ).rejects.toMatchObject({ retryable: false });
    expect(h.mem.state.item.status).toBe("failed");
  });

  it("no answer to init: nothing can follow it, so nothing went out — failed, and no chunk sent", async () => {
    const h = harness(item(), { initNoAnswer: true });
    await expect(
      h.exec.publish.execute("publish_tiktok_video", params, ctx()),
    ).rejects.toMatchObject({ retryable: false });
    expect(h.mem.state.item.status).toBe("failed");
    expect(h.api.calls.some((c) => c.url === UPLOAD)).toBe(false);
  });

  it("TikTok refusing an unaudited public post at init fails by name, nothing published", async () => {
    const h = harness(item(), {
      refuse: {
        "/video/init/": { status: 403, code: "unaudited_client_can_only_post_to_private_accounts" },
      },
    });
    await expect(
      h.exec.publish.execute("publish_tiktok_video", params, ctx()),
    ).rejects.toMatchObject({ retryable: false });
    expect(h.mem.state.item.status).toBe("failed");
    expect((h.mem.state.item as unknown as { last_error: string }).last_error).toMatch(
      /only lets SYB post privately.*Nothing was sent to TikTok/,
    );
  });

  it("the emergency stop between init and the last chunk puts it back in the queue, nothing sent", async () => {
    const h = harness(item());
    let checks = 0;
    const halted = async () => {
      checks += 1;
      return checks >= 2; // off before init, on before the last chunk
    };
    await expect(
      h.exec.publish.execute("publish_tiktok_video", params, ctx({ halted })),
    ).rejects.toMatchObject({ name: "StopError" });
    expect(h.mem.state.item.status).toBe("queued");
    expect(h.api.calls.some((c) => c.url === UPLOAD)).toBe(false);
  });

  it("an already-published item is returned as stored, never posted again", async () => {
    const h = harness(
      item({
        status: "published",
        platform_post_id: "v_pub",
        platform_url: null,
        publish_attempt: { started_at: "x", caption_sha256: "y", publish_id: "v_pub" },
      }),
    );
    const post = (await h.exec.publish.execute(
      "publish_tiktok_video",
      params,
      ctx(),
    )) as TikTokPublishedPost;
    expect(post.platform_post_id).toBe("v_pub");
    expect(h.api.calls.filter((c) => c.url.endsWith("/video/init/"))).toHaveLength(0);
  });
});

describe("TikTok — irreversible, said honestly", () => {
  it("captures no undo, so the engine labels and refuses it; undo itself says why", async () => {
    const h = harness(item());
    expect(await h.exec.publish.captureUndo("publish_tiktok_video", params, ctx())).toBeNull();
    await expect(h.exec.publish.undo("publish_tiktok_video", null, ctx())).rejects.toThrow(
      TIKTOK_NO_UNDO,
    );
    expect(EXECUTION_SCOPE_REGISTRY.tiktok_publish.operations[0]?.reversible).toBe(false);
  });
});

describe("TikTok — the two-hour token", () => {
  it("refreshes near expiry, stores the rotated pair, and keeps the scopes exact", async () => {
    const api = fakeTikTok();
    const exec = createTikTokExecution({
      fetch: api.fetch,
      sleep: noSleep,
      now: () => NOW,
      app: () => ({ client_key: "ck", client_secret: "cs" }),
    });
    const near = cred({ access_expires_at: NOW.getTime() + 60_000 });
    const { cred: next, changed } = await exec.calls.fresh(near, NOW);
    expect(changed).toBe(true);
    expect(next.access_token).toBe("act.new");
    expect(next.refresh_token).toBe("rft.new");
    expect(next.username).toBe("corner_cafe");
    const form = new URLSearchParams(api.calls[0]?.init.body as string);
    expect(form.get("grant_type")).toBe("refresh_token");
    // A token with an hour left is used as it is.
    expect((await exec.calls.fresh(cred(), NOW)).changed).toBe(false);
  });

  it("a refresh carrying one scope too many is refused by name", async () => {
    const exec = createTikTokExecution({
      fetch: fakeTikTok({ grantScope: "user.info.basic,video.publish,video.list,video.manage" })
        .fetch,
      sleep: noSleep,
      app: () => ({ client_key: "ck", client_secret: "cs" }),
    });
    await expect(exec.calls.fresh(cred({ access_expires_at: NOW.getTime() }), NOW)).rejects.toThrow(
      /video\.manage/,
    );
  });

  it("an expired refresh token is a sign-in TikTok no longer accepts", async () => {
    const exec = createTikTokExecution({
      fetch: fakeTikTok().fetch,
      sleep: noSleep,
      app: () => ({ client_key: "ck", client_secret: "cs" }),
    });
    await expect(
      exec.calls.fresh(cred({ access_expires_at: 0, refresh_expires_at: NOW.getTime() - 1 }), NOW),
    ).rejects.toMatchObject({
      failure: { kind: "auth", pauses: true },
    });
  });

  it("reads counts for public posts, twenty at a time, counts only", async () => {
    const api = fakeTikTok();
    const exec = createTikTokExecution({
      fetch: api.fetch,
      sleep: noSleep,
      app: () => ({ client_key: "ck", client_secret: "cs" }),
    });
    const ids = Array.from({ length: 21 }, (_, i) => String(7300000000000000000 + i));
    await exec.calls.queryVideos("act", ids);
    const q = api.calls.filter((c) => c.url.includes("/v2/video/query/"));
    expect(q).toHaveLength(2);
    expect(new URL(q[0]!.url).searchParams.get("fields")).toBe(
      "id,view_count,like_count,comment_count,share_count",
    );
    expect((q[0]!.body?.["filters"] as { video_ids: string[] }).video_ids).toHaveLength(20);
  });
});
