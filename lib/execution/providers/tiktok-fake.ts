// A fake TikTok API for tests — the recorded shapes of the Content Posting
// API, the OAuth token endpoint and video query (specs/tiktok-posting-api-v1.md).
// It never touches the network: it answers whatever the provider sends it
// and keeps a call log, so a test asserts on what was sent, not what was hoped.

import type { TikTokFetch, TikTokRequestInit } from "./tiktok";

export const FAKE_TIKTOK_UPLOAD_URL =
  "https://open-upload.tiktokapis.com/video/?upload_id=1&upload_token=t";
export const FAKE_TIKTOK_OPEN_ID = "open-id-1";
export const FAKE_TIKTOK_PUBLISH_ID = "v_pub_file~v2-1.123";

export interface FakeTikTokCall {
  url: string;
  init: TikTokRequestInit;
  body: Record<string, unknown> | null;
}

export interface FakeTikTokOptions {
  creator?: Record<string, unknown>;
  /** The error object TikTok answers a request with, by URL fragment. */
  refuse?: Record<string, { status: number; code: string }>;
  /** The last chunk lands, then its answer is lost. */
  loseLastChunk?: boolean;
  initNoAnswer?: boolean;
  /** Status answers in order, the last repeating. Raw JSON text keeps an int64 exact. */
  statuses?: (Record<string, unknown> | string)[];
  /** The scope string the token endpoint grants. */
  grantScope?: string;
  openId?: string;
  /** Raw JSON text of video query's `videos` list. */
  videos?: string;
}

export function fakeTikTok(opts: FakeTikTokOptions = {}) {
  const calls: FakeTikTokCall[] = [];
  let statusIndex = 0;
  const reply = (status: number, body: unknown) => ({
    status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  });
  const ok = (data: unknown) =>
    reply(200, { data, error: { code: "ok", message: "", log_id: "l" } });
  const fetch: TikTokFetch = async (url, init) => {
    const body =
      typeof init.body === "string" && init.headers["content-type"]?.startsWith("application/json")
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : null;
    calls.push({ url, init, body });
    for (const [frag, r] of Object.entries(opts.refuse ?? {})) {
      if (url.includes(frag)) {
        return reply(r.status, { error: { code: r.code, message: "no", log_id: "l" } });
      }
    }
    if (url.endsWith("/v2/oauth/token/")) {
      return reply(200, {
        access_token: "act.new",
        refresh_token: "rft.new",
        open_id: opts.openId ?? FAKE_TIKTOK_OPEN_ID,
        expires_in: 7200,
        refresh_expires_in: 15_552_000,
        scope: opts.grantScope ?? "user.info.basic,video.publish,video.list",
        token_type: "Bearer",
      });
    }
    if (url.endsWith("/v2/oauth/revoke/")) return reply(200, {});
    if (url.endsWith("/v2/post/publish/creator_info/query/")) {
      return ok({
        creator_username: "corner_cafe",
        creator_nickname: "Corner Café",
        privacy_level_options: ["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "SELF_ONLY"],
        comment_disabled: false,
        duet_disabled: false,
        stitch_disabled: true,
        max_video_post_duration_sec: 600,
        ...opts.creator,
      });
    }
    if (url.endsWith("/v2/post/publish/video/init/")) {
      if (opts.initNoAnswer) throw new Error("socket hang up");
      return ok({ publish_id: FAKE_TIKTOK_PUBLISH_ID, upload_url: FAKE_TIKTOK_UPLOAD_URL });
    }
    if (url === FAKE_TIKTOK_UPLOAD_URL) {
      const range = init.headers["content-range"] ?? "";
      const [, end, total] = /bytes \d+-(\d+)\/(\d+)/.exec(range) ?? [];
      const last = Number(end) + 1 === Number(total);
      if (last && opts.loseLastChunk) throw new Error("connection reset");
      return reply(last ? 201 : 206, {});
    }
    if (url.endsWith("/v2/post/publish/status/fetch/")) {
      const list = opts.statuses ?? [
        { status: "PUBLISH_COMPLETE", publicaly_available_post_id: [] },
      ];
      const s = list[Math.min(statusIndex, list.length - 1)];
      statusIndex += 1;
      if (typeof s === "string") {
        return reply(200, `{"data":${s},"error":{"code":"ok","message":"","log_id":"l"}}`);
      }
      return ok(s);
    }
    if (url.includes("/v2/video/query/")) {
      const videos =
        opts.videos ??
        '[{"id":"7300000000000000001","view_count":120,"like_count":9,"comment_count":2,"share_count":1}]';
      return reply(
        200,
        `{"data":{"videos":${videos}},"error":{"code":"ok","message":"","log_id":"l"}}`,
      );
    }
    return reply(404, { error: { code: "not_found", message: "", log_id: "l" } });
  };
  return { fetch, calls };
}
