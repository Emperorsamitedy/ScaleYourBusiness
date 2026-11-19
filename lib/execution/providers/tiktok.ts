// TikTok posting — the Content Posting API's Direct Post, through the P3-10
// engine. Owner override 2026-11-08 ("should be done by today"), lifting the
// 2026-09-30 deferral; the API facts are in specs/tiktok-posting-api-v1.md,
// each marked verified or not.
//
// One approved video, in order:
//
//   preflight (reads only, before the engine claims anything) — the item is
//     as approved (caption, media AND the TikTok settings the owner chose,
//     by hash); the connection is live; the access token is fresh (a
//     refresh rotates the refresh token, so the new pair is stored at once);
//     creator_info is read NOW, as TikTok requires before every post, and
//     the approved privacy is still one TikTok offers this account; while
//     SYB's app is unaudited, only SELF_ONLY ("only me") goes out, because
//     TikTok refuses anything else at init.
//   captureUndo — null, on purpose. TikTok's API has no delete for a post
//     (only video.manage, which also edits and deletes posts made by other
//     apps, and SYB never asks for it). The op is labelled irreversible in
//     the registry and the proposal says "hard" before approval (rule 16's
//     honest form): to take a post down, the owner deletes it in the app.
//   execute — claim (drafted|queued → publishing) BEFORE anything is sent;
//     creator_info again; the render read from SYB's own storage; init with
//     FILE_UPLOAD (PULL_FROM_URL needs a domain verified with TikTok, and
//     the render's storage domain isn't SYB's to verify); the chunks PUT to
//     TikTok's upload_url, sent_at written just before the LAST chunk —
//     the one after which TikTok starts posting; then the status polled.
//
// At most once (P3-21d, stated honestly). TikTok has no idempotency key.
// Nothing can go public before the last chunk lands, so a run that dies
// before sent_at provably sent nothing. After sent_at, a lost answer leaves
// the item `publishing`, and only a status read (by the publish_id TikTok
// gave at init) settles it: "I may have posted this — check TikTok". The
// last chunk is never sent twice.
//
// Rule 17 at the one choke point: the init body is checked before it is
// sent (tiktokDisclosureViolation) — the caption must end with the item's
// disclosure label, and `is_aigc` (TikTok's AI-generated content flag) must
// be present and true for generated media. A source-scan gate in the test
// holds the request list closed: no path or host but these, and no
// PULL_FROM_URL.
//
// No line logs a token, a code, the client secret or the upload URL.

import { createHash } from "node:crypto";
import { isDisclosed } from "../../content/disclosure";
import type { TikTokAuditStatus } from "../../env";
import { tiktokAuditStatus, tiktokPostingEnv } from "../../env";
import { ExecutionConnectionError, verifyExecutionScopes } from "../verify";
import type { ExecutionContext, ExecutionProvider, PreflightRefusal } from "./fixture";
import type { PublishItem, ReconcileOutcome } from "./meta";
import {
  PublishError,
  STOPPED_BEFORE_PUBLISH,
  StopError,
  captionHash,
  publishCaption,
} from "./meta";
import { stalePublish } from "../stale";
import { PAUSED_WORK_SENTENCE } from "../meta-errors";

export const TIKTOK_PROVIDER = "tiktok_publish" as const;
export const TIKTOK_API_ORIGIN = "https://open.tiktokapis.com";
export const TIKTOK_AUTHORIZE_URL = "https://www.tiktok.com/v2/auth/authorize/";
export const TIKTOK_MAX_ATTEMPTS = 3;
export const TIKTOK_TIMEOUT_MS = 20_000;
export const TIKTOK_UPLOAD_TIMEOUT_MS = 120_000;
/** Polls of a post's status after the last chunk — capped, with backoff to 15 s. */
export const TIKTOK_POLL_MAX = 10;
/** TikTok's caption limit (UTF-16 code units). */
export const TIKTOK_TITLE_MAX = 2200;
/** The largest render SYB uploads. TikTok takes up to 4 GB; SYB's clips are far smaller. */
export const TIKTOK_MAX_UPLOAD_BYTES = 256 * 1024 * 1024;
/** One chunk when the file is at most this; TikTok allows 5–64 MB chunks. */
export const TIKTOK_SINGLE_CHUNK_MAX = 64 * 1024 * 1024;
/** The chunk size for anything larger. The last chunk absorbs the remainder (< 128 MB). */
export const TIKTOK_CHUNK_BYTES = 10 * 1024 * 1024;
/** Refresh the access token when it has less than this left (it lives 2 hours). */
export const TIKTOK_REFRESH_MARGIN_MS = 5 * 60_000;

/**
 * Every request SYB makes to TikTok. The source-scan gate (tiktok.test.ts)
 * fails the build on any other path. The one remaining transfer is fenced
 * in code: the chunk PUT goes only to an https upload_url on a
 * tiktokapis.com host. The render itself is read through SYB's own media
 * store (the backend), never fetched from a URL here.
 */
export const TIKTOK_REQUESTS = {
  token: { method: "POST", path: "/v2/oauth/token/", scopes: [] },
  revoke: { method: "POST", path: "/v2/oauth/revoke/", scopes: [] },
  creator_info: {
    method: "POST",
    path: "/v2/post/publish/creator_info/query/",
    scopes: ["video.publish"],
  },
  video_init: { method: "POST", path: "/v2/post/publish/video/init/", scopes: ["video.publish"] },
  status_fetch: {
    method: "POST",
    path: "/v2/post/publish/status/fetch/",
    scopes: ["video.publish"],
  },
  video_query: { method: "POST", path: "/v2/video/query/", scopes: ["video.list"] },
} as const satisfies Record<string, { method: "POST"; path: string; scopes: readonly string[] }>;

export type TikTokRequest = keyof typeof TIKTOK_REQUESTS;

/* ── transport ─────────────────────────────────────────────────────── */

export interface TikTokRequestInit {
  method: "POST" | "PUT";
  headers: Record<string, string>;
  body?: string | Uint8Array;
  signal?: AbortSignal;
}

export interface TikTokResponse {
  status: number;
  text(): Promise<string>;
}

/**
 * Pure: TikTok's JSON, with every integer too long for a JS number kept as
 * a string. Post ids are int64 (publicaly_available_post_id): JSON.parse
 * alone would round 7300000000000000001 to 7300000000000000000 — a wrong
 * post id, stored forever. Found by this module's own test.
 */
export function parseTikTokJson(text: string): unknown {
  return JSON.parse(text.replace(/([:[,]\s*)(-?\d{16,})(?=\s*[,\]}])/g, '$1"$2"'));
}

export type TikTokFetch = (url: string, init: TikTokRequestInit) => Promise<TikTokResponse>;

export interface TikTokApp {
  client_key: string;
  client_secret: string;
}

interface Context {
  fetch: TikTokFetch;
  sleep: (ms: number) => Promise<void>;
  app: () => TikTokApp | null;
  audit: () => TikTokAuditStatus;
}

const defaultFetch: TikTokFetch = (url, init) =>
  fetch(url, {
    method: init.method,
    headers: init.headers,
    ...(init.body !== undefined ? { body: init.body as BodyInit } : {}),
    signal: init.signal ?? AbortSignal.timeout(TIKTOK_TIMEOUT_MS),
    redirect: "error",
  });

function backoffMs(attempt: number): number {
  return Math.min(1000 * 2 ** (attempt - 1), 15_000);
}

/* ── failures ──────────────────────────────────────────────────────── */

export type TikTokFailureKind =
  | "auth"
  | "scope"
  | "rate_limit"
  | "posting_limit"
  | "app_cap"
  | "banned"
  | "unaudited"
  | "privacy"
  | "invalid"
  | "unavailable"
  | "unknown";

export interface TikTokFailure {
  kind: TikTokFailureKind;
  /** TikTok's own error code (`error.code`, or the OAuth `error`), verbatim. */
  code: string | null;
  http_status: number;
  owner_sentence: string;
  /** Worth another attempt later — never true for anything the owner must fix. */
  retryable: boolean;
  /** The sign-in no longer works: the connection pauses until the owner reconnects. */
  pauses: boolean;
}

const RECONNECT = "Reconnect TikTok on Connections.";

/** Pure: one TikTok refusal, said once, for every screen and log line. */
export function classifyTikTokError(httpStatus: number, code: string | null): TikTokFailure {
  const f = (
    kind: TikTokFailureKind,
    owner_sentence: string,
    retryable: boolean,
    pauses = false,
  ): TikTokFailure => ({ kind, code, http_status: httpStatus, owner_sentence, retryable, pauses });
  switch (code) {
    case "access_token_invalid":
    case "invalid_grant":
    case "token_not_authorized_for_specified_publish_id":
      return f("auth", `TikTok no longer accepts ScaleX's sign-in. ${RECONNECT}`, false, true);
    case "scope_not_authorized":
      return f(
        "scope",
        `TikTok says the account no longer allows ScaleX to post. ${RECONNECT}`,
        false,
        true,
      );
    case "rate_limit_exceeded":
      return f(
        "rate_limit",
        "TikTok asked ScaleX to slow down. It goes out on the next run.",
        true,
      );
    case "spam_risk_too_many_posts":
      return f(
        "posting_limit",
        "TikTok's daily limit on posts for this account is used up. It goes out on the next run.",
        true,
      );
    case "reached_active_user_cap":
      return f(
        "app_cap",
        "TikTok's daily limit on accounts ScaleX's app may post for is used up. It goes out on the next run.",
        true,
      );
    case "spam_risk_user_banned_from_posting":
      return f("banned", "TikTok says this account can't post right now.", false);
    case "unaudited_client_can_only_post_to_private_accounts":
      return f(
        "unaudited",
        "TikTok only lets ScaleX post privately (only you can see it) until it has audited ScaleX's app.",
        false,
      );
    case "privacy_level_option_mismatch":
      return f(
        "privacy",
        "TikTok no longer offers the privacy you chose for this account. Choose it again on Content.",
        false,
      );
    case "invalid_param":
    case "invalid_request":
      return f("invalid", "TikTok refused the request as it was sent.", false);
    default:
      break;
  }
  if (httpStatus === 401) {
    return f("auth", `TikTok no longer accepts ScaleX's sign-in. ${RECONNECT}`, false, true);
  }
  if (httpStatus === 429)
    return f("rate_limit", "TikTok asked ScaleX to slow down. It goes out on the next run.", true);
  if (httpStatus === 0 || httpStatus >= 500) {
    return f("unavailable", "TikTok didn't answer properly. It goes out on the next run.", true);
  }
  return f("unknown", `TikTok refused with ${code ?? `status ${httpStatus}`}.`, false);
}

/**
 * The connection paused itself (its sign-in stopped working) before
 * anything was sent: the engine journals the run held "reconnect", and it
 * runs again — through every guard — once TikTok posting is reconnected.
 */
export class TikTokPausedError extends Error {
  readonly retryable = false;
  readonly held_for = "reconnect" as const;
  constructor() {
    super(PAUSED_WORK_SENTENCE.publish);
    this.name = "TikTokPausedError";
  }
}

export class TikTokRequestError extends ExecutionConnectionError {
  readonly failure: TikTokFailure;
  readonly request: string;
  constructor(request: string, failure: TikTokFailure) {
    super(failure.owner_sentence, failure.pauses ? 401 : 502);
    this.name = "TikTokRequestError";
    this.failure = failure;
    this.request = request;
  }
}

/** A request that never got an answer — for a call that must not be repeated. */
export class TikTokNoAnswerError extends Error {
  constructor(readonly request: string) {
    super(`TikTok didn't answer ${request}`);
    this.name = "TikTokNoAnswerError";
  }
}

/** Rule 17: an init body that would go out undisclosed. Never sent. */
export class UndisclosedTikTokPostError extends Error {
  constructor(reason: string) {
    super(`refusing to post to TikTok without its AI disclosure: ${reason}: nothing was sent`);
    this.name = "UndisclosedTikTokPostError";
  }
}

/* ── the API call ──────────────────────────────────────────────────── */

interface CallArgs {
  bearer?: string;
  /** Form body (the OAuth endpoints). */
  form?: Record<string, string>;
  /** JSON body (every Content Posting API call). */
  json?: unknown;
  query?: Record<string, string>;
  /** False for a call that must never be repeated (video_init): no retry, no-answer thrown. */
  repeatable?: boolean;
  account_id?: string | null;
}

function codeOf(body: Record<string, unknown>): string | null {
  const e = body["error"];
  if (typeof e === "string") return e; // the OAuth endpoints: { error, error_description }
  if (e && typeof e === "object") {
    const c = (e as { code?: unknown }).code;
    return typeof c === "string" ? c : null;
  }
  return null;
}

async function tiktokCall(
  ctx: Context,
  which: TikTokRequest,
  args: CallArgs,
): Promise<Record<string, unknown>> {
  const spec = TIKTOK_REQUESTS[which];
  const query = args.query ? `?${new URLSearchParams(args.query).toString()}` : "";
  const url = `${TIKTOK_API_ORIGIN}${spec.path}${query}`;
  const headers: Record<string, string> = { accept: "application/json" };
  if (args.bearer) headers["authorization"] = `Bearer ${args.bearer}`;
  let body: string | undefined;
  if (args.form) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(args.form).toString();
  } else if (args.json !== undefined) {
    if (which === "video_init") {
      const violation = tiktokDisclosureViolation(args.json);
      if (violation !== null) throw new UndisclosedTikTokPostError(violation);
    }
    headers["content-type"] = "application/json; charset=UTF-8";
    // The plan's own check field never leaves SYB.
    const sent = { ...((args.json ?? {}) as Record<string, unknown>) };
    delete sent["_expect_aigc"];
    body = JSON.stringify(sent);
  }
  const repeatable = args.repeatable !== false;
  for (let attempt = 1; ; attempt += 1) {
    let response: TikTokResponse;
    try {
      response = await ctx.fetch(url, {
        method: spec.method,
        headers,
        ...(body !== undefined ? { body } : {}),
      });
    } catch {
      if (!repeatable) throw new TikTokNoAnswerError(which);
      if (attempt >= TIKTOK_MAX_ATTEMPTS) {
        throw new TikTokRequestError(which, classifyTikTokError(0, null));
      }
      await ctx.sleep(backoffMs(attempt));
      continue;
    }
    let parsed: Record<string, unknown> | null;
    try {
      parsed = parseTikTokJson(await response.text()) as Record<string, unknown> | null;
    } catch {
      parsed = null;
    }
    const payload = parsed && typeof parsed === "object" ? parsed : {};
    const code = codeOf(payload);
    const ok = response.status >= 200 && response.status < 300 && (code === null || code === "ok");
    if (ok) return payload;
    const failure = classifyTikTokError(response.status, code);
    console.warn(
      JSON.stringify({
        event: "tiktok_refused",
        account_id: args.account_id ?? null,
        request: which,
        http_status: response.status,
        code,
        kind: failure.kind,
      }),
    );
    // Only a repeatable call is retried, and only for a transient refusal.
    if (
      repeatable &&
      (failure.kind === "unavailable" || failure.kind === "rate_limit") &&
      attempt < TIKTOK_MAX_ATTEMPTS
    ) {
      await ctx.sleep(backoffMs(attempt));
      continue;
    }
    throw new TikTokRequestError(which, failure);
  }
}

function dataOf(body: Record<string, unknown>): Record<string, unknown> {
  const d = body["data"];
  return d && typeof d === "object" ? (d as Record<string, unknown>) : {};
}

/* ── rule 17 ───────────────────────────────────────────────────────── */

/**
 * Pure: why an init body may not go, or null. The caption (`title`) must end
 * with a disclosure label; `is_aigc` must be present as a boolean, and true
 * whenever the plan says the media is generated (`_expect_aigc`, removed
 * before sending). Only FILE_UPLOAD is ever sent.
 */
export function tiktokDisclosureViolation(body: unknown): string | null {
  const b = (body ?? {}) as {
    post_info?: { title?: unknown; is_aigc?: unknown };
    source_info?: { source?: unknown };
    _expect_aigc?: unknown;
  };
  const title = b.post_info?.title;
  if (typeof title !== "string" || !isDisclosed(title)) {
    return "the caption doesn't end with its disclosure label";
  }
  if (typeof b.post_info?.is_aigc !== "boolean") return "is_aigc is missing";
  if (b._expect_aigc === true && b.post_info.is_aigc !== true) {
    return "generated media without is_aigc";
  }
  if (b.source_info?.source !== "FILE_UPLOAD") return "only FILE_UPLOAD is sent";
  return null;
}

/* ── the credential ────────────────────────────────────────────────── */

/** What the encrypted secret of a tiktok_publish connection holds. */
export interface TikTokCredential {
  v: 1;
  open_id: string;
  access_token: string;
  refresh_token: string;
  /** Epoch ms. */
  access_expires_at: number;
  refresh_expires_at: number;
  /** As TikTok last reported them (comma-separated there). */
  scopes: string[];
  username: string | null;
  nickname: string | null;
}

export function parseTikTokCredential(plain: string): TikTokCredential {
  let s: Record<string, unknown>;
  try {
    s = JSON.parse(plain) as Record<string, unknown>;
  } catch {
    throw new ExecutionConnectionError("the stored TikTok sign-in couldn't be read", 409);
  }
  const str = (k: string) => typeof s[k] === "string" && s[k] !== "";
  const num = (k: string) => typeof s[k] === "number" && Number.isFinite(s[k]);
  if (
    s["v"] !== 1 ||
    !str("open_id") ||
    !str("access_token") ||
    !str("refresh_token") ||
    !num("access_expires_at") ||
    !num("refresh_expires_at") ||
    !Array.isArray(s["scopes"])
  ) {
    throw new ExecutionConnectionError("the stored TikTok sign-in couldn't be read", 409);
  }
  return {
    v: 1,
    open_id: s["open_id"] as string,
    access_token: s["access_token"] as string,
    refresh_token: s["refresh_token"] as string,
    access_expires_at: s["access_expires_at"] as number,
    refresh_expires_at: s["refresh_expires_at"] as number,
    scopes: (s["scopes"] as unknown[]).filter((x): x is string => typeof x === "string"),
    username: typeof s["username"] === "string" ? s["username"] : null,
    nickname: typeof s["nickname"] === "string" ? s["nickname"] : null,
  };
}

/** Pure: TikTok's comma-separated scope string as a sorted list. */
export function scopeList(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  return [
    ...new Set(
      raw
        .split(/[,\s]+/)
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ].sort();
}

export interface TikTokGrant {
  open_id: string;
  access_token: string;
  refresh_token: string;
  expires_in: number;
  refresh_expires_in: number;
  scopes: string[];
}

function grantOf(body: Record<string, unknown>): TikTokGrant {
  const str = (k: string) => (typeof body[k] === "string" ? (body[k] as string) : "");
  const num = (k: string) => (typeof body[k] === "number" ? (body[k] as number) : 0);
  const grant = {
    open_id: str("open_id"),
    access_token: str("access_token"),
    refresh_token: str("refresh_token"),
    expires_in: num("expires_in"),
    refresh_expires_in: num("refresh_expires_in"),
    scopes: scopeList(body["scope"]),
  };
  if (grant.open_id === "" || grant.access_token === "" || grant.refresh_token === "") {
    throw new TikTokRequestError("token", classifyTikTokError(200, "invalid_grant"));
  }
  return grant;
}

export function credentialFromGrant(
  grant: TikTokGrant,
  now: Date,
  who: { username: string | null; nickname: string | null },
): TikTokCredential {
  return {
    v: 1,
    open_id: grant.open_id,
    access_token: grant.access_token,
    refresh_token: grant.refresh_token,
    access_expires_at: now.getTime() + grant.expires_in * 1000,
    refresh_expires_at: now.getTime() + grant.refresh_expires_in * 1000,
    scopes: grant.scopes,
    username: who.username,
    nickname: who.nickname,
  };
}

/* ── creator info ──────────────────────────────────────────────────── */

export const TIKTOK_PRIVACY_LEVELS = [
  "PUBLIC_TO_EVERYONE",
  "MUTUAL_FOLLOW_FRIENDS",
  "FOLLOWER_OF_CREATOR",
  "SELF_ONLY",
] as const;
export type TikTokPrivacy = (typeof TIKTOK_PRIVACY_LEVELS)[number];

export function isTikTokPrivacy(v: unknown): v is TikTokPrivacy {
  return typeof v === "string" && (TIKTOK_PRIVACY_LEVELS as readonly string[]).includes(v);
}

export interface TikTokCreatorInfo {
  username: string | null;
  nickname: string | null;
  privacy_level_options: TikTokPrivacy[];
  comment_disabled: boolean;
  duet_disabled: boolean;
  stitch_disabled: boolean;
  max_video_post_duration_sec: number | null;
}

function creatorOf(body: Record<string, unknown>): TikTokCreatorInfo {
  const d = dataOf(body);
  const opts = Array.isArray(d["privacy_level_options"]) ? d["privacy_level_options"] : [];
  return {
    username: typeof d["creator_username"] === "string" ? d["creator_username"] : null,
    nickname: typeof d["creator_nickname"] === "string" ? d["creator_nickname"] : null,
    privacy_level_options: opts.filter(isTikTokPrivacy),
    comment_disabled: d["comment_disabled"] === true,
    duet_disabled: d["duet_disabled"] === true,
    stitch_disabled: d["stitch_disabled"] === true,
    max_video_post_duration_sec:
      typeof d["max_video_post_duration_sec"] === "number"
        ? d["max_video_post_duration_sec"]
        : null,
  };
}

/**
 * Pure: the privacy levels SYB offers the owner. While SYB's app is
 * unaudited TikTok posts privately only, so only SELF_ONLY — and only if
 * TikTok offers it to this account.
 */
export function offeredPrivacy(
  creator: Pick<TikTokCreatorInfo, "privacy_level_options">,
  audit: TikTokAuditStatus,
): TikTokPrivacy[] {
  return audit === "audited"
    ? [...creator.privacy_level_options]
    : creator.privacy_level_options.filter((p) => p === "SELF_ONLY");
}

/* ── the owner's per-post settings ─────────────────────────────────── */

/**
 * What the owner chose for one post on /content, before approving it —
 * TikTok's posting rules: privacy picked by hand from creator_info's
 * options (no default), comments, duets and stitches off unless turned on,
 * and the commercial-content disclosure off unless turned on. Held on
 * content_items.tiktok_settings (migration 0093) and covered by the
 * approval's hash, so what goes out is what was approved.
 */
export interface TikTokPostSettings {
  privacy_level: TikTokPrivacy;
  allow_comment: boolean;
  allow_duet: boolean;
  allow_stitch: boolean;
  /** "Your brand": the post promotes the owner's own business (TikTok's brand_organic_toggle). */
  brand_organic: boolean;
}

export function parseTikTokSettings(raw: unknown): TikTokPostSettings | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!isTikTokPrivacy(r["privacy_level"])) return null;
  const flag = (k: string) => r[k] === true;
  return {
    privacy_level: r["privacy_level"],
    allow_comment: flag("allow_comment"),
    allow_duet: flag("allow_duet"),
    allow_stitch: flag("allow_stitch"),
    brand_organic: flag("brand_organic"),
  };
}

/**
 * Pure: what the owner approved for a TikTok post, as one hash — the caption
 * exactly as it goes out, the media URL, and the settings. Written at
 * approval (content_items.publish_approved_sha256) and checked before
 * anything is sent.
 */
export function approvedTikTokHash(item: {
  body: string;
  disclosure: string;
  media_path: string | null;
  tiktok_settings: unknown;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        v: 1,
        platform: "tiktok",
        caption: publishCaption(item),
        media: item.media_path ?? null,
        settings: parseTikTokSettings(item.tiktok_settings),
      }),
    )
    .digest("hex");
}

/* ── the publish path's state ──────────────────────────────────────── */

export interface TikTokPublishAttempt {
  started_at: string;
  caption_sha256: string;
  /** Set just BEFORE the last chunk — after it, TikTok starts posting. Absent = never sent. */
  sent_at?: string;
  /** TikTok's id for this publish, from init: what a status read settles it by. */
  publish_id?: string;
}

export interface TikTokPublishItem extends Omit<PublishItem, "publish_attempt"> {
  publish_attempt: TikTokPublishAttempt | null;
  tiktok_settings: TikTokPostSettings | null;
  /** Rule 17: the media was generated (provenance.media.is_ai_generated). */
  is_ai_generated: boolean;
}

export interface TikTokPublishedPost {
  platform: "tiktok";
  /** TikTok's public post id once it gives one; until then its publish_id. */
  platform_post_id: string;
  url: string | null;
  publish_id: string;
  /** True when platform_post_id is the public post id (readable for counts). */
  public_post: boolean;
}

/** The database behind the TikTok executor (lib/content/tiktok-publish.ts). */
export interface TikTokPublishBackend {
  item(itemId: string, profileId: string): Promise<TikTokPublishItem | null>;
  credential(
    accountId: string,
  ): Promise<{ connection_id: string; credential: TikTokCredential } | { refused: string }>;
  /**
   * Optional: the live credential, refreshed through `fresh` and stored, one
   * caller at a time (the database backend locks the row). When present it
   * replaces credential() + fresh + storeCredential, so two runs never spend
   * the same rotating refresh token (review 2026-11-08).
   */
  freshCredential?(
    accountId: string,
    fresh: TikTokCalls["fresh"],
    now: Date,
  ): Promise<{ id: string; credential: TikTokCredential } | { refused: string }>;
  /** A refresh rotated the tokens: the new pair replaces the old, encrypted, at once. */
  storeCredential(accountId: string, connectionId: string, cred: TikTokCredential): Promise<void>;
  claim(
    itemId: string,
    executionId: string | null,
    attempt: TikTokPublishAttempt,
  ): Promise<boolean>;
  /** The render's bytes from SYB's own media store, at most `maxBytes`. */
  readMedia(url: string, maxBytes: number): Promise<Uint8Array>;
  note(itemId: string, attempt: TikTokPublishAttempt): Promise<void>;
  published(item: TikTokPublishItem, post: TikTokPublishedPost, accountId: string): Promise<void>;
  failed(itemId: string, sentence: string): Promise<void>;
  uncertain(itemId: string, sentence: string): Promise<void>;
  deferred(itemId: string, sentence: string): Promise<void>;
  /**
   * The sign-in stopped working: the connection pauses until the owner
   * reconnects, and every queued TikTok post on the account is held for it.
   */
  paused(accountId: string, sentence: string): Promise<void>;
  unclaim(itemId: string, sentence: string): Promise<void>;
  lapsed(itemId: string, sentence: string, accountId: string): Promise<void>;
}

export const TIKTOK_MAY_HAVE_POSTED =
  "I may have posted this: check TikTok. TikTok didn't confirm it, and I won't post it again.";
export const TIKTOK_STILL_PROCESSING =
  "TikTok is still processing this post. I'll check again on the next run, and I won't post it again.";
export const TIKTOK_NOT_AS_APPROVED =
  "What would go out isn't what you approved: the caption, the video or the TikTok settings changed after you approved it. Nothing was sent; it needs approving again.";
export const TIKTOK_NO_UNDO =
  "TikTok doesn't let apps delete a post, so ScaleX can't take this down. Delete it in the TikTok app if you want it gone.";
export const TIKTOK_NO_SETTINGS =
  "Choose who can see this on TikTok first, on Content. Nothing was sent.";

const NOTHING_SENT = "Nothing was sent to TikTok.";

/** TikTok's fail_reason, in the owner's words. Nothing went out in any of these. */
export function failReasonSentence(reason: string | null): string {
  const said: Record<string, string> = {
    file_format_check_failed: "TikTok couldn't read the video's format.",
    duration_check_failed: "The video is longer or shorter than TikTok allows for this account.",
    frame_rate_check_failed: "TikTok doesn't take the video's frame rate.",
    picture_size_check_failed: "TikTok doesn't take the video's picture size.",
    internal: "TikTok had a problem of its own.",
    video_pull_failed: "TikTok couldn't fetch the video.",
    publish_cancelled: "The post was cancelled.",
    auth_removed: "The TikTok account took ScaleX's access away while it was posting.",
    spam_risk_too_many_posts: "TikTok's daily limit on posts for this account was reached.",
    spam_risk_user_banned_from_posting: "TikTok says this account can't post right now.",
    spam_risk_text: "TikTok flagged the caption.",
    spam_risk: "TikTok flagged the post.",
  };
  const why = (reason && said[reason]) ?? `TikTok said it failed${reason ? ` (${reason})` : ""}.`;
  return `${why} Nothing was published.`;
}

interface PublishParams {
  item_id: string;
  open_id: string;
}

function publishParams(params: Record<string, unknown>): PublishParams {
  const itemId = params["item_id"];
  const platform = params["platform"];
  const target = params["target"] as Record<string, unknown> | null | undefined;
  if (typeof itemId !== "string" || platform !== "tiktok") {
    throw new PublishError("the publish plan names no item for TikTok: nothing was sent");
  }
  const openId = target?.["open_id"];
  if (typeof openId !== "string" || openId === "") {
    throw new PublishError("the publish plan names no TikTok account: nothing was sent");
  }
  return { item_id: itemId, open_id: openId };
}

/** Pure: the media URL may be read for upload — https, a video by its extension. */
export function uploadableMedia(url: string | null): boolean {
  if (url === null) return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && /\.(mp4|mov|webm)$/i.test(u.pathname);
  } catch {
    return false;
  }
}

/** Pure: TikTok's upload_url may receive the bytes — https, on a tiktokapis.com host. */
export function uploadTargetAllowed(url: unknown): url is string {
  if (typeof url !== "string") return false;
  try {
    const u = new URL(url);
    return (
      u.protocol === "https:" &&
      (u.hostname === "tiktokapis.com" || u.hostname.endsWith(".tiktokapis.com"))
    );
  } catch {
    return false;
  }
}

/** Pure: how a file of `size` bytes is cut, by TikTok's chunk rules. */
export function chunkPlan(size: number): {
  chunk_size: number;
  total_chunk_count: number;
  ranges: [number, number][];
} {
  if (!Number.isInteger(size) || size <= 0) throw new PublishError("the video is empty");
  if (size <= TIKTOK_SINGLE_CHUNK_MAX) {
    return { chunk_size: size, total_chunk_count: 1, ranges: [[0, size - 1]] };
  }
  const count = Math.floor(size / TIKTOK_CHUNK_BYTES);
  const ranges: [number, number][] = [];
  for (let i = 0; i < count; i += 1) {
    const start = i * TIKTOK_CHUNK_BYTES;
    const end = i === count - 1 ? size - 1 : start + TIKTOK_CHUNK_BYTES - 1;
    ranges.push([start, end]);
  }
  return { chunk_size: TIKTOK_CHUNK_BYTES, total_chunk_count: count, ranges };
}

function mimeOf(url: string): string {
  const p = new URL(url).pathname.toLowerCase();
  if (p.endsWith(".mov")) return "video/quicktime";
  if (p.endsWith(".webm")) return "video/webm";
  return "video/mp4";
}

/** The public link to a post, when TikTok has given its id and the account's handle is known. */
export function tiktokPostUrl(username: string | null, postId: string | null): string | null {
  if (!username || !postId || !/^\d+$/.test(postId)) return null;
  return `https://www.tiktok.com/@${encodeURIComponent(username)}/video/${postId}`;
}

type StatusRead =
  | { kind: "complete"; post_id: string | null }
  | { kind: "failed"; reason: string | null }
  | { kind: "processing" };

function statusOf(body: Record<string, unknown>): StatusRead {
  const d = dataOf(body);
  const status = d["status"];
  if (status === "PUBLISH_COMPLETE") {
    const ids = d["publicaly_available_post_id"];
    const first = Array.isArray(ids) ? ids[0] : undefined;
    const id =
      typeof first === "number" || typeof first === "string" ? String(first) : (null as null);
    return { kind: "complete", post_id: id };
  }
  if (status === "FAILED") {
    return {
      kind: "failed",
      reason: typeof d["fail_reason"] === "string" ? d["fail_reason"] : null,
    };
  }
  return { kind: "processing" };
}

/* ── the calls the sign-in, the screen and the readback use ────────── */

export interface TikTokCalls {
  exchangeCode(code: string, redirectUri: string): Promise<TikTokGrant>;
  refresh(refreshToken: string): Promise<TikTokGrant>;
  revoke(accessToken: string): Promise<void>;
  creatorInfo(accessToken: string, accountId?: string | null): Promise<TikTokCreatorInfo>;
  /** A publish's status by its publish_id (reads only). */
  status(accessToken: string, publishId: string, accountId?: string | null): Promise<StatusRead>;
  /** Public counts for up to 20 of the account's own posts (video.list). */
  queryVideos(
    accessToken: string,
    postIds: readonly string[],
    accountId?: string | null,
  ): Promise<TikTokVideoCounts[]>;
  /**
   * The credential with an access token good for a while yet, refreshed and
   * scope-checked when it was close to expiry. `changed` = the caller stores it.
   */
  fresh(cred: TikTokCredential, now: Date): Promise<{ cred: TikTokCredential; changed: boolean }>;
}

export interface TikTokVideoCounts {
  id: string;
  view_count: number | null;
  like_count: number | null;
  comment_count: number | null;
  share_count: number | null;
}

/** The fields video_query asks for: counts only. */
export const TIKTOK_VIDEO_FIELDS = [
  "id",
  "view_count",
  "like_count",
  "comment_count",
  "share_count",
];

function requireApp(ctx: Context): TikTokApp {
  const app = ctx.app();
  if (app === null) {
    throw new ExecutionConnectionError("TikTok posting isn't set up yet.", 503);
  }
  return app;
}

function countOf(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : null;
}

function tiktokCalls(ctx: Context): TikTokCalls {
  const calls: TikTokCalls = {
    async exchangeCode(code, redirectUri) {
      const app = requireApp(ctx);
      const body = await tiktokCall(ctx, "token", {
        form: {
          client_key: app.client_key,
          client_secret: app.client_secret,
          code,
          grant_type: "authorization_code",
          redirect_uri: redirectUri,
        },
        // A code is single use: an exchange is never sent twice.
        repeatable: false,
      });
      return grantOf(body);
    },
    async refresh(refreshToken) {
      const app = requireApp(ctx);
      const body = await tiktokCall(ctx, "token", {
        form: {
          client_key: app.client_key,
          client_secret: app.client_secret,
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        },
        // Refresh tokens rotate: a refresh whose answer was lost may have
        // spent the old one, so it is never repeated blindly.
        repeatable: false,
      });
      return grantOf(body);
    },
    async revoke(accessToken) {
      const app = requireApp(ctx);
      await tiktokCall(ctx, "revoke", {
        form: { client_key: app.client_key, client_secret: app.client_secret, token: accessToken },
      });
    },
    async creatorInfo(accessToken, accountId) {
      const body = await tiktokCall(ctx, "creator_info", {
        bearer: accessToken,
        json: {},
        account_id: accountId ?? null,
      });
      return creatorOf(body);
    },
    async status(accessToken, publishId, accountId) {
      const body = await tiktokCall(ctx, "status_fetch", {
        bearer: accessToken,
        json: { publish_id: publishId },
        account_id: accountId ?? null,
      });
      return statusOf(body);
    },
    async queryVideos(accessToken, postIds, accountId) {
      if (postIds.length === 0) return [];
      const out: TikTokVideoCounts[] = [];
      for (let i = 0; i < postIds.length; i += 20) {
        const body = await tiktokCall(ctx, "video_query", {
          bearer: accessToken,
          query: { fields: TIKTOK_VIDEO_FIELDS.join(",") },
          json: { filters: { video_ids: postIds.slice(i, i + 20) } },
          account_id: accountId ?? null,
        });
        const videos = dataOf(body)["videos"];
        for (const v of Array.isArray(videos) ? videos : []) {
          const r = (v ?? {}) as Record<string, unknown>;
          const id =
            typeof r["id"] === "string" || typeof r["id"] === "number" ? String(r["id"]) : null;
          if (id === null) continue;
          out.push({
            id,
            view_count: countOf(r["view_count"]),
            like_count: countOf(r["like_count"]),
            comment_count: countOf(r["comment_count"]),
            share_count: countOf(r["share_count"]),
          });
        }
      }
      return out;
    },
    async fresh(cred, now) {
      if (cred.access_expires_at - now.getTime() > TIKTOK_REFRESH_MARGIN_MS) {
        return { cred, changed: false };
      }
      if (cred.refresh_expires_at <= now.getTime()) {
        throw new TikTokRequestError("token", classifyTikTokError(401, "invalid_grant"));
      }
      const grant = await calls.refresh(cred.refresh_token);
      if (grant.open_id !== cred.open_id) {
        throw new TikTokRequestError("token", classifyTikTokError(401, "invalid_grant"));
      }
      // The grant must still be exactly the consent's scopes (rule 13).
      verifyExecutionScopes(TIKTOK_PROVIDER, grant.scopes);
      return {
        cred: credentialFromGrant(grant, now, { username: cred.username, nickname: cred.nickname }),
        changed: true,
      };
    },
  };
  return calls;
}

/* ── the executor ──────────────────────────────────────────────────── */

export interface TikTokPublishProvider extends ExecutionProvider {
  /** Read back a `publishing` item by its publish_id and record what is found. Never posts. */
  reconcile(params: Record<string, unknown>, ctx: ExecutionContext): Promise<ReconcileOutcome>;
}

function logPublish(event: Record<string, unknown>): void {
  console.log(JSON.stringify({ event: "content_publish", platform: "tiktok", ...event }));
}

function asApproved(item: TikTokPublishItem): boolean {
  return (
    item.publish_approved_sha256 !== null &&
    item.publish_approved_sha256 === approvedTikTokHash(item)
  );
}

function publishProvider(
  ctx: Context,
  calls: TikTokCalls,
  loadBackend: () => Promise<TikTokPublishBackend>,
  now: () => Date,
): TikTokPublishProvider {
  /** The live credential, fresh, for the approved account — or a PublishError naming why not. */
  async function liveCredential(
    b: TikTokPublishBackend,
    accountId: string,
    openId: string,
  ): Promise<TikTokCredential> {
    const wrong = () =>
      new PublishError(
        "You approved this for a different TikTok account than the one connected now. Nothing was sent; it needs approving again.",
      );
    if (b.freshCredential) {
      const got = await b.freshCredential(accountId, calls.fresh, now());
      if ("refused" in got) throw new PublishError(got.refused);
      if (got.credential.open_id !== openId) throw wrong();
      return got.credential;
    }
    const got = await b.credential(accountId);
    if ("refused" in got) throw new PublishError(got.refused);
    if (got.credential.open_id !== openId) throw wrong();
    const { cred, changed } = await calls.fresh(got.credential, now());
    if (changed) await b.storeCredential(accountId, got.connection_id, cred);
    return cred;
  }

  /** Pure-ish: the settings the owner approved, still possible on this account now. */
  function checkSettings(
    item: TikTokPublishItem,
    creator: TikTokCreatorInfo,
  ): { settings: TikTokPostSettings } | { refuse: string } {
    const settings = item.tiktok_settings;
    if (settings === null) return { refuse: TIKTOK_NO_SETTINGS };
    if (ctx.audit() !== "audited" && settings.privacy_level !== "SELF_ONLY") {
      return {
        refuse: `${classifyTikTokError(403, "unaudited_client_can_only_post_to_private_accounts").owner_sentence} Choose "Only me" on Content and approve it again. ${NOTHING_SENT}`,
      };
    }
    if (!creator.privacy_level_options.includes(settings.privacy_level)) {
      return {
        refuse: `${classifyTikTokError(403, "privacy_level_option_mismatch").owner_sentence} ${NOTHING_SENT}`,
      };
    }
    return { settings };
  }

  async function readBack(
    b: TikTokPublishBackend,
    item: TikTokPublishItem,
    cred: TikTokCredential,
    accountId: string,
  ): Promise<ReconcileOutcome> {
    const attempt = item.publish_attempt;
    if (!attempt?.sent_at) {
      return {
        kind: "not_sent",
        sentence: `The run stopped before the video reached TikTok. Nothing was published.`,
      };
    }
    if (!attempt.publish_id) return { kind: "uncertain", sentence: TIKTOK_MAY_HAVE_POSTED };
    let read: StatusRead;
    try {
      read = await calls.status(cred.access_token, attempt.publish_id, accountId);
    } catch {
      return { kind: "uncertain", sentence: TIKTOK_MAY_HAVE_POSTED };
    }
    if (read.kind === "complete") {
      const post = postOf(cred, attempt.publish_id, read.post_id);
      return { kind: "found", post: post as never };
    }
    if (read.kind === "failed")
      return { kind: "not_sent", sentence: failReasonSentence(read.reason) };
    return { kind: "uncertain", sentence: TIKTOK_STILL_PROCESSING };
  }

  function postOf(
    cred: TikTokCredential,
    publishId: string,
    postId: string | null,
  ): TikTokPublishedPost {
    return {
      platform: "tiktok",
      platform_post_id: postId ?? publishId,
      url: tiktokPostUrl(cred.username, postId),
      publish_id: publishId,
      public_post: postId !== null,
    };
  }

  async function settle(
    b: TikTokPublishBackend,
    outcome: ReconcileOutcome,
    item: TikTokPublishItem,
    accountId: string,
  ): Promise<TikTokPublishedPost> {
    logPublish({
      account_id: accountId,
      item_id: item.id,
      phase: "reconcile",
      outcome: outcome.kind,
    });
    if (outcome.kind === "found") {
      const post = outcome.post as unknown as TikTokPublishedPost;
      await b.published(item, post, accountId);
      return post;
    }
    if (outcome.kind === "not_sent") await b.failed(item.id, outcome.sentence);
    else await b.uncertain(item.id, outcome.sentence);
    throw new PublishError(outcome.sentence, outcome.kind === "uncertain");
  }

  async function readMedia(b: TikTokPublishBackend, url: string): Promise<Uint8Array> {
    if (!uploadableMedia(url)) throw new PublishError("This item has no video TikTok can take.");
    let bytes: Uint8Array;
    try {
      // Through SYB's own media store, capped: never a fetch of an arbitrary URL.
      bytes = await b.readMedia(url, TIKTOK_MAX_UPLOAD_BYTES);
    } catch {
      throw new PublishError(
        "ScaleX couldn't read the video from its own storage, or it is larger than ScaleX uploads to TikTok. Nothing was sent.",
      );
    }
    if (bytes.byteLength === 0) throw new PublishError("The video is empty. Nothing was sent.");
    return bytes;
  }

  /** One chunk to TikTok's upload_url. Returns the HTTP status; a lost answer throws. */
  async function putChunk(
    uploadUrl: string,
    bytes: Uint8Array,
    range: [number, number],
    mime: string,
  ): Promise<number> {
    const [start, end] = range;
    const response = await ctx.fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "content-type": mime,
        "content-length": String(end - start + 1),
        "content-range": `bytes ${start}-${end}/${bytes.byteLength}`,
      },
      body: bytes.subarray(start, end + 1),
      signal: AbortSignal.timeout(TIKTOK_UPLOAD_TIMEOUT_MS),
    });
    return response.status;
  }

  return {
    id: TIKTOK_PROVIDER,
    external: true,

    async staleApproval(_op, params, pctx, approval) {
      const sentence = stalePublish(approval, approval.now);
      if (sentence === null) return null;
      let p: PublishParams;
      try {
        p = publishParams(params);
      } catch {
        return null;
      }
      const b = await loadBackend();
      const item = await b.item(p.item_id, pctx.profile_id);
      if (!item || (item.status !== "drafted" && item.status !== "queued")) return null;
      return sentence;
    },

    async lapsed(_op, params, pctx, sentence) {
      const b = await loadBackend();
      const p = publishParams(params);
      await b.lapsed(p.item_id, sentence, pctx.account_id);
      logPublish({
        account_id: pctx.account_id,
        item_id: p.item_id,
        phase: "stale",
        outcome: "lapsed",
      });
    },

    async preflight(op, params, pctx): Promise<PreflightRefusal | null> {
      if (op !== "publish_tiktok_video") {
        return { code: "refused", message: `"${op}" isn't a TikTok op: nothing was sent` };
      }
      const b = await loadBackend();
      let p: PublishParams;
      try {
        p = publishParams(params);
      } catch (error) {
        return { code: "refused", message: (error as Error).message };
      }
      const item = await b.item(p.item_id, pctx.profile_id);
      if (!item)
        return { code: "refused", message: "the item to publish is gone: nothing was sent" };
      if (item.status === "publishing" || item.status === "published") return null;
      if (item.status !== "drafted" && item.status !== "queued") {
        return {
          code: "refused",
          message: `it is ${item.status}, so it isn't published: nothing was sent`,
        };
      }
      const refuse = async (refusal: PreflightRefusal): Promise<PreflightRefusal> => {
        await b.deferred(item.id, refusal.message);
        logPublish({
          account_id: pctx.account_id,
          item_id: item.id,
          phase: "preflight",
          outcome: refusal.code,
        });
        return refusal;
      };
      try {
        if (!asApproved(item)) return refuse({ code: "refused", message: TIKTOK_NOT_AS_APPROVED });
        if (!uploadableMedia(item.media_path)) {
          return refuse({
            code: "refused",
            message: `TikTok needs a video, and this item has none. ${NOTHING_SENT}`,
          });
        }
        if (publishCaption(item).length > TIKTOK_TITLE_MAX) {
          return refuse({
            code: "refused",
            message: `TikTok captions stop at ${TIKTOK_TITLE_MAX} characters, and this one is longer. ${NOTHING_SENT}`,
          });
        }
        const cred = await liveCredential(b, pctx.account_id, p.open_id);
        // TikTok's rule: the latest creator info, read before posting.
        const creator = await calls.creatorInfo(cred.access_token, pctx.account_id);
        const checked = checkSettings(item, creator);
        if ("refuse" in checked) return refuse({ code: "refused", message: checked.refuse });
        return null;
      } catch (error) {
        if (error instanceof TikTokRequestError) {
          if (error.failure.pauses) {
            await b.paused(pctx.account_id, error.failure.owner_sentence);
            return refuse({
              code: "refused",
              message: `${error.failure.owner_sentence} ${NOTHING_SENT}`,
            });
          }
          return refuse({
            code: error.failure.retryable ? "deferred" : "refused",
            message: error.failure.retryable
              ? error.failure.owner_sentence
              : `${error.failure.owner_sentence} ${NOTHING_SENT}`,
          });
        }
        if (error instanceof PublishError || error instanceof ExecutionConnectionError) {
          return refuse({ code: "refused", message: error.message });
        }
        throw error;
      }
    },

    async captureUndo() {
      // Irreversible by design: TikTok's API can't delete a post (see the top).
      return null;
    },

    async execute(op, params, pctx) {
      if (op !== "publish_tiktok_video")
        throw new PublishError(`"${op}" isn't a TikTok op: nothing was sent`);
      const b = await loadBackend();
      const p = publishParams(params);
      const item = await b.item(p.item_id, pctx.profile_id);
      if (!item) throw new PublishError("the item to publish is gone: nothing was sent");
      if (item.status === "published" && item.platform_post_id !== null) {
        return {
          platform: "tiktok",
          platform_post_id: item.platform_post_id,
          url: item.platform_url,
          publish_id: item.publish_attempt?.publish_id ?? item.platform_post_id,
          public_post: item.platform_post_id !== item.publish_attempt?.publish_id,
        } satisfies TikTokPublishedPost;
      }
      let cred: TikTokCredential;
      try {
        cred = await liveCredential(b, pctx.account_id, p.open_id);
      } catch (error) {
        if (error instanceof TikTokRequestError && error.failure.pauses) {
          // Nothing was claimed: the item is still queued, and the pause holds it.
          await b.paused(pctx.account_id, error.failure.owner_sentence);
          throw new TikTokPausedError();
        }
        throw error;
      }
      // In flight from an earlier attempt or a run that died: read back, never send again.
      if (item.status === "publishing") {
        return settle(b, await readBack(b, item, cred, pctx.account_id), item, pctx.account_id);
      }
      if (item.status !== "drafted" && item.status !== "queued") {
        throw new PublishError(`it is ${item.status}, so it isn't published: nothing was sent`);
      }
      if (!asApproved(item)) throw new PublishError(TIKTOK_NOT_AS_APPROVED);
      const caption = publishCaption(item);
      const attempt: TikTokPublishAttempt = {
        started_at: now().toISOString(),
        caption_sha256: captionHash(caption),
      };
      if (!(await b.claim(item.id, pctx.execution_id ?? null, attempt))) {
        throw new PublishError("the item changed before it could be sent: nothing was sent");
      }
      const note = async (patch: Partial<TikTokPublishAttempt>) => {
        Object.assign(attempt, patch);
        await b.note(item.id, attempt);
      };
      const log = (outcome: string) =>
        logPublish({
          account_id: pctx.account_id,
          item_id: item.id,
          execution_id: pctx.execution_id ?? null,
          attempt: pctx.attempt ?? null,
          op,
          phase: "publish",
          outcome,
        });

      try {
        const creator = await calls.creatorInfo(cred.access_token, pctx.account_id);
        const checked = checkSettings(item, creator);
        if ("refuse" in checked) throw new PublishError(checked.refuse);
        const s = checked.settings;
        const media = item.media_path as string;
        const bytes = await readMedia(b, media);
        const plan = chunkPlan(bytes.byteLength);
        if (pctx.halted && (await pctx.halted())) throw new StopError(STOPPED_BEFORE_PUBLISH);

        const init = await tiktokCall(ctx, "video_init", {
          bearer: cred.access_token,
          json: {
            post_info: {
              title: caption,
              privacy_level: s.privacy_level,
              // Off unless the owner turned it on — and off whenever the account has it off.
              disable_comment: !s.allow_comment || creator.comment_disabled,
              disable_duet: !s.allow_duet || creator.duet_disabled,
              disable_stitch: !s.allow_stitch || creator.stitch_disabled,
              brand_content_toggle: false,
              brand_organic_toggle: s.brand_organic,
              // Rule 17: TikTok's AI-generated content label, on every generated clip.
              is_aigc: item.is_ai_generated,
            },
            source_info: {
              source: "FILE_UPLOAD",
              video_size: bytes.byteLength,
              chunk_size: plan.chunk_size,
              total_chunk_count: plan.total_chunk_count,
            },
            _expect_aigc: item.is_ai_generated,
          },
          // Each init starts a publish: never repeated.
          repeatable: false,
          account_id: pctx.account_id,
        }).catch((error: unknown) => {
          // No answer to init: no upload_url, so no bytes can follow — nothing goes out.
          if (error instanceof TikTokNoAnswerError) {
            throw new PublishError(
              `TikTok didn't answer when ScaleX started the post. ${NOTHING_SENT}`,
            );
          }
          throw error;
        });
        const d = dataOf(init);
        const publishId = typeof d["publish_id"] === "string" ? d["publish_id"] : null;
        const uploadUrl = d["upload_url"];
        if (publishId === null || !uploadTargetAllowed(uploadUrl)) {
          throw new PublishError(`TikTok's answer had no place to upload to. ${NOTHING_SENT}`);
        }
        await note({ publish_id: publishId });

        const mime = mimeOf(media);
        for (let i = 0; i < plan.ranges.length; i += 1) {
          const last = i === plan.ranges.length - 1;
          if (last) {
            if (pctx.halted && (await pctx.halted())) throw new StopError(STOPPED_BEFORE_PUBLISH);
            await note({ sent_at: now().toISOString() });
          }
          const range = plan.ranges[i] as [number, number];
          let status = 0;
          for (let tries = 1; ; tries += 1) {
            try {
              status = await putChunk(uploadUrl, bytes, range, mime);
            } catch {
              // A lost answer on the last chunk: TikTok may be posting it now.
              if (last) throw new TikTokNoAnswerError("upload");
              status = 0;
            }
            if (status >= 500 || status === 0) {
              if (last && status === 0) throw new TikTokNoAnswerError("upload");
              if (tries < TIKTOK_MAX_ATTEMPTS) {
                await ctx.sleep(backoffMs(tries));
                continue;
              }
              if (last) throw new TikTokNoAnswerError("upload");
              throw new PublishError(`TikTok kept refusing the upload. ${NOTHING_SENT}`);
            }
            break;
          }
          const expected = last ? 201 : 206;
          if (status !== expected && !(last && status === 200)) {
            if (last) throw new TikTokNoAnswerError("upload");
            throw new PublishError(`TikTok refused the upload (status ${status}). ${NOTHING_SENT}`);
          }
        }

        // Posting has begun on TikTok's side: poll, capped, never re-send.
        let read: StatusRead = { kind: "processing" };
        for (let poll = 1; poll <= TIKTOK_POLL_MAX; poll += 1) {
          try {
            read = await calls.status(cred.access_token, publishId, pctx.account_id);
          } catch {
            read = { kind: "processing" };
          }
          if (read.kind !== "processing") break;
          await ctx.sleep(backoffMs(poll));
        }
        if (read.kind === "failed") {
          const sentence = failReasonSentence(read.reason);
          await b.failed(item.id, sentence);
          log("failed");
          throw new PublishError(sentence, false);
        }
        if (read.kind === "processing") {
          await b.uncertain(item.id, TIKTOK_STILL_PROCESSING);
          log("processing");
          throw new PublishError(TIKTOK_STILL_PROCESSING, true);
        }
        const post = postOf(cred, publishId, read.post_id);
        try {
          await b.published(item, post, pctx.account_id);
        } catch {
          log("published_unrecorded");
          throw new PublishError(TIKTOK_MAY_HAVE_POSTED, true);
        }
        log("published");
        return post;
      } catch (error) {
        if (error instanceof PublishError && error.retryable) throw error;
        if (error instanceof PublishError && attempt.sent_at !== undefined && !error.retryable) {
          // A definite TikTok verdict after the send (FAILED) — already recorded above.
          throw error;
        }
        if (error instanceof StopError) {
          await b.unclaim(item.id, error.message);
          log("halted");
          throw error;
        }
        if (error instanceof TikTokNoAnswerError || attempt.sent_at !== undefined) {
          await b.uncertain(item.id, TIKTOK_MAY_HAVE_POSTED);
          log("no_answer");
          throw new PublishError(TIKTOK_MAY_HAVE_POSTED, true);
        }
        if (error instanceof TikTokRequestError && error.failure.pauses) {
          // Nothing was sent (sent_at is unset): back to the queue, where the
          // pause holds it for the reconnect with every other queued TikTok
          // post — never `failed` for good, its render never released — and
          // the run waits for the reconnect too (review 2026-11-08).
          await b.unclaim(item.id, `${error.failure.owner_sentence} ${NOTHING_SENT}`);
          await b.paused(pctx.account_id, error.failure.owner_sentence);
          log("paused");
          throw new TikTokPausedError();
        }
        const sentence =
          error instanceof TikTokRequestError
            ? `${error.failure.owner_sentence} ${NOTHING_SENT}`
            : error instanceof PublishError || error instanceof UndisclosedTikTokPostError
              ? error.message
              : `Something went wrong on ScaleX's side before anything was sent. ${NOTHING_SENT}`;
        await b.failed(item.id, sentence);
        log("failed");
        throw new PublishError(sentence, false);
      }
    },

    async undo() {
      // Never reached: captureUndo stores nothing, so the engine refuses first.
      throw new PublishError(TIKTOK_NO_UNDO);
    },

    async reconcile(params, pctx) {
      const b = await loadBackend();
      const p = publishParams(params);
      const item = await b.item(p.item_id, pctx.profile_id);
      if (!item) return { kind: "not_sent", sentence: "the item is gone" };
      if (item.status === "published" && item.platform_post_id !== null) {
        return {
          kind: "found",
          post: {
            platform: "tiktok",
            platform_post_id: item.platform_post_id,
            url: item.platform_url,
          } as never,
        };
      }
      if (item.status !== "publishing")
        return { kind: "not_sent", sentence: `it is ${item.status}` };
      let cred: TikTokCredential;
      try {
        cred = await liveCredential(b, pctx.account_id, p.open_id);
      } catch {
        return { kind: "uncertain", sentence: TIKTOK_MAY_HAVE_POSTED };
      }
      const outcome = await readBack(b, item, cred, pctx.account_id);
      try {
        await settle(b, outcome, item, pctx.account_id);
      } catch (error) {
        if (!(error instanceof PublishError)) throw error;
      }
      return outcome;
    },
  };
}

/* ── assembly ──────────────────────────────────────────────────────── */

export interface TikTokExecutionOptions {
  fetch?: TikTokFetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  /** SYB's TikTok app. Default: TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET. */
  app?: () => TikTokApp | null;
  /** Default: TIKTOK_AUDIT_STATUS. */
  audit?: () => TikTokAuditStatus;
  backend?: TikTokPublishBackend;
}

export interface TikTokExecution {
  calls: TikTokCalls;
  publish: TikTokPublishProvider;
}

export function createTikTokExecution(options: TikTokExecutionOptions = {}): TikTokExecution {
  const ctx: Context = {
    fetch: options.fetch ?? defaultFetch,
    sleep: options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    app:
      options.app ??
      (() => {
        const env = tiktokPostingEnv();
        return env ? { client_key: env.client_key, client_secret: env.client_secret } : null;
      }),
    audit: options.audit ?? tiktokAuditStatus,
  };
  const now = options.now ?? (() => new Date());
  const calls = tiktokCalls(ctx);
  return {
    calls,
    publish: publishProvider(
      ctx,
      calls,
      async () => {
        if (options.backend) return options.backend;
        // The database side lives in lib/content, loaded on first use so the
        // provider map stays importable without a database.
        const { dbTikTokPublishBackend } = await import("../../content/tiktok-publish");
        return dbTikTokPublishBackend();
      },
      now,
    ),
  };
}

export const tiktokExecution = createTikTokExecution();
export const tiktokPublishExecutor = tiktokExecution.publish;
