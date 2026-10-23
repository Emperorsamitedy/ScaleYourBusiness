// The Meta write connector — P3-20g (Session D, layer D1), rules 13 and 18.
//
// HOW AN OWNER CONNECTS. The credential is a token plus asset ids: a
// Business Manager system-user token (or a long-lived token from the
// owner's own Meta app, pilot route 2) with the Page id and, optionally,
// the linked Instagram account id for publishing, or the ad account id for
// ad management. Publishing and ad management are two connections with two
// consents (`meta_publish`, `meta_ads`), each holding EXACTLY its registry
// scopes; one token with both sets of permissions connects as neither.
//
// PROVEN BEFORE STORED. The verifier asks /me/permissions (Meta reports
// scopes, so the check is real), refuses by name anything outside the
// registry before touching an asset, then proves the token reaches the
// asset: the Page (and a Page token can be had for it), the Instagram
// account, or the ad account. connectForExecution compares the scopes
// again, encrypts, stores. Nothing here logs or returns a token.
//
// THE PAGE TOKEN. Meta publishes to a Page with a Page token. Derived here
// from the system user's assigned Page by reading the Page's access_token
// field — _verify at build_ against a real Page: Meta's current docs do not
// state the derivation for system users. There is NO pasted-Page-token
// fallback (security review 2026-10-17): a pasted token's permissions
// can't be checked against the consent, so a broader token — or another
// user's — could have been stored under it. The only Page token SYB uses
// is one derived from the system-user token whose scopes were verified
// exactly. If derivation fails against a real Page, the paste route comes
// back only with a verified permission check (P3-21b).
//
// WHAT IT CAN SEND. Only the requests in META_EXEC_REQUESTS; meta.test.ts
// scans this source and fails the build otherwise. The OAuth token
// exchange (P3-20j, Facebook Login for testers) trades a sign-in code or a
// short-lived token for a user token and changes nothing on any Page or ad
// account; it is sent as a form body, so the app secret and the code never
// sit in a URL. The publish path (P3-21b) widened the list deliberately:
// POST only on the registered publish paths (feed, photos, video_reels and
// its upload, the Instagram container and media_publish) and DELETE only
// on a post or media id, for undo (P3-21c). The ad ops (P3-22b) widened it
// again, by three: GET and POST on a campaign by its id, and POST on the
// ad account's campaigns edge (create, paused). The readback (P3-23a) added
// two GETs, a post's and a media's insights, under readback scopes only. An ad write may carry only
// the fields AD_WRITE_FIELDS names and only the statuses PAUSED and ACTIVE
// — checked at the same choke point as the disclosure, so DELETED and
// ARCHIVED (both permanent on Meta) cannot be sent. No registered path
// under act_* may name billing, funding or payment methods (rule 18).
//
// THE PUBLISH PATH (P3-21b/c/d). See the block above createMetaExecution:
// disclosure enforced at the one request choke point (rule 17), no native
// scheduling, at-most-once with a read-back reconcile, undo by deletion.
//
// FAILURE HONESTY (P3-24b/c/d). A sign-in Meta refuses (the auth class)
// pauses the execute connection through the backend's `paused`, and the
// run waits for the reconnect (ConnectionPausedError, held "reconnect");
// the emergency stop is checked before every step that sends, and a stop
// seen before the step that makes anything public refuses it (StopError,
// held "stop"), the item returned to the queue untouched by Meta; every
// response's rate-limit usage headers are noted on the engine's attempt
// row (attempt-usage.ts); and each publish attempt ends in exactly one
// `content_publish` log line with the account, platform, item, attempt and
// outcome — never a token.
//
// FACEBOOK LOGIN (P3-20j). The same helper — the same retry cap, timeout
// and error taxonomy — serves the tester sign-in: the code exchange, the
// long-lived swap, and the two candidate lists (/me/accounts for Pages and
// their linked Instagram accounts, /me/adaccounts). The token it yields
// goes through the same verifier and connectForExecution as a pasted one.
//
// THE OPS. Registered in the scope registry so consent names them. The
// publish ops are D2's; the ad ops are D3's — see the block above
// createMetaExecution: a validate_only dry run before every write, the
// spend guardrails re-checked (lib/ads/guard), the access tier read on every
// call, and undo to the captured previous status or budget.

import { createHash } from "node:crypto";
import type { MetaResponse } from "../../connectors/providers/meta-ads";
import { META_GRAPH_ORIGIN, META_IGNORED_PERMISSIONS } from "../../connectors/providers/meta-ads";
import { isDisclosed } from "../../content/disclosure";
import { format, money } from "../../core/money";
import {
  UnknownMetaCurrencyError,
  dailyBudgetFloor,
  fromMetaBudget,
  spendGuard,
  toMetaBudget,
} from "../../ads/guard";
import { noteRequestUsage } from "../attempt-usage";
import type { MetaFailure } from "../meta-errors";
import {
  PAUSED_WORK_SENTENCE,
  TEMPORARY_CODES,
  classifyMetaError,
  pausesConnection,
} from "../meta-errors";
import type { CredentialVerifier } from "../verify";
import { ExecutionConnectionError, verifyExecutionScopes } from "../verify";
import { touchesMoneySurface } from "../scopes";
import type { ExecutionContext, ExecutionProvider, PreflightRefusal } from "./fixture";

export const META_EXEC_API_VERSION = "v26.0";
export const META_EXEC_MAX_ATTEMPTS = 3;
/** Every request to Meta gives up after this long; a timeout counts as "Meta didn't answer". */
export const META_EXEC_TIMEOUT_MS = 20_000;
/** Facebook's resumable-upload host for Reels (video_reels). */
export const META_RUPLOAD_ORIGIN = "https://rupload.facebook.com";

export type MetaExecutionProviderId = "meta_publish" | "meta_ads";

/** Every request this module may send. The closed set the build gates read. */
export const META_EXEC_REQUESTS = {
  permissions: { method: "GET", path: "/me/permissions" },
  page: { method: "GET", path: "/{page_id}" },
  ig_user: { method: "GET", path: "/{ig_user_id}" },
  ad_account: { method: "GET", path: "/act_{ad_account_id}" },
  // P3-20j, Facebook Login: the token exchange (code grant and long-lived swap), then the lists.
  token_exchange: { method: "POST", path: "/oauth/access_token" },
  my_pages: { method: "GET", path: "/me/accounts" },
  my_ad_accounts: { method: "GET", path: "/me/adaccounts" },
  // P3-21b, added deliberately: the publish path. POST only on these paths.
  page_feed: { method: "POST", path: "/{page_id}/feed" },
  page_photos: { method: "POST", path: "/{page_id}/photos" },
  page_reels: { method: "POST", path: "/{page_id}/video_reels" },
  reel_upload: { method: "POST", path: "/{video_id}", origin: "rupload" },
  ig_container: { method: "POST", path: "/{ig_user_id}/media" },
  ig_publish: { method: "POST", path: "/{ig_user_id}/media_publish" },
  // ...and the reads it needs: limits, processing status, permalinks, reconcile (P3-21d).
  ig_publishing_limit: { method: "GET", path: "/{ig_user_id}/content_publishing_limit" },
  ig_container_status: { method: "GET", path: "/{container_id}" },
  ig_media: { method: "GET", path: "/{ig_media_id}" },
  ig_media_list: { method: "GET", path: "/{ig_user_id}/media" },
  page_post: { method: "GET", path: "/{post_id}" },
  page_published_posts: { method: "GET", path: "/{page_id}/published_posts" },
  reel_status: { method: "GET", path: "/{video_id}" },
  // P3-21c: undo is deletion — of a Page post or Reel, or of Instagram media.
  page_post_delete: { method: "DELETE", path: "/{post_id}" },
  ig_media_delete: { method: "DELETE", path: "/{ig_media_id}" },
  // P3-22b, added deliberately: the ad ops. A campaign read and write by id, and create (paused).
  campaign: { method: "GET", path: "/{campaign_id}" },
  campaign_update: { method: "POST", path: "/{campaign_id}" },
  campaign_create: { method: "POST", path: "/act_{ad_account_id}/campaigns" },
  // P3-23a, added deliberately: the per-post readback. GET only, under readback scopes only.
  page_post_insights: { method: "GET", path: "/{post_id}/insights" },
  ig_media_insights: { method: "GET", path: "/{ig_media_id}/insights" },
} as const;

type MetaExecRequest = keyof typeof META_EXEC_REQUESTS;

export interface MetaRequestSpec {
  method: "GET" | "POST" | "DELETE";
  path: string;
  /** Graph unless stated: the Reel upload goes to the rupload host. */
  origin?: "rupload";
}

/**
 * Rule 18 for paths: a registered request under an ad account that names
 * billing, funding or payment methods. An empty array is the only answer.
 */
export function auditMetaRequests(
  requests: Readonly<Record<string, MetaRequestSpec>> = META_EXEC_REQUESTS,
): string[] {
  return Object.values(requests)
    .filter((r) => r.path.startsWith("/act_") && touchesMoneySurface(r.path))
    .map((r) => `${r.method} ${r.path}`);
}

export interface MetaExecRequestInit {
  /** A registered request's own method — never anything the registry doesn't name. */
  method: MetaRequestSpec["method"];
  headers: Record<string, string>;
  /** Form-encoded: the token exchange, and the parameters of a publish POST. */
  body?: string;
}

/** Meta's answer; `header` reads the rate-limit usage headers when the transport has them. */
export interface MetaExecResponse extends MetaResponse {
  header?(name: string): string | null;
}

export type MetaExecFetch = (url: string, init: MetaExecRequestInit) => Promise<MetaExecResponse>;

export interface MetaExecutionOptions {
  fetch?: MetaExecFetch;
  sleep?: (ms: number) => Promise<void>;
  /** The publish path's state (P3-21b). Default: the database, loaded on first use. */
  backend?: PublishBackend;
  /** The ad ops' state (P3-22b). Default: the database, loaded on first use. */
  adsBackend?: AdsBackend;
}

export interface MetaExecutionCredential {
  access_token: string;
  page_id: string | null;
  ig_user_id: string | null;
  /** Digits only; the act_ prefix is added where the API wants it. */
  ad_account_id: string | null;
}

function token(value: unknown, what: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  const t = typeof value === "string" ? value.trim() : "";
  if (t === "" || /\s/.test(t)) {
    throw new ExecutionConnectionError(`meta: paste the ${what} all on one line`, 400);
  }
  return t;
}

function digits(value: unknown, what: string, strip?: RegExp): string | null {
  if (value === undefined || value === null || value === "") return null;
  const d = typeof value === "string" ? value.trim().replace(strip ?? /^$/, "") : "";
  if (!/^\d{5,}$/.test(d)) {
    throw new ExecutionConnectionError(`meta: the ${what} is a number`, 400);
  }
  return d;
}

export function parseMetaExecutionCredential(
  secret: string,
  provider: MetaExecutionProviderId,
): MetaExecutionCredential {
  let raw: unknown;
  try {
    raw = JSON.parse(secret);
  } catch {
    throw new ExecutionConnectionError("meta: the token and the asset ids are both needed", 400);
  }
  const c = (raw ?? {}) as Record<string, unknown>;
  const cred: MetaExecutionCredential = {
    access_token: token(c["access_token"], "access token") ?? "",
    page_id: digits(c["page_id"], "Page id"),
    ig_user_id: digits(c["ig_user_id"], "Instagram account id"),
    ad_account_id: digits(c["ad_account_id"], "ad account id", /^act_/),
  };
  if (c["page_access_token"] !== undefined && c["page_access_token"] !== "") {
    throw new ExecutionConnectionError(
      "meta: a pasted Page token can't be checked against your consent — assign the Page to the system user instead, and SYB derives the Page token from it",
      400,
    );
  }
  if (cred.access_token === "") {
    throw new ExecutionConnectionError("meta: the access token is needed", 400);
  }
  if (provider === "meta_publish" && cred.page_id === null) {
    throw new ExecutionConnectionError("meta: publishing needs the id of the Page to post to", 400);
  }
  if (provider === "meta_ads" && cred.ad_account_id === null) {
    throw new ExecutionConnectionError(
      "meta: ad management needs the ad account id, the number in Ads Manager",
      400,
    );
  }
  return cred;
}

interface Context {
  fetch: MetaExecFetch;
  sleep: (ms: number) => Promise<void>;
}

function backoffMs(attempt: number): number {
  return 1000 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
}

function pathFor(which: MetaExecRequest, ids: Readonly<Record<string, string>>): string {
  const path = META_EXEC_REQUESTS[which].path.replace(/\{(\w+)\}/g, (_, name: string) => {
    const id = ids[name];
    if (id === undefined) throw new Error(`meta: ${which} needs ${name}`);
    return encodeURIComponent(id);
  });
  return `/${META_EXEC_API_VERSION}${path}`;
}

function originFor(which: MetaExecRequest): string {
  const spec: MetaRequestSpec = META_EXEC_REQUESTS[which];
  return spec.origin === "rupload" ? `${META_RUPLOAD_ORIGIN}/video-upload` : META_GRAPH_ORIGIN;
}

/**
 * How a request authenticates: the token in a header (a POST's parameters
 * then go in a form body), the token exchange's form body, or the Reel
 * upload's `OAuth` header with the file's public URL beside it.
 */
type MetaAuth =
  | { bearer: string }
  | { form: Readonly<Record<string, string>> }
  | { oauth: string; headers: Readonly<Record<string, string>> };

/**
 * Rule 17 at the one choke point every request passes: an Instagram
 * container without `is_ai_generated=true`, or a Facebook caption that
 * doesn't end with a disclosure label, is never sent. The build gate in
 * meta.test.ts proves every publishing request is covered here.
 */
export const DISCLOSED_TEXT_FIELD: Readonly<Partial<Record<MetaExecRequest, string>>> = {
  page_feed: "message",
  page_photos: "message",
  page_reels: "description",
};

export class UndisclosedPublishError extends Error {
  readonly retryable = false;
  constructor(which: string) {
    super(`meta: refusing to send ${which} without its AI disclosure (rule 17) — nothing was sent`);
    this.name = "UndisclosedPublishError";
  }
}

/** Pure: the request that may not be sent as it stands, or null. */
export function disclosureViolation(
  which: MetaExecRequest,
  params: Readonly<Record<string, string>>,
): string | null {
  if (which === "ig_container" && params["is_ai_generated"] !== "true") return which;
  const field = DISCLOSED_TEXT_FIELD[which];
  if (field === undefined) return null;
  // A Reel's start phase carries no caption; its finish phase publishes and must.
  if (which === "page_reels" && params["upload_phase"] !== "finish") return null;
  return isDisclosed(params[field] ?? "") ? null : which;
}

/**
 * Meta gave no usable answer to a PUBLISHING request: no response, a
 * timeout, any 5xx, Meta's temporary codes 1 and 2, an answer with no error
 * code, or a 200 we can't read (publishingNoAnswer). The post may
 * or may not exist — the at-most-once path reconciles by reading back and
 * never sends it again (P3-21d).
 */
export class MetaNoAnswerError extends Error {
  constructor(which: string) {
    super(`meta: no usable answer to ${which}`);
    this.name = "MetaNoAnswerError";
  }
}

/**
 * P3-24b: Meta refused the connection's sign-in (the auth class). The
 * connection has paused itself; this run waits for the reconnect (the
 * engine journals it held "reconnect") and nothing retries before then.
 * The message is the one owner sentence for held work.
 */
export class ConnectionPausedError extends Error {
  readonly retryable = false;
  readonly held_for = "reconnect" as const;
  readonly failure: MetaFailure;
  constructor(failure: MetaFailure, subject: "publish" | "ad_change") {
    super(PAUSED_WORK_SENTENCE[subject]);
    this.name = "ConnectionPausedError";
    this.failure = failure;
  }
}

/**
 * P3-24c: the emergency stop came on between two steps of one publish or
 * ad change, before the step that makes anything public. Nothing more is
 * sent; the engine journals the run held "stop" and it goes out — through
 * every guard again — after the owner resumes.
 */
export class StopError extends Error {
  readonly retryable = false;
  readonly held_for = "stop" as const;
  constructor(message: string) {
    super(message);
    this.name = "StopError";
  }
}

export const STOPPED_BEFORE_PUBLISH =
  "The emergency stop came on before this went out. Nothing was published; it goes out after you resume.";
export const STOPPED_BEFORE_CHANGE =
  "The emergency stop came on before this change was sent. Nothing was changed; it goes ahead after you resume.";

/** Throws StopError when the engine says the stop is on. No check offered = nothing to check. */
async function checkStop(
  halted: (() => Promise<boolean>) | undefined,
  sentence: string,
): Promise<void> {
  if (halted && (await halted())) throw new StopError(sentence);
}

interface CallOptions {
  /**
   * A call that makes something public. Silence is never retried, and
   * neither is a 5xx or Meta's temporary codes 1 and 2 — each throws
   * MetaNoAnswerError at once (publishingNoAnswer). Only a definite 4xx
   * refusal (a rate limit, say) is retried to the cap, since Meta did nothing.
   */
  publishing?: boolean;
  /** For the usage log line (P3-21d); never a token. */
  account_id?: string;
  /** What the call is part of, for the owner's sentence on a refusal (P3-22b). */
  subject?: "publish" | "ad_change";
}

interface CallResult {
  body: Record<string, unknown>;
  /** The highest rate-limit usage Meta reported on this response, 0–100, or null. */
  usage_pct: number | null;
  /** P3-22d: the Marketing API access tier Meta reported on this response, or null. */
  access_tier: string | null;
}

function parseHeader(raw: string | null): unknown {
  if (raw === null || raw === "") return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/** The entries of X-Business-Use-Case-Usage: {id: [{type, call_count, …}]}. */
function bucEntries(header: (name: string) => string | null): Record<string, unknown>[] {
  const buc = parseHeader(header("x-business-use-case-usage"));
  if (buc === null || typeof buc !== "object") return [];
  return Object.values(buc as Record<string, unknown>).flatMap((list) =>
    Array.isArray(list)
      ? list.filter((e): e is Record<string, unknown> => e !== null && typeof e === "object")
      : [],
  );
}

/**
 * The Marketing API's own usage headers (P3-22d): X-Ad-Account-Usage
 * {acc_id_util_pct, reset_time_duration, ads_api_access_tier} and
 * X-FB-Ads-Insights-Throttle {app_id_util_pct, acc_id_util_pct,
 * ads_api_access_tier}. Header names per Meta's rate-limiting page, read
 * 2026-10-19 — _verify at build_ against a real ad account's responses.
 */
export const META_ADS_USAGE_HEADERS = ["x-ad-account-usage", "x-fb-ads-insights-throttle"] as const;

/**
 * The highest percentage in Meta's usage headers: X-App-Usage
 * {call_count,total_time,total_cputime}, X-Business-Use-Case-Usage
 * {id: [{type, call_count, total_time, total_cputime}]}, and the ads
 * headers' acc_id_util_pct / app_id_util_pct. Null when absent.
 */
export function usagePercent(header: (name: string) => string | null): number | null {
  const values: number[] = [];
  const collect = (o: unknown) => {
    if (o === null || typeof o !== "object") return;
    for (const k of [
      "call_count",
      "total_time",
      "total_cputime",
      "acc_id_util_pct",
      "app_id_util_pct",
    ]) {
      const v = (o as Record<string, unknown>)[k];
      if (typeof v === "number" && Number.isFinite(v)) values.push(v);
    }
  };
  collect(parseHeader(header("x-app-usage")));
  bucEntries(header).forEach(collect);
  for (const name of META_ADS_USAGE_HEADERS) collect(parseHeader(header(name)));
  return values.length === 0 ? null : Math.max(...values);
}

/**
 * P3-22d: the Marketing API access tier Meta reports on a response, verbatim
 * ("development_access", "standard_access", …), or null. Meta puts
 * `ads_api_access_tier` in the ads_management / ads_insights entries of
 * X-Business-Use-Case-Usage, and in X-Ad-Account-Usage and
 * X-FB-Ads-Insights-Throttle — _verify at build_ which a v26.0 ads write
 * actually carries. Only a short word is accepted: it is stored and shown.
 */
export function adsAccessTier(header: (name: string) => string | null): string | null {
  const word = (v: unknown): string | null =>
    typeof v === "string" && /^[a-z_]{1,40}$/.test(v) ? v : null;
  for (const e of bucEntries(header)) {
    const tier = word(e["ads_api_access_tier"]);
    if (tier !== null) return tier;
  }
  for (const name of META_ADS_USAGE_HEADERS) {
    const o = parseHeader(header(name));
    if (o !== null && typeof o === "object") {
      const tier = word((o as Record<string, unknown>)["ads_api_access_tier"]);
      if (tier !== null) return tier;
    }
  }
  return null;
}

/** The rate-limit headers Meta may send on any response (P3-21d, P3-22d). */
export const META_USAGE_HEADERS = [
  "x-app-usage",
  "x-business-use-case-usage",
  ...META_ADS_USAGE_HEADERS,
] as const;

/** P3-24d, pure: each usage header Meta sent, as parsed JSON (unparseable ones verbatim, capped). */
export function usageHeaders(header: (name: string) => string | null): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const name of META_USAGE_HEADERS) {
    const raw = header(name);
    if (raw === null || raw === "") continue;
    out[name] = parseHeader(raw) ?? raw.slice(0, 500);
  }
  return out;
}

/**
 * Pure: an answer to a PUBLISHING call that must be read as no answer at all
 * (P3-21d, review 2026-10-23 #2) — no error code, any 5xx, or Meta's
 * temporary codes 1 and 2. A post may exist behind each, so none is retried.
 * A definite 4xx refusal (a rate limit, a bad parameter) is an answer: Meta
 * did nothing, and the cap's retries stay as they are. Reads: always false.
 */
export function publishingNoAnswer(
  options: Pick<CallOptions, "publishing">,
  status: number,
  code: number | null,
): boolean {
  if (!options.publishing) return false;
  return code === null || status >= 500 || TEMPORARY_CODES.has(code);
}

async function metaCall(
  ctx: Context,
  auth: MetaAuth,
  which: MetaExecRequest,
  ids: Readonly<Record<string, string>>,
  params: Record<string, string>,
  cannotReach: string,
  options: CallOptions = {},
): Promise<CallResult> {
  if (disclosureViolation(which, params) !== null) throw new UndisclosedPublishError(which);
  const adViolation = adWriteViolation(which, params);
  if (adViolation !== null) throw new AdWriteRefusedError(adViolation);
  const method = META_EXEC_REQUESTS[which].method;
  const asBody = "bearer" in auth && method === "POST";
  const query = asBody ? "" : new URLSearchParams(params).toString();
  const url = `${originFor(which)}${pathFor(which, ids)}${query ? `?${query}` : ""}`;
  const init: MetaExecRequestInit =
    "bearer" in auth
      ? {
          method,
          headers: {
            authorization: `Bearer ${auth.bearer}`,
            accept: "application/json",
            ...(asBody ? { "content-type": "application/x-www-form-urlencoded" } : {}),
          },
          ...(asBody ? { body: new URLSearchParams(params).toString() } : {}),
        }
      : "oauth" in auth
        ? {
            method,
            headers: {
              authorization: `OAuth ${auth.oauth}`,
              accept: "application/json",
              ...auth.headers,
            },
          }
        : {
            method,
            headers: {
              "content-type": "application/x-www-form-urlencoded",
              accept: "application/json",
            },
            body: new URLSearchParams(auth.form).toString(),
          };

  for (let attempt = 1; ; attempt += 1) {
    let response: MetaExecResponse;
    try {
      response = await ctx.fetch(url, init);
    } catch {
      // A request that never got an answer (or timed out): Meta unavailable, by the taxonomy.
      if (options.publishing) throw new MetaNoAnswerError(which);
      const failure = classifyMetaError({
        status: 0,
        code: null,
        ...(options.subject ? { subject: options.subject } : {}),
      });
      if (attempt >= META_EXEC_MAX_ATTEMPTS) throw new MetaRequestError(failure, cannotReach);
      await ctx.sleep(backoffMs(attempt));
      continue;
    }

    const read = (n: string) => response.header?.(n) ?? null;
    const usage = response.header ? usagePercent(read) : null;
    const tier = response.header ? adsAccessTier(read) : null;
    // P3-24d: every response's usage headers, onto the engine's attempt row.
    noteRequestUsage({
      request: which,
      usage_pct: usage,
      access_tier: tier,
      headers: response.header ? usageHeaders(read) : {},
    });
    if (usage !== null || tier !== null) {
      console.log(
        JSON.stringify({
          event: "meta_usage",
          ...(options.account_id ? { account_id: options.account_id } : {}),
          request: which,
          usage_pct: usage,
          ...(tier !== null ? { access_tier: tier } : {}),
        }),
      );
    }

    const body = (await response.json().catch(() => null)) as {
      error?: { code?: unknown; error_subcode?: unknown };
    } | null;
    const error = body?.error;
    if (response.status === 200 && error === undefined && body !== null) {
      return { body: body as Record<string, unknown>, usage_pct: usage, access_tier: tier };
    }
    const code = typeof error?.code === "number" ? error.code : null;
    // A publishing call answered with silence, not a refusal: it may have landed.
    // So is a 5xx of any kind, and Meta's own "temporary" codes 1 and 2: each
    // says Meta didn't finish answering, not that it did nothing (review
    // 2026-10-23, Session D #2). Never sent again — the read-back settles it.
    if (publishingNoAnswer(options, response.status, code)) throw new MetaNoAnswerError(which);

    // One mapping for every refusal (P3-24a): the sentence, the connection's
    // fate, the next step and whether to retry all come from meta-errors.
    const failure = classifyMetaError({
      status: response.status,
      code,
      subcode: typeof error?.error_subcode === "number" ? error.error_subcode : null,
      ...(options.subject ? { subject: options.subject } : {}),
    });
    if (failure.retryable && attempt < META_EXEC_MAX_ATTEMPTS) {
      await ctx.sleep(backoffMs(attempt));
      continue;
    }
    throw new MetaRequestError(failure, cannotReach);
  }
}

async function metaRequest(
  ctx: Context,
  auth: MetaAuth,
  which: MetaExecRequest,
  ids: Readonly<Record<string, string>>,
  params: Record<string, string>,
  cannotReach: string,
  options: CallOptions = {},
): Promise<Record<string, unknown>> {
  return (await metaCall(ctx, auth, which, ids, params, cannotReach, options)).body;
}

const STATUS_FOR: Readonly<Record<MetaFailure["kind"], number>> = {
  auth: 422,
  permission: 422,
  rate_limit: 503,
  page_limit: 503,
  unavailable: 503,
  unknown: 502,
};

/**
 * A Meta refusal, classified once. The message is the owner's sentence —
 * with the asset named where that helps fix it — and `failure` carries the
 * connection's fate and the next step for the degrade-to-paused path (P3-24b).
 */
export class MetaRequestError extends ExecutionConnectionError {
  readonly failure: MetaFailure;
  constructor(failure: MetaFailure, asset: string) {
    super(
      failure.kind === "permission"
        ? `${failure.owner_sentence} (It can't reach ${asset}.)`
        : failure.owner_sentence,
      STATUS_FOR[failure.kind],
    );
    this.name = "MetaRequestError";
    this.failure = failure;
  }
}

/** What Meta says the token was granted, public_profile aside. */
async function grantedPermissions(ctx: Context, accessToken: string): Promise<string[]> {
  const body = await metaRequest(
    ctx,
    { bearer: accessToken },
    "permissions",
    {},
    {},
    "its own permissions",
  );
  const data = Array.isArray(body["data"]) ? body["data"] : null;
  if (data === null) {
    throw new ExecutionConnectionError("meta: could not read the token's permissions", 502);
  }
  return [
    ...new Set(
      data.flatMap((p) => {
        const perm = p as { permission?: unknown; status?: unknown } | null;
        return typeof perm?.permission === "string" &&
          perm.status === "granted" &&
          !META_IGNORED_PERMISSIONS.has(perm.permission)
          ? [perm.permission]
          : [];
      }),
    ),
  ].sort();
}

function sameId(body: Record<string, unknown>, expected: string, what: string): void {
  if (String(body["id"] ?? "").replace(/^act_/, "") !== expected) {
    throw new ExecutionConnectionError(`meta: the ${what} answered with a different id`, 502);
  }
}

async function provePage(ctx: Context, cred: MetaExecutionCredential, pageId: string) {
  const reach = `Page ${pageId}. Assign the Page to the system user with the permissions listed`;
  const page = await metaRequest(
    ctx,
    { bearer: cred.access_token },
    "page",
    { page_id: pageId },
    { fields: "id,name,access_token" },
    reach,
  );
  sameId(page, pageId, "Page");
  if (typeof page["access_token"] !== "string" || page["access_token"] === "") {
    throw new ExecutionConnectionError(
      `meta: no Page token could be had for Page ${pageId}. Assign the Page to the system user with the permissions listed`,
      422,
    );
  }
}

/** SYB's own Meta app, for the tester sign-in. The secret never leaves the server. */
export interface MetaAppCredentials {
  app_id: string;
  app_secret: string;
}

/** A Page the signed-in Facebook user can publish to, with its linked Instagram account. */
export interface MetaPageCandidate {
  id: string;
  name: string;
  instagram: { id: string; username: string | null } | null;
}

/** An ad account the signed-in Facebook user can manage. account_status 1 is active. */
export interface MetaAdAccountCandidate {
  /** Digits only, as the credential stores it. */
  id: string;
  name: string;
  account_status: number | null;
}

/** P3-20j: the Graph calls behind Facebook Login, through the same capped, timed helper. */
export interface MetaLoginCalls {
  /** The sign-in code for a short-lived user token. */
  exchangeCode(app: MetaAppCredentials, code: string, redirectUri: string): Promise<string>;
  /** A short-lived user token for a long-lived one (about 60 days). */
  longLived(app: MetaAppCredentials, shortLived: string): Promise<string>;
  pages(userToken: string): Promise<MetaPageCandidate[]>;
  adAccounts(userToken: string): Promise<MetaAdAccountCandidate[]>;
}

export interface MetaExecution {
  /** The connect-time proof for one of the two Meta consents. */
  verifier(provider: MetaExecutionProviderId): CredentialVerifier;
  /** Facebook Login for testers (P3-20j). */
  login: MetaLoginCalls;
  /** The publish ops (P3-21b), undo by deletion (P3-21c), the read-back (P3-21d). */
  publish: MetaPublishProvider;
  /** The ad ops (P3-22b), guardrails re-checked (P3-22c), the access tier read (P3-22d). */
  ads: ExecutionProvider;
  /** P3-23a: per-post insights, GET only, under the readback scopes only. */
  readback: MetaReadback;
  /**
   * The Instagram publisher on its own: one image, a Reel, or a CAROUSEL of
   * up to ten. Content items carry one render today, so the executor sends
   * one; a carousel is reachable here until multi-image items exist.
   */
  instagram(args: {
    igUserId: string;
    token: string;
    media: readonly string[];
    caption: string;
    account_id: string;
    /** P3-24c: the emergency stop, checked before every container and before media_publish. */
    halted?: () => Promise<boolean>;
  }): Promise<PublishedPost>;
}

const defaultFetch: MetaExecFetch = async (url, init) => {
  const response = await fetch(url, {
    method: init.method,
    headers: init.headers,
    ...(init.body !== undefined ? { body: init.body } : {}),
    cache: "no-store",
    signal: AbortSignal.timeout(META_EXEC_TIMEOUT_MS),
  });
  return {
    status: response.status,
    json: () => response.json() as Promise<unknown>,
    header: (name) => response.headers.get(name),
  };
};

function userToken(body: Record<string, unknown>): string {
  const t = body["access_token"];
  if (typeof t !== "string" || t === "" || /\s/.test(t)) {
    throw new ExecutionConnectionError("meta: the Facebook sign-in returned no usable token", 502);
  }
  return t;
}

function listOf(body: Record<string, unknown>): Record<string, unknown>[] {
  const data = body["data"];
  if (!Array.isArray(data)) {
    throw new ExecutionConnectionError("meta: the list came back in a shape SYB can't read", 502);
  }
  return data.filter((d): d is Record<string, unknown> => d !== null && typeof d === "object");
}

const idOf = (v: unknown): string | null =>
  typeof v === "string" && /^\d{5,}$/.test(v) ? v : null;
const nameOf = (v: unknown): string => (typeof v === "string" && v.trim() !== "" ? v : "(no name)");

function loginCalls(ctx: Context): MetaLoginCalls {
  const exchange = async (form: Record<string, string>) =>
    userToken(await metaRequest(ctx, { form }, "token_exchange", {}, {}, "the Facebook sign-in"));
  return {
    exchangeCode: (app, code, redirectUri) =>
      exchange({
        client_id: app.app_id,
        client_secret: app.app_secret,
        redirect_uri: redirectUri,
        code,
      }),
    longLived: (app, shortLived) =>
      exchange({
        grant_type: "fb_exchange_token",
        client_id: app.app_id,
        client_secret: app.app_secret,
        fb_exchange_token: shortLived,
      }),
    pages: async (token) => {
      const body = await metaRequest(
        ctx,
        { bearer: token },
        "my_pages",
        {},
        { fields: "id,name,instagram_business_account{id,username}", limit: "100" },
        "your Pages",
      );
      return listOf(body).flatMap((p) => {
        const id = idOf(p["id"]);
        if (id === null) return [];
        const ig = p["instagram_business_account"];
        const igRow =
          ig !== null && typeof ig === "object" ? (ig as Record<string, unknown>) : null;
        const igId = igRow ? idOf(igRow["id"]) : null;
        const username = igRow?.["username"];
        return [
          {
            id,
            name: nameOf(p["name"]),
            instagram:
              igId === null
                ? null
                : { id: igId, username: typeof username === "string" ? username : null },
          },
        ];
      });
    },
    adAccounts: async (token) => {
      const body = await metaRequest(
        ctx,
        { bearer: token },
        "my_ad_accounts",
        {},
        { fields: "id,name,account_status", limit: "100" },
        "your ad accounts",
      );
      return listOf(body).flatMap((a) => {
        const raw = a["id"];
        const id = typeof raw === "string" ? idOf(raw.replace(/^act_/, "")) : null;
        if (id === null) return [];
        const status = a["account_status"];
        return [
          {
            id,
            name: nameOf(a["name"]),
            account_status: typeof status === "number" ? status : null,
          },
        ];
      });
    },
  };
}

/* ══════════ THE PUBLISH PATH — P3-21b/c/d (Session D, layer D2) ══════════
 *
 * One approved publish proposal, in order:
 *
 *   preflight (reads only, before the engine claims anything) — the item
 *     is still the one approved and still waiting; the connection is live
 *     and points at the approved target; Instagram's 100-posts-a-day API
 *     limit has room (/content_publishing_limit); Meta's usage headers are
 *     under 75%. A refusal here leaves the proposal approved.
 *   execute — the item is marked `publishing` BEFORE anything is sent, and
 *     sent_at is recorded just before the one call that makes it public;
 *     then the platform's id, the permalink, `published`, the watch log.
 *   undo (P3-21c) — DELETE the Page post or Reel, or the Instagram media
 *     (a whole carousel, by its parent id); the item becomes `withdrawn`
 *     and keeps the platform's id forever.
 *
 * Disclosure (rule 17): every Instagram container carries
 * is_ai_generated=true — Meta's only self-disclosure field — and every
 * Facebook caption ends with the item's disclosure label, since Facebook
 * has no such field. metaCall refuses to send either otherwise, and the
 * build gate proves every publishing request passes that check.
 *
 * No native scheduling: scheduled_publish_time is never sent. A post Meta
 * is holding would go out after an emergency stop; ours go out when the
 * runner says, through the engine and its halt check.
 *
 * At-most-once (P3-21d), stated honestly: Meta has no client idempotency
 * key for posts. The engine guarantees one execution row; inside it, a
 * publishing call that gets no usable answer is NEVER sent again. The item
 * stays `publishing`, and the next attempt — or the next sweep, if the run
 * died — reads back instead: a post with our caption since sent_at, the
 * Instagram container's status, the Reel's publishing phase. Found → it is
 * published, with its id. Provably not sent → failed, "nothing was
 * published". Otherwise the owner sees "I may have posted this — check the
 * Page" and resolves it by hand. A lost confirmation is visible, never
 * silent, and a duplicate post is structurally impossible.
 */

export type PublishItemStatus =
  "drafted" | "queued" | "publishing" | "published" | "failed" | "withdrawn";
export type PublishPlatform = "facebook" | "instagram";
export type PublishOp =
  "publish_page_post" | "publish_page_photo" | "publish_page_video" | "publish_ig_media";

/** What the run sent and when — content_items.publish_attempt (P3-21d). */
export interface PublishAttempt {
  started_at: string;
  /** sha256 of the trimmed caption: how a read-back recognises our post. */
  caption_sha256: string;
  /** Set just BEFORE the call that makes it public. Absent = provably never sent. */
  sent_at?: string;
  container_id?: string;
  video_id?: string;
}

export interface PublishItem {
  id: string;
  profile_id: string;
  kind: string;
  title: string;
  body: string;
  disclosure: string;
  media_path: string | null;
  status: PublishItemStatus;
  platform: string | null;
  platform_post_id: string | null;
  platform_url: string | null;
  publish_proposal_id: string | null;
  publish_attempt: PublishAttempt | null;
  /** A link the post carries (provenance.link, https only) — Facebook text posts send it as `link`. */
  link: string | null;
}

export interface PublishedPost {
  platform: PublishPlatform;
  platform_post_id: string;
  url: string | null;
}

/**
 * The publish path's state, held by the database (lib/content/publishing.ts).
 * Injected so this module never imports the database itself.
 */
export interface PublishBackend {
  item(itemId: string, profileId: string): Promise<PublishItem | null>;
  /** The live meta_publish credential, or the sentence saying why there is none. */
  credential(accountId: string): Promise<MetaExecutionCredential | { refused: string }>;
  /** drafted|queued → publishing, conditionally. False when the item had moved on. */
  claim(
    itemId: string,
    executionId: string | null,
    platform: PublishPlatform,
    attempt: PublishAttempt,
  ): Promise<boolean>;
  /** Progress on the in-flight attempt: sent_at, the interim ids. */
  note(itemId: string, attempt: PublishAttempt): Promise<void>;
  published(item: PublishItem, post: PublishedPost, accountId: string): Promise<void>;
  failed(itemId: string, sentence: string): Promise<void>;
  /** Stays `publishing`, carrying the sentence. */
  uncertain(itemId: string, sentence: string): Promise<void>;
  /** Status untouched; the sentence shows on /content. */
  deferred(itemId: string, sentence: string): Promise<void>;
  withdrawn(item: PublishItem, platform: PublishPlatform, accountId: string): Promise<void>;
  /**
   * P3-24b: Meta refused the connection's sign-in. Pause the execute
   * connection and hold every queued item on it (and `item_id`, already
   * failed) for the reconnect.
   */
  paused(args: {
    account_id: string;
    failure: MetaFailure;
    item_id?: string | null;
  }): Promise<void>;
  /**
   * P3-24c: publishing → queued, only while nothing was sent (no sent_at):
   * the stop came on between steps, before the one that makes it public.
   */
  unclaim(itemId: string, sentence: string): Promise<void>;
}

/**
 * A publish that ended. `retryable` is read by the engine: false stops its
 * loop — another attempt could only repeat a refusal or, worse, a post.
 */
export class PublishError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable = false) {
    super(message);
    this.name = "PublishError";
    this.retryable = retryable;
  }
}

export type ReconcileOutcome =
  | { kind: "found"; post: PublishedPost }
  | { kind: "not_sent"; sentence: string }
  | { kind: "uncertain"; sentence: string };

/** Instagram's API publishing limit, per account per 24 hours (docs-verified). */
export const IG_DAILY_PUBLISH_LIMIT = 100;
/** Instagram's caption limit, in characters. */
export const IG_CAPTION_MAX = 2200;
/** Back off once Meta reports this much of a rate limit used (P3-21d). */
export const META_USAGE_BACKOFF_PCT = 75;
/** Polls of an Instagram container's status_code before giving up — capped, with backoff. */
export const IG_POLL_MAX = 10;
/** How far before sent_at a read-back looks, for clock skew between us and Meta. */
const READBACK_SKEW_S = 300;

export const MAY_HAVE_POSTED: Readonly<Record<PublishPlatform, string>> = {
  facebook:
    "I may have posted this — check the Page. Meta didn't confirm it, and I won't post it again.",
  instagram:
    "I may have posted this — check the Instagram account. Meta didn't confirm it, and I won't post it again.",
};
const NEVER_SENT = "The run stopped before anything was sent to Meta. Nothing was published.";

const PLATFORM_LABEL: Readonly<Record<PublishPlatform, string>> = {
  facebook: "Facebook",
  instagram: "Instagram",
};

type MediaKind = "image/jpeg" | "image/png" | "video";

/** Pure: the kind of media at a URL, by its extension. Null = not one the platforms take. */
export function mediaKindOf(url: string): MediaKind | null {
  let pathname: string;
  try {
    const parsed = new URL(url);
    // Meta fetches the file itself, from a public address; nothing else is handed over.
    if (parsed.protocol !== "https:") return null;
    pathname = parsed.pathname.toLowerCase();
  } catch {
    return null;
  }
  if (/\.(jpe?g)$/.test(pathname)) return "image/jpeg";
  if (pathname.endsWith(".png")) return "image/png";
  if (/\.(mp4|mov)$/.test(pathname)) return "video";
  return null;
}

/** Pure: the registered op for an item on a platform, or null when none fits. */
export function publishOpFor(platform: PublishPlatform, mediaUrl: string | null): PublishOp | null {
  if (platform === "instagram") return mediaUrl ? "publish_ig_media" : null;
  if (mediaUrl === null) return "publish_page_post";
  const kind = mediaKindOf(mediaUrl);
  if (kind === null) return null;
  return kind === "video" ? "publish_page_video" : "publish_page_photo";
}

/** Pure: the caption that goes out — the drafted body, ending with its disclosure (rule 17). */
export function publishCaption(item: { body: string; disclosure: string }): string {
  const body = item.body.trimEnd();
  return body.endsWith(item.disclosure) ? body : `${body}\n\n${item.disclosure}`;
}

export function captionHash(text: string): string {
  return createHash("sha256").update(text.trim()).digest("hex");
}

interface PublishParams {
  item_id: string;
  platform: PublishPlatform;
  /** The asset the owner approved: the Page id or the Instagram account id. */
  target_id: string;
}

function publishParams(params: Record<string, unknown>): PublishParams {
  const itemId = params["item_id"];
  const platform = params["platform"];
  const target = params["target"] as Record<string, unknown> | null | undefined;
  if (typeof itemId !== "string" || (platform !== "facebook" && platform !== "instagram")) {
    throw new PublishError("the publish plan names no item or platform — nothing was sent");
  }
  const id = platform === "facebook" ? target?.["page_id"] : target?.["ig_user_id"];
  if (typeof id !== "string" || id === "") {
    throw new PublishError("the publish plan names no Page or account — nothing was sent");
  }
  return { item_id: itemId, platform, target_id: id };
}

function refusalSentence(failure: MetaFailure): string {
  if (!failure.retryable) return failure.owner_sentence;
  return failure.kind === "unavailable"
    ? "Meta kept failing to answer, so nothing was published."
    : "Meta kept asking SYB to slow down, so nothing was published.";
}

function stringId(body: Record<string, unknown>, key: string): string | null {
  const v = body[key];
  return typeof v === "string" && v !== "" ? v : null;
}

interface PublishHooks {
  account_id: string;
  /** Record progress before the next step: sent_at goes down BEFORE the publishing call. */
  note(patch: Partial<PublishAttempt>): Promise<void>;
  /** P3-24c: is the emergency stop on? Checked before every step that sends. */
  halted?: () => Promise<boolean>;
}

const stopBeforePublish = (hooks: PublishHooks) => checkStop(hooks.halted, STOPPED_BEFORE_PUBLISH);

/** The Page token, derived from the verified system-user token, and the usage Meta reported. */
async function pageAccess(
  ctx: Context,
  cred: MetaExecutionCredential,
  pageId: string,
  accountId: string,
): Promise<{ token: string; usage_pct: number | null }> {
  const { body, usage_pct } = await metaCall(
    ctx,
    { bearer: cred.access_token },
    "page",
    { page_id: pageId },
    { fields: "id,access_token" },
    `Page ${pageId}`,
    { account_id: accountId },
  );
  const token = stringId(body, "access_token");
  if (token === null) {
    throw new PublishError(
      `No Page token could be had for Page ${pageId}. Reconnect Meta publishing on Connections. Nothing was published.`,
    );
  }
  return { token, usage_pct };
}

async function facebookPermalink(
  ctx: Context,
  token: string,
  postId: string,
  accountId: string,
): Promise<string> {
  try {
    const body = await metaRequest(
      ctx,
      { bearer: token },
      "page_post",
      { post_id: postId },
      { fields: "permalink_url" },
      "the post",
      { account_id: accountId },
    );
    return stringId(body, "permalink_url") ?? `https://www.facebook.com/${postId}`;
  } catch {
    // The post is up; a missing link is not a failed publish.
    return `https://www.facebook.com/${postId}`;
  }
}

/** Facebook: feed (text), photos (url = the Blob public URL), or a Reel by resumable upload. */
async function publishFacebook(
  ctx: Context,
  args: {
    pageId: string;
    pageToken: string;
    op: PublishOp;
    mediaUrl: string | null;
    link: string | null;
    caption: string;
    hooks: PublishHooks;
  },
): Promise<PublishedPost> {
  const { pageId, pageToken, op, caption, hooks } = args;
  const who = { account_id: hooks.account_id };
  const bearer = { bearer: pageToken };
  const page = { page_id: pageId };
  const reach = `Page ${pageId}`;

  if (op === "publish_page_post") {
    await stopBeforePublish(hooks);
    await hooks.note({ sent_at: new Date().toISOString() });
    const fields = args.link ? { message: caption, link: args.link } : { message: caption };
    const body = await metaRequest(ctx, bearer, "page_feed", page, fields, reach, {
      ...who,
      publishing: true,
    });
    const id = stringId(body, "id");
    if (id === null) throw new MetaNoAnswerError("page_feed");
    return {
      platform: "facebook",
      platform_post_id: id,
      url: await facebookPermalink(ctx, pageToken, id, hooks.account_id),
    };
  }

  const mediaUrl = args.mediaUrl;
  if (mediaUrl === null) throw new PublishError("this post has no media — nothing was sent");

  if (op === "publish_page_photo") {
    await stopBeforePublish(hooks);
    await hooks.note({ sent_at: new Date().toISOString() });
    const body = await metaRequest(
      ctx,
      bearer,
      "page_photos",
      page,
      { url: mediaUrl, message: caption },
      reach,
      { ...who, publishing: true },
    );
    const id = stringId(body, "post_id") ?? stringId(body, "id");
    if (id === null) throw new MetaNoAnswerError("page_photos");
    return {
      platform: "facebook",
      platform_post_id: id,
      url: await facebookPermalink(ctx, pageToken, id, hooks.account_id),
    };
  }

  // publish_page_video — a Reel, by Meta's resumable upload: start, upload by URL, finish.
  await stopBeforePublish(hooks);
  const start = await metaRequest(
    ctx,
    bearer,
    "page_reels",
    page,
    { upload_phase: "start" },
    reach,
    who,
  );
  const videoId = stringId(start, "video_id");
  if (videoId === null) {
    throw new PublishError("Facebook didn't open an upload for the Reel. Nothing was published.");
  }
  await hooks.note({ video_id: videoId });
  await stopBeforePublish(hooks);
  const uploaded = await metaRequest(
    ctx,
    { oauth: pageToken, headers: { file_url: mediaUrl } },
    "reel_upload",
    { video_id: videoId },
    {},
    reach,
    who,
  );
  if (uploaded["success"] !== true) {
    throw new PublishError("Facebook didn't take the Reel's upload. Nothing was published.");
  }
  await stopBeforePublish(hooks);
  await hooks.note({ sent_at: new Date().toISOString() });
  const finished = await metaRequest(
    ctx,
    bearer,
    "page_reels",
    page,
    { upload_phase: "finish", video_id: videoId, video_state: "PUBLISHED", description: caption },
    reach,
    { ...who, publishing: true },
  );
  if (finished["success"] !== true) throw new MetaNoAnswerError("page_reels");
  return {
    platform: "facebook",
    platform_post_id: videoId,
    url: `https://www.facebook.com/reel/${videoId}`,
  };
}

/** One Instagram container — the ONLY way one is made. is_ai_generated goes last, so nothing overrides it. */
async function igContainer(
  ctx: Context,
  token: string,
  igUserId: string,
  params: Record<string, string>,
  accountId: string,
): Promise<string> {
  const body = await metaRequest(
    ctx,
    { bearer: token },
    "ig_container",
    { ig_user_id: igUserId },
    { ...params, is_ai_generated: "true" },
    `Instagram account ${igUserId}`,
    { account_id: accountId },
  );
  const id = stringId(body, "id");
  if (id === null) {
    throw new PublishError(
      "Instagram didn't create a container for the post. Nothing was published.",
    );
  }
  return id;
}

/** Poll status_code until FINISHED — capped at IG_POLL_MAX, with backoff. Never publishes. */
async function igWaitFinished(
  ctx: Context,
  token: string,
  containerId: string,
  accountId: string,
): Promise<void> {
  for (let poll = 1; poll <= IG_POLL_MAX; poll += 1) {
    const body = await metaRequest(
      ctx,
      { bearer: token },
      "ig_container_status",
      { container_id: containerId },
      { fields: "status_code" },
      "the Instagram container",
      { account_id: accountId },
    );
    const status = stringId(body, "status_code");
    if (status === "FINISHED") return;
    if (status !== "IN_PROGRESS") {
      throw new PublishError(
        `Instagram couldn't process the media (${status ?? "no status"}). Nothing was published.`,
      );
    }
    if (poll < IG_POLL_MAX) await ctx.sleep(Math.min(1000 * 2 ** (poll - 1), 15_000));
  }
  throw new PublishError(
    "Instagram was still processing the media when SYB stopped waiting. Nothing was published.",
  );
}

/**
 * Instagram: container → poll status_code → media_publish. One image (JPEG
 * only), one Reel, or a CAROUSEL of up to ten — the parent's id is what is
 * published and, for undo, what is deleted.
 */
async function publishInstagram(
  ctx: Context,
  args: {
    igUserId: string;
    token: string;
    media: readonly string[];
    caption: string;
    hooks: PublishHooks;
  },
): Promise<PublishedPost> {
  const { igUserId, token, caption, hooks } = args;
  const kinds = args.media.map((url) => ({ url, kind: mediaKindOf(url) }));
  if (kinds.length === 0 || kinds.length > 10) {
    throw new PublishError("Instagram takes one to ten images or videos. Nothing was sent.");
  }
  for (const m of kinds) {
    if (m.kind === null)
      throw new PublishError("Instagram can't take this file type. Nothing was sent.");
    if (m.kind === "image/png") {
      throw new PublishError(
        "Instagram takes JPEG images only, and this one is a PNG. Nothing was sent.",
      );
    }
  }

  let creation: string;
  const first = kinds[0] as { url: string; kind: MediaKind };
  if (kinds.length === 1) {
    await stopBeforePublish(hooks);
    creation = await igContainer(
      ctx,
      token,
      igUserId,
      first.kind === "video"
        ? { media_type: "REELS", video_url: first.url, caption }
        : { image_url: first.url, caption },
      hooks.account_id,
    );
  } else {
    const children: string[] = [];
    for (const m of kinds) {
      // P3-24c: the stop before every child, and before the parent.
      await stopBeforePublish(hooks);
      const child = await igContainer(
        ctx,
        token,
        igUserId,
        m.kind === "video"
          ? { media_type: "VIDEO", video_url: m.url, is_carousel_item: "true" }
          : { image_url: m.url, is_carousel_item: "true" },
        hooks.account_id,
      );
      await igWaitFinished(ctx, token, child, hooks.account_id);
      children.push(child);
    }
    await stopBeforePublish(hooks);
    creation = await igContainer(
      ctx,
      token,
      igUserId,
      { media_type: "CAROUSEL", children: children.join(","), caption },
      hooks.account_id,
    );
  }
  await hooks.note({ container_id: creation });
  await igWaitFinished(ctx, token, creation, hooks.account_id);

  // The last check, before media_publish: a stop seen here leaves every
  // container unpublished, and Meta discards an unpublished container itself.
  await stopBeforePublish(hooks);
  await hooks.note({ sent_at: new Date().toISOString() });
  const published = await metaRequest(
    ctx,
    { bearer: token },
    "ig_publish",
    { ig_user_id: igUserId },
    { creation_id: creation },
    `Instagram account ${igUserId}`,
    { account_id: hooks.account_id, publishing: true },
  );
  const mediaId = stringId(published, "id");
  if (mediaId === null) throw new MetaNoAnswerError("ig_publish");
  let url: string | null = null;
  try {
    const media = await metaRequest(
      ctx,
      { bearer: token },
      "ig_media",
      { ig_media_id: mediaId },
      { fields: "permalink" },
      "the Instagram post",
      { account_id: hooks.account_id },
    );
    url = stringId(media, "permalink");
  } catch {
    // Published; the link is a nicety.
  }
  return { platform: "instagram", platform_post_id: mediaId, url };
}

function sinceSeconds(sentAt: string): string {
  return String(Math.floor(Date.parse(sentAt) / 1000) - READBACK_SKEW_S);
}

function listData(body: Record<string, unknown>): Record<string, unknown>[] {
  const data = body["data"];
  return Array.isArray(data)
    ? data.filter((d): d is Record<string, unknown> => d !== null && typeof d === "object")
    : [];
}

/**
 * P3-21d: was it posted? Reads only. Found → the post; provably never sent
 * → not_sent; anything else → uncertain, for the owner to check by hand.
 */
async function readBack(
  ctx: Context,
  args: {
    cred: MetaExecutionCredential;
    platform: PublishPlatform;
    targetId: string;
    item: PublishItem;
    accountId: string;
  },
): Promise<ReconcileOutcome> {
  const { cred, platform, targetId, item, accountId } = args;
  const attempt = item.publish_attempt;
  const uncertain: ReconcileOutcome = { kind: "uncertain", sentence: MAY_HAVE_POSTED[platform] };
  if (!attempt?.sent_at) return { kind: "not_sent", sentence: NEVER_SENT };
  const who = { account_id: accountId };
  try {
    if (platform === "facebook") {
      const { token } = await pageAccess(ctx, cred, targetId, accountId);
      if (attempt.video_id) {
        const body = await metaRequest(
          ctx,
          { bearer: token },
          "reel_status",
          { video_id: attempt.video_id },
          { fields: "status" },
          "the Reel",
          who,
        );
        const status = (body["status"] ?? {}) as {
          video_status?: unknown;
          publishing_phase?: { status?: unknown };
        };
        if (status.publishing_phase?.status === "complete") {
          return {
            kind: "found",
            post: {
              platform,
              platform_post_id: attempt.video_id,
              url: `https://www.facebook.com/reel/${attempt.video_id}`,
            },
          };
        }
        if (status.video_status === "error") {
          return {
            kind: "not_sent",
            sentence: "Facebook couldn't process the Reel. Nothing was published.",
          };
        }
        return uncertain;
      }
      const body = await metaRequest(
        ctx,
        { bearer: token },
        "page_published_posts",
        { page_id: targetId },
        {
          fields: "id,message,created_time,permalink_url",
          since: sinceSeconds(attempt.sent_at),
          limit: "25",
        },
        `Page ${targetId}`,
        who,
      );
      const ours = listData(body).filter(
        (p) =>
          typeof p["message"] === "string" && captionHash(p["message"]) === attempt.caption_sha256,
      );
      const only = ours.length === 1 ? ours[0] : undefined;
      const id = only ? stringId(only, "id") : null;
      if (only && id) {
        return {
          kind: "found",
          post: {
            platform,
            platform_post_id: id,
            url: stringId(only, "permalink_url") ?? `https://www.facebook.com/${id}`,
          },
        };
      }
      return uncertain;
    }

    if (!attempt.container_id) return { kind: "not_sent", sentence: NEVER_SENT };
    const container = await metaRequest(
      ctx,
      { bearer: cred.access_token },
      "ig_container_status",
      { container_id: attempt.container_id },
      { fields: "status_code" },
      "the Instagram container",
      who,
    );
    const status = stringId(container, "status_code");
    if (status === "FINISHED" || status === "ERROR" || status === "EXPIRED") {
      return { kind: "not_sent", sentence: "Instagram never published it. Nothing went out." };
    }
    if (status !== "PUBLISHED") return uncertain;
    const list = await metaRequest(
      ctx,
      { bearer: cred.access_token },
      "ig_media_list",
      { ig_user_id: targetId },
      { fields: "id,caption,timestamp,permalink", limit: "25" },
      `Instagram account ${targetId}`,
      who,
    );
    const floor = Date.parse(attempt.sent_at) - READBACK_SKEW_S * 1000;
    const ours = listData(list).filter(
      (m) =>
        typeof m["caption"] === "string" &&
        captionHash(m["caption"]) === attempt.caption_sha256 &&
        typeof m["timestamp"] === "string" &&
        Date.parse(m["timestamp"]) >= floor,
    );
    const only = ours.length === 1 ? ours[0] : undefined;
    const id = only ? stringId(only, "id") : null;
    return only && id
      ? {
          kind: "found",
          post: { platform, platform_post_id: id, url: stringId(only, "permalink") },
        }
      : uncertain;
  } catch {
    // Can't read back right now: still unknown, still never re-sent.
    return uncertain;
  }
}

/** The meta_publish executor, and the sweep's read-back (P3-21d). */
export interface MetaPublishProvider extends ExecutionProvider {
  /**
   * Read back a `publishing` item and record what is found on the item.
   * Reads only; never posts. `params` are the approved plan's, as for execute.
   */
  reconcile(params: Record<string, unknown>, ctx: ExecutionContext): Promise<ReconcileOutcome>;
}

function logPublish(event: Record<string, unknown>): void {
  console.log(JSON.stringify({ event: "content_publish", ...event }));
}

function publishProvider(
  ctx: Context,
  loadBackend: () => Promise<PublishBackend>,
): MetaPublishProvider {
  const now = () => new Date();

  async function liveCredential(
    b: PublishBackend,
    accountId: string,
    p: Pick<PublishParams, "platform" | "target_id">,
  ): Promise<MetaExecutionCredential> {
    const cred = await b.credential(accountId);
    if ("refused" in cred) throw new PublishError(cred.refused);
    const current = p.platform === "facebook" ? cred.page_id : cred.ig_user_id;
    if (current !== p.target_id) {
      throw new PublishError(
        `You approved this for ${PLATFORM_LABEL[p.platform]} account ${p.target_id}, but the Meta connection now points at ${current ?? "none"}. Nothing was sent; it needs approving again.`,
      );
    }
    return cred;
  }

  function expectOp(op: string, platform: PublishPlatform, item: PublishItem): PublishOp {
    const want = publishOpFor(platform, item.media_path);
    if (want === null || want !== op) {
      throw new PublishError(
        `This item can't go out as "${op}" on ${PLATFORM_LABEL[platform]}. Nothing was sent.`,
      );
    }
    return want;
  }

  async function settle(
    b: PublishBackend,
    outcome: ReconcileOutcome,
    item: PublishItem,
    pctx: ExecutionContext,
    platform: PublishPlatform,
  ): Promise<PublishedPost> {
    const accountId = pctx.account_id;
    logPublish({
      account_id: accountId,
      platform,
      item_id: item.id,
      execution_id: pctx.execution_id ?? null,
      attempt: pctx.attempt ?? null,
      phase: "reconcile",
      outcome: outcome.kind,
    });
    if (outcome.kind === "found") {
      await b.published(item, outcome.post, accountId);
      return outcome.post;
    }
    if (outcome.kind === "not_sent") await b.failed(item.id, outcome.sentence);
    else await b.uncertain(item.id, outcome.sentence);
    throw new PublishError(outcome.sentence, false);
  }

  return {
    id: "meta_publish",
    external: true,

    async preflight(op, params, pctx) {
      const b = await loadBackend();
      let p: PublishParams;
      try {
        p = publishParams(params);
      } catch (error) {
        return { code: "refused", message: (error as Error).message };
      }
      const item = await b.item(p.item_id, pctx.profile_id);
      if (!item)
        return { code: "refused", message: "the item to publish is gone — nothing was sent" };
      // Mid-flight or done: execute settles it (read back, or the stored result).
      if (item.status === "publishing" || item.status === "published") return null;
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
      if (item.status !== "drafted" && item.status !== "queued") {
        return {
          code: "refused",
          message: `it is ${item.status}, so it isn't published — nothing was sent`,
        };
      }
      try {
        expectOp(op, p.platform, item);
        if (p.platform === "instagram") {
          const kind = item.media_path ? mediaKindOf(item.media_path) : null;
          if (kind === "image/png") {
            return refuse({
              code: "refused",
              message: "Instagram takes JPEG images only, and this one is a PNG. Nothing was sent.",
            });
          }
          if (publishCaption(item).length > IG_CAPTION_MAX) {
            return refuse({
              code: "refused",
              message: `Instagram captions stop at ${IG_CAPTION_MAX} characters, and this one is longer. Nothing was sent.`,
            });
          }
        }
        const cred = await liveCredential(b, pctx.account_id, p);
        if (p.platform === "facebook") {
          const { usage_pct } = await pageAccess(ctx, cred, p.target_id, pctx.account_id);
          if (usage_pct !== null && usage_pct >= META_USAGE_BACKOFF_PCT) {
            return refuse({
              code: "deferred",
              message: `Meta says this Page has used ${usage_pct}% of its limit for now. Nothing was sent; it goes out on the next run.`,
            });
          }
        } else {
          const { body, usage_pct } = await metaCall(
            ctx,
            { bearer: cred.access_token },
            "ig_publishing_limit",
            { ig_user_id: p.target_id },
            { fields: "quota_usage,config" },
            `Instagram account ${p.target_id}`,
            { account_id: pctx.account_id },
          );
          const row = listData(body)[0] ?? {};
          const used = typeof row["quota_usage"] === "number" ? row["quota_usage"] : 0;
          const config = (row["config"] ?? {}) as { quota_total?: unknown };
          const total =
            typeof config.quota_total === "number" ? config.quota_total : IG_DAILY_PUBLISH_LIMIT;
          if (used >= total) {
            return refuse({
              code: "deferred",
              message: `Instagram's limit of ${total} posts a day through the API is used up for this account. Nothing was sent; it goes out on the next run.`,
            });
          }
          if (usage_pct !== null && usage_pct >= META_USAGE_BACKOFF_PCT) {
            return refuse({
              code: "deferred",
              message: `Meta says this account has used ${usage_pct}% of its limit for now. Nothing was sent; it goes out on the next run.`,
            });
          }
        }
        return null;
      } catch (error) {
        if (error instanceof MetaRequestError && pausesConnection(error.failure)) {
          // P3-24b: the sign-in is gone. The connection pauses itself and
          // this item, with every other queued one, waits for the reconnect.
          await b.paused({ account_id: pctx.account_id, failure: error.failure });
          logPublish({
            account_id: pctx.account_id,
            platform: p.platform,
            item_id: item.id,
            phase: "preflight",
            outcome: "paused",
          });
          return { code: "refused", message: PAUSED_WORK_SENTENCE.publish };
        }
        if (error instanceof MetaRequestError) {
          return refuse({
            code: error.failure.retryable ? "deferred" : "refused",
            message: `${error.failure.owner_sentence}${error.failure.retryable ? "" : " Nothing was sent."}`,
          });
        }
        if (error instanceof PublishError)
          return refuse({ code: "refused", message: error.message });
        throw error;
      }
    },

    async captureUndo(_op, params, pctx) {
      const b = await loadBackend();
      const p = publishParams(params);
      const item = await b.item(p.item_id, pctx.profile_id);
      if (!item) throw new PublishError("the item to publish is gone — nothing was sent");
      // {platform, target ids}, before attempt one (rule 16). The post's own
      // id lands on the item when Meta gives it; undo reads it from there.
      return {
        platform: p.platform,
        item_id: item.id,
        target: p.platform === "facebook" ? { page_id: p.target_id } : { ig_user_id: p.target_id },
      };
    },

    async execute(op, params, pctx) {
      const b = await loadBackend();
      const p = publishParams(params);
      const item = await b.item(p.item_id, pctx.profile_id);
      if (!item) throw new PublishError("the item to publish is gone — nothing was sent");
      if (item.status === "published" && item.platform_post_id !== null) {
        return {
          platform: p.platform,
          platform_post_id: item.platform_post_id,
          url: item.platform_url,
        } satisfies PublishedPost;
      }
      const cred = await liveCredential(b, pctx.account_id, p);
      // Something was in flight — from this run's earlier attempt or a run
      // that died. Read back; never send it again (P3-21d).
      if (item.status === "publishing") {
        const outcome = await readBack(ctx, {
          cred,
          platform: p.platform,
          targetId: p.target_id,
          item,
          accountId: pctx.account_id,
        });
        return settle(b, outcome, item, pctx, p.platform);
      }
      if (item.status !== "drafted" && item.status !== "queued") {
        throw new PublishError(`it is ${item.status}, so it isn't published — nothing was sent`);
      }
      const publishOp = expectOp(op, p.platform, item);
      const caption = publishCaption(item);
      const attempt: PublishAttempt = {
        started_at: now().toISOString(),
        caption_sha256: captionHash(caption),
      };
      if (!(await b.claim(item.id, pctx.execution_id ?? null, p.platform, attempt))) {
        throw new PublishError("the item changed before it could be sent — nothing was sent");
      }
      const hooks: PublishHooks = {
        account_id: pctx.account_id,
        note: async (patch) => {
          Object.assign(attempt, patch);
          await b.note(item.id, attempt);
        },
        ...(pctx.halted ? { halted: pctx.halted } : {}),
      };
      // P3-24d: exactly one of these per publish attempt, whatever the end.
      const log = (outcome: string) =>
        logPublish({
          account_id: pctx.account_id,
          platform: p.platform,
          item_id: item.id,
          execution_id: pctx.execution_id ?? null,
          attempt: pctx.attempt ?? null,
          op: publishOp,
          phase: "publish",
          outcome,
        });

      try {
        const post =
          p.platform === "facebook"
            ? await publishFacebook(ctx, {
                pageId: p.target_id,
                pageToken: (await pageAccess(ctx, cred, p.target_id, pctx.account_id)).token,
                op: publishOp,
                mediaUrl: item.media_path,
                link: item.link,
                caption,
                hooks,
              })
            : await publishInstagram(ctx, {
                igUserId: p.target_id,
                token: cred.access_token,
                media: item.media_path ? [item.media_path] : [],
                caption,
                hooks,
              });
        try {
          await b.published(item, post, pctx.account_id);
        } catch {
          // Meta has it; our record didn't land. Leave it `publishing` for the read-back.
          log("published_unrecorded");
          throw new PublishError(MAY_HAVE_POSTED[p.platform], true);
        }
        log("published");
        return post;
      } catch (error) {
        if (error instanceof PublishError && error.retryable) throw error;
        // P3-24c: the stop came on between steps. Checked before sent_at is
        // written, so nothing public went out: back to the queue, held "stop".
        if (error instanceof StopError) {
          await b.unclaim(item.id, error.message);
          log("halted");
          throw error;
        }
        // No usable answer to the publishing call, or our own failure after
        // it was sent: it may be up. Stay `publishing`; the engine's next
        // attempt — or the next sweep — reads back instead of re-sending.
        const ours =
          error instanceof MetaRequestError ||
          error instanceof PublishError ||
          error instanceof UndisclosedPublishError;
        if (error instanceof MetaNoAnswerError || (attempt.sent_at !== undefined && !ours)) {
          await b.uncertain(item.id, MAY_HAVE_POSTED[p.platform]);
          log("no_answer");
          throw new PublishError(MAY_HAVE_POSTED[p.platform], true);
        }
        // P3-24b: Meta refused the sign-in — an answer, so nothing went out.
        // The item fails with the one sentence, the connection pauses itself
        // and holds everything queued on it, and the run waits for the reconnect.
        if (error instanceof MetaRequestError && pausesConnection(error.failure)) {
          await b.failed(item.id, PAUSED_WORK_SENTENCE.publish);
          await b.paused({ account_id: pctx.account_id, failure: error.failure, item_id: item.id });
          log("paused");
          throw new ConnectionPausedError(error.failure, "publish");
        }
        // A definite refusal, or anything before the publishing call: nothing went out.
        const sentence =
          error instanceof MetaRequestError
            ? refusalSentence(error.failure)
            : error instanceof PublishError || error instanceof UndisclosedPublishError
              ? error.message
              : "Something went wrong on SYB's side before anything was sent. Nothing was published.";
        await b.failed(item.id, sentence);
        log("failed");
        throw new PublishError(sentence, false);
      }
    },

    async undo(_op, undoPayload, pctx) {
      const b = await loadBackend();
      const u = (undoPayload ?? {}) as {
        platform?: unknown;
        item_id?: unknown;
        target?: { page_id?: unknown; ig_user_id?: unknown };
      };
      if (
        (u.platform !== "facebook" && u.platform !== "instagram") ||
        typeof u.item_id !== "string"
      ) {
        throw new PublishError("the stored undo names no item — nothing was deleted");
      }
      const platform: PublishPlatform = u.platform;
      const targetId = platform === "facebook" ? u.target?.page_id : u.target?.ig_user_id;
      if (typeof targetId !== "string") {
        throw new PublishError("the stored undo names no Page or account — nothing was deleted");
      }
      const item = await b.item(u.item_id, pctx.profile_id);
      if (!item) throw new PublishError("the item is gone — nothing was deleted");
      if (item.status === "withdrawn") return { withdrawn: item.platform_post_id, platform };
      if (item.status !== "published" || item.platform_post_id === null) {
        throw new PublishError(
          `only a published post can be withdrawn — this one is ${item.status}`,
        );
      }
      const cred = await liveCredential(b, pctx.account_id, { platform, target_id: targetId });
      const postId = item.platform_post_id;
      const who = { account_id: pctx.account_id };
      const body =
        platform === "facebook"
          ? await metaRequest(
              ctx,
              { bearer: (await pageAccess(ctx, cred, targetId, pctx.account_id)).token },
              "page_post_delete",
              { post_id: postId },
              {},
              `the post on Page ${targetId}`,
              who,
            )
          : await metaRequest(
              ctx,
              { bearer: cred.access_token },
              "ig_media_delete",
              { ig_media_id: postId },
              {},
              `the post on Instagram account ${targetId}`,
              who,
            );
      if (body["success"] !== true) {
        throw new PublishError(
          `Meta didn't confirm the deletion — check ${platform === "facebook" ? "the Page" : "the Instagram account"}.`,
        );
      }
      await b.withdrawn(item, platform, pctx.account_id);
      logPublish({
        account_id: pctx.account_id,
        item_id: item.id,
        platform,
        phase: "undo",
        outcome: "withdrawn",
      });
      return { withdrawn: postId, platform };
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
            platform: p.platform,
            platform_post_id: item.platform_post_id,
            url: item.platform_url,
          },
        };
      }
      if (item.status !== "publishing")
        return { kind: "not_sent", sentence: `it is ${item.status}` };
      let cred: MetaExecutionCredential;
      try {
        cred = await liveCredential(b, pctx.account_id, p);
      } catch {
        // No live connection to read with: still unknown, and still never re-sent.
        return { kind: "uncertain", sentence: MAY_HAVE_POSTED[p.platform] };
      }
      const outcome = await readBack(ctx, {
        cred,
        platform: p.platform,
        targetId: p.target_id,
        item,
        accountId: pctx.account_id,
      });
      try {
        await settle(b, outcome, item, pctx, p.platform);
      } catch (error) {
        if (!(error instanceof PublishError)) throw error;
      }
      return outcome;
    },
  };
}

/* ══════════ THE AD OPS — P3-22b/c/d (Session D, layer D3) ══════════
 *
 * One approved ad change, in order:
 *
 *   preflight (reads only, before the engine claims anything) — the
 *     connection is live; the campaign is in the connected ad account and
 *     live or paused (never one Meta has deleted or archived); the change
 *     still makes sense (a pause of a paused campaign is refused); a budget
 *     change passes the spend guard (P3-22c) against the live budget; the
 *     access tier is read and stored (P3-22d); Meta's usage headers are
 *     under 75% of the hourly limit, or it is deferred. A refusal here
 *     leaves the proposal approved.
 *   captureUndo (before attempt one, kept forever) — the previous status,
 *     or the previous daily_budget in Meta's own unit.
 *   execute — the campaign read again; a budget change computed from the
 *     CAPTURED previous budget (so a retried attempt can never compound a
 *     +20% into +44%) and guarded again; then the identical call with
 *     execution_options=["validate_only"], refused on any validation error
 *     before anything changes; then the call itself.
 *   undo — the captured status or budget put back, dry run first too.
 *
 * Never sent: DELETED or ARCHIVED (both permanent on Meta — "delete
 * campaign" is not an op), any field AD_WRITE_FIELDS doesn't list (so no
 * spend cap, bid, lifetime budget or anything billing-shaped, rule 18), and
 * a campaign created anything but PAUSED. adWriteViolation refuses each at
 * the one request choke point, and meta.test.ts scans this source for the
 * two forbidden words.
 *
 * Creating is irreversible (registry, labelled "hard" before approval) and
 * at most once: a create that gets no usable answer is never sent again —
 * "I may have created this campaign — check Ads Manager." Going live is a
 * separate resume proposal.
 */

export type AdOp =
  "pause_campaign" | "resume_campaign" | "set_daily_budget" | "create_campaign_paused";

/** The only fields an ad write may carry, per request (rule 18: nothing billing-shaped). */
export const AD_WRITE_FIELDS: Readonly<Partial<Record<MetaExecRequest, readonly string[]>>> = {
  campaign_update: ["status", "daily_budget", "execution_options"],
  campaign_create: [
    "name",
    "objective",
    "status",
    "special_ad_categories",
    "buying_type",
    "daily_budget",
    "execution_options",
  ],
};

/** The only campaign statuses SYB ever sends. Meta's other two are permanent. */
export const AD_STATUSES: readonly string[] = ["PAUSED", "ACTIVE"];

/** The dry run (docs-verified, task text): the same call, validated and not applied. */
export const VALIDATE_ONLY = '["validate_only"]';

/** Meta's current (ODAX) campaign objectives — _verify at build_ against v26.0. */
export const META_CAMPAIGN_OBJECTIVES: readonly string[] = [
  "OUTCOME_AWARENESS",
  "OUTCOME_TRAFFIC",
  "OUTCOME_ENGAGEMENT",
  "OUTCOME_LEADS",
  "OUTCOME_APP_PROMOTION",
  "OUTCOME_SALES",
];

/** Meta's special ad categories; an empty list means none — _verify at build_. */
export const META_SPECIAL_AD_CATEGORIES: readonly string[] = [
  "EMPLOYMENT",
  "HOUSING",
  "FINANCIAL_PRODUCTS_SERVICES",
  "ISSUES_ELECTIONS_POLITICS",
  "ONLINE_GAMBLING_AND_GAMING",
];

export class AdWriteRefusedError extends Error {
  readonly retryable = false;
  constructor(reason: string) {
    super(`meta: refusing an ad write — ${reason}. Nothing was sent.`);
    this.name = "AdWriteRefusedError";
  }
}

/** Pure: why an ad write may not be sent as it stands, or null. Every other request: null. */
export function adWriteViolation(
  which: MetaExecRequest,
  params: Readonly<Record<string, string>>,
): string | null {
  const allowed = AD_WRITE_FIELDS[which];
  if (allowed === undefined) return null;
  for (const key of Object.keys(params)) {
    if (!allowed.includes(key)) return `${which} may not carry "${key}"`;
  }
  const status = params["status"];
  if (status !== undefined && !AD_STATUSES.includes(status)) {
    return `${which} may set a status of PAUSED or ACTIVE only`;
  }
  const options = params["execution_options"];
  if (options !== undefined && options !== VALIDATE_ONLY) {
    return `${which} may carry execution_options only as the validate_only dry run`;
  }
  const budget = params["daily_budget"];
  if (budget !== undefined && !/^[1-9]\d{0,14}$/.test(budget)) {
    return `${which} needs a daily budget as a positive whole number in Meta's unit`;
  }
  if (which === "campaign_update" && status === undefined && budget === undefined) {
    return "campaign_update changes a status or a daily budget, nothing else";
  }
  if (which === "campaign_create") {
    if (status !== "PAUSED")
      return "a campaign is created PAUSED; going live is a separate approval";
    if (params["buying_type"] !== "AUCTION")
      return "a campaign is created with buying_type AUCTION";
    if (!META_CAMPAIGN_OBJECTIVES.includes(params["objective"] ?? "")) {
      return "a campaign needs one of Meta's campaign objectives";
    }
    let categories: unknown;
    try {
      categories = JSON.parse(params["special_ad_categories"] ?? "");
    } catch {
      categories = null;
    }
    if (
      !Array.isArray(categories) ||
      !categories.every((c) => typeof c === "string" && META_SPECIAL_AD_CATEGORIES.includes(c))
    ) {
      return "a campaign needs special_ad_categories as a list of Meta's categories";
    }
    const name = params["name"] ?? "";
    if (name.trim() === "" || name.length > 400) return "a campaign needs a name";
  }
  return null;
}

/**
 * An ad change that ended. `retryable` is read by the engine: false stops
 * its loop. Pause, resume and budget writes set a value, so repeating one
 * is harmless and a transient failure stays retryable; a create never is.
 */
export class AdChangeError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable = false) {
    super(message);
    this.name = "AdChangeError";
    this.retryable = retryable;
  }
}

/** The ad ops' state, held by the database (lib/ads/executing.ts). Injected, as PublishBackend is. */
export interface AdsBackend {
  /** The live meta_ads credential, or the sentence saying why there is none. */
  credential(accountId: string): Promise<MetaExecutionCredential | { refused: string }>;
  /** The undo payload the engine stored before attempt one — a budget change's baseline. */
  capturedUndo(executionId: string): Promise<unknown>;
  /** The owner's stated monthly ad ceiling (8.1i) — the same fact the generator reads. */
  ceiling(profileId: string): Promise<{ amount_minor: number; currency: string } | null>;
  /** The account's measured average day in this currency (the generator's arithmetic), or null. */
  accountDailySpend(accountId: string, currency: string): Promise<number | null>;
  /** P3-22d: the access tier Meta last reported, stored on the execute connection. */
  sawTier(accountId: string, tier: string): Promise<void>;
  /** One watch-log line for the owner: "Paused "Spring sale" on Meta." */
  changed(profileId: string, detail: string, meta: Record<string, unknown>): Promise<void>;
  /** P3-24b: Meta refused the connection's sign-in — pause the ad connection. */
  paused(args: { account_id: string; failure: MetaFailure }): Promise<void>;
}

/** Back off once Meta reports this much of the ad account's hourly limit used (P3-22d). */
export const META_ADS_BACKOFF_PCT = 75;

/**
 * P3-22d, pure: Meta's published hourly call limit for ads management at
 * standard access, per ad account — 300 + 40 × active ads (rate-limiting
 * page, read 2026-10-19; the task text calls this tier "Limited Access").
 */
export function adsHourlyCallLimit(activeAds: number): number {
  return 300 + 40 * Math.max(0, Math.floor(activeAds));
}

interface CampaignState {
  id: string;
  name: string;
  account_id: string;
  status: string;
  objective: string | null;
  /** Meta's own unit (offset), or null when the budget sits on the ad sets. */
  daily_budget: number | null;
  lifetime_budget: number | null;
}

interface AccountState {
  currency: string;
  /** The account's reported minimum daily budget, in SYB minor units, when Meta reports one. */
  min_daily_minor: number | null;
}

const CAMPAIGN_FIELDS = "id,name,account_id,status,objective,daily_budget,lifetime_budget";
/** min_daily_budget: an AdAccount field per the Marketing API reference — _verify at build_. */
const ACCOUNT_FIELDS = "id,currency,min_daily_budget";

function metaInt(v: unknown): number | null {
  const raw = typeof v === "number" ? String(v) : v;
  if (typeof raw !== "string" || !/^\d{1,15}$/.test(raw)) return null;
  const n = Number(raw);
  return n > 0 ? n : null;
}

function campaignIdOf(params: Record<string, unknown>): string {
  const id = params["campaign_id"];
  if (typeof id !== "string" || !/^\d{5,}$/.test(id)) {
    throw new AdChangeError("the ad change names no campaign — nothing was sent");
  }
  return id;
}

/** The approved change's scale: +0.2 = raise by 20%. */
function shareOf(params: Record<string, unknown>): number {
  const share = params["share"];
  if (typeof share !== "number" || !Number.isFinite(share) || share === 0) {
    throw new AdChangeError("the budget change names no amount — nothing was sent");
  }
  return share;
}

function approvedCurrency(params: Record<string, unknown>): string {
  const c = params["currency"];
  if (typeof c !== "string" || !/^[A-Za-z]{3}$/.test(c)) {
    throw new AdChangeError("the budget change names no currency — nothing was sent");
  }
  return c.toUpperCase();
}

interface CreateParams {
  name: string;
  objective: string;
  special_ad_categories: string[];
  daily_budget_minor: number | null;
  currency: string | null;
}

function createParams(params: Record<string, unknown>): CreateParams {
  const name = params["name"];
  const objective = params["objective"];
  const categories = params["special_ad_categories"];
  if (typeof name !== "string" || name.trim() === "" || name.length > 400) {
    throw new AdChangeError("the new campaign has no name — nothing was sent");
  }
  if (typeof objective !== "string" || !META_CAMPAIGN_OBJECTIVES.includes(objective)) {
    throw new AdChangeError("the new campaign has no objective Meta accepts — nothing was sent");
  }
  if (
    !Array.isArray(categories) ||
    !categories.every((c) => typeof c === "string" && META_SPECIAL_AD_CATEGORIES.includes(c))
  ) {
    throw new AdChangeError(
      "the new campaign's special ad categories aren't Meta's — nothing was sent",
    );
  }
  const budget = params["daily_budget_minor"];
  const hasBudget = budget !== undefined && budget !== null;
  if (hasBudget && (typeof budget !== "number" || !Number.isSafeInteger(budget) || budget <= 0)) {
    throw new AdChangeError(
      "the new campaign's daily budget isn't a whole amount — nothing was sent",
    );
  }
  return {
    name: name.trim(),
    objective,
    special_ad_categories: categories as string[],
    daily_budget_minor: hasBudget ? (budget as number) : null,
    currency: hasBudget ? approvedCurrency(params) : null,
  };
}

function isAdOp(op: string): op is AdOp {
  return (
    op === "pause_campaign" ||
    op === "resume_campaign" ||
    op === "set_daily_budget" ||
    op === "create_campaign_paused"
  );
}

const STATUS_WORD: Readonly<Record<string, string>> = { PAUSED: "paused", ACTIVE: "active" };

function logAdChange(event: Record<string, unknown>): void {
  console.log(JSON.stringify({ event: "ad_change", ...event }));
}

/** A Meta refusal as the owner reads it, for an ad change. */
function adRefusal(failure: MetaFailure, dryRun: boolean): AdChangeError {
  if (dryRun && failure.kind === "unknown") {
    return new AdChangeError(
      `Meta's dry run refused this change${failure.code !== null ? ` (code ${failure.code})` : ""}, so it was never sent for real. Nothing was changed.`,
    );
  }
  return new AdChangeError(
    failure.retryable && failure.kind !== "unavailable"
      ? "Meta kept asking SYB to slow down. Nothing was changed — I'll try again."
      : failure.owner_sentence,
    failure.retryable,
  );
}

function adsProvider(ctx: Context, loadBackend: () => Promise<AdsBackend>): ExecutionProvider {
  /** One run's calls: the credential, and what Meta reported about limits and tier. */
  interface Run {
    b: AdsBackend;
    cred: MetaExecutionCredential;
    account_id: string;
    usage_pct: number | null;
    access_tier: string | null;
    /** P3-24c: the engine's stop check, between the dry run and the write. */
    halted?: () => Promise<boolean>;
  }

  async function open(accountId: string): Promise<Run> {
    const b = await loadBackend();
    const cred = await b.credential(accountId);
    if ("refused" in cred) throw new AdChangeError(cred.refused);
    if (cred.ad_account_id === null) {
      throw new AdChangeError(
        "The Meta ad connection names no ad account. Reconnect it on Connections; nothing was changed.",
      );
    }
    return { b, cred, account_id: accountId, usage_pct: null, access_tier: null };
  }

  async function call(
    run: Run,
    which: MetaExecRequest,
    ids: Readonly<Record<string, string>>,
    params: Record<string, string>,
    reach: string,
    options: { publishing?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    const r = await metaCall(ctx, { bearer: run.cred.access_token }, which, ids, params, reach, {
      account_id: run.account_id,
      subject: "ad_change",
      ...options,
    });
    if (r.usage_pct !== null) run.usage_pct = Math.max(run.usage_pct ?? 0, r.usage_pct);
    if (r.access_tier !== null) {
      run.access_tier = r.access_tier;
      try {
        await run.b.sawTier(run.account_id, r.access_tier);
      } catch {
        // The tier is a fact worth showing, never a reason to fail a change.
      }
    }
    return r.body;
  }

  /** The campaign, proven to sit in the connected ad account. */
  async function readCampaign(run: Run, campaignId: string): Promise<CampaignState> {
    const body = await call(
      run,
      "campaign",
      { campaign_id: campaignId },
      { fields: CAMPAIGN_FIELDS },
      `campaign ${campaignId}`,
    );
    const account = String(body["account_id"] ?? "").replace(/^act_/, "");
    if (String(body["id"] ?? "") !== campaignId || account !== run.cred.ad_account_id) {
      throw new AdChangeError(
        `Campaign ${campaignId} isn't in the connected ad account (act_${run.cred.ad_account_id}). Nothing was changed.`,
      );
    }
    return {
      id: campaignId,
      name: typeof body["name"] === "string" && body["name"] !== "" ? body["name"] : campaignId,
      account_id: account,
      status: typeof body["status"] === "string" ? body["status"] : "UNKNOWN",
      objective: typeof body["objective"] === "string" ? body["objective"] : null,
      daily_budget: metaInt(body["daily_budget"]),
      lifetime_budget: metaInt(body["lifetime_budget"]),
    };
  }

  async function readAccount(run: Run): Promise<AccountState> {
    const account = run.cred.ad_account_id as string;
    const body = await call(
      run,
      "ad_account",
      { ad_account_id: account },
      { fields: ACCOUNT_FIELDS },
      `ad account act_${account}`,
    );
    const currency = typeof body["currency"] === "string" ? body["currency"].toUpperCase() : "";
    if (!/^[A-Z]{3}$/.test(currency)) {
      throw new AdChangeError(
        "Meta didn't say which currency the ad account bills in. Nothing was changed.",
      );
    }
    const min = metaInt(body["min_daily_budget"]);
    return { currency, min_daily_minor: min === null ? null : fromMetaBudget(min, currency) };
  }

  /** Only a live or paused campaign is touched; Meta's other states are permanent. */
  function touchable(c: CampaignState): void {
    if (!AD_STATUSES.includes(c.status)) {
      throw new AdChangeError(
        `"${c.name}" is ${c.status.toLowerCase()} on Meta, and SYB only pauses, resumes or re-budgets live and paused campaigns. Nothing was changed.`,
      );
    }
  }

  /**
   * P3-22c inside the executor: the new budget from a baseline, in Meta's
   * unit, through the same spend guard the generator ran — ±50%, Meta's
   * floor, the owner's ceiling. Throws the refusal, naming the number.
   */
  async function guardedBudget(
    run: Run,
    args: {
      profile_id: string;
      campaign: CampaignState;
      account: AccountState;
      baseline_minor: number;
      share: number;
      currency: string;
    },
  ): Promise<{ meta_value: number; sent_minor: number }> {
    const { account, currency } = args;
    if (account.currency !== currency) {
      throw new AdChangeError(
        `You approved this change in ${currency}, but the ad account bills in ${account.currency}. Nothing was changed; it needs approving again.`,
      );
    }
    const target = Math.round(args.baseline_minor * (1 + args.share));
    const { meta_value, sent_minor } = toMetaBudget(target, currency);
    const floor = dailyBudgetFloor(currency, account.min_daily_minor);
    if (floor === null) {
      throw new AdChangeError(
        `I don't know Meta's minimum daily budget in ${currency}, so I won't set one. Nothing was changed.`,
      );
    }
    const ceiling = await run.b.ceiling(args.profile_id);
    const accountDaily = ceiling ? await run.b.accountDailySpend(run.account_id, currency) : null;
    const refusal = spendGuard({
      current_daily_minor: args.baseline_minor,
      proposed_daily_minor: sent_minor,
      currency,
      ...(accountDaily !== null ? { account_daily_minor: accountDaily } : {}),
      monthly_ceiling: ceiling,
      floor_minor: floor,
    });
    if (refusal !== null) {
      throw new AdChangeError(
        `I didn't change "${args.campaign.name}": ${refusal}. Nothing was changed.`,
      );
    }
    return { meta_value, sent_minor };
  }

  /** The identical call with validate_only first, refused on any error before anything changes. */
  async function validatedWrite(
    run: Run,
    which: "campaign_update" | "campaign_create",
    ids: Readonly<Record<string, string>>,
    fields: Record<string, string>,
    reach: string,
  ): Promise<Record<string, unknown>> {
    try {
      await call(run, which, ids, { ...fields, execution_options: VALIDATE_ONLY }, reach);
    } catch (error) {
      // A refused sign-in pauses the connection (P3-24b): passed up as it is.
      if (error instanceof MetaRequestError && !pausesConnection(error.failure)) {
        throw adRefusal(error.failure, true);
      }
      throw error;
    }
    // P3-24c: the stop, between Meta's dry run and the real change.
    await checkStop(run.halted, STOPPED_BEFORE_CHANGE);
    try {
      return await call(run, which, ids, fields, reach, {
        // A create that gets no usable answer is never sent again (at most once).
        ...(which === "campaign_create" ? { publishing: true } : {}),
      });
    } catch (error) {
      if (error instanceof MetaNoAnswerError) {
        throw new AdChangeError(
          "I may have created this campaign — check Ads Manager. Meta didn't confirm it, and I won't create it again.",
        );
      }
      if (error instanceof MetaRequestError && !pausesConnection(error.failure)) {
        const refusal = adRefusal(error.failure, false);
        throw which === "campaign_create" ? new AdChangeError(refusal.message) : refusal;
      }
      throw error;
    }
  }

  /** P3-24b: a refused sign-in pauses the ad connection; the change waits for the reconnect. */
  async function pauseOn(error: unknown, accountId: string): Promise<ConnectionPausedError | null> {
    if (!(error instanceof MetaRequestError) || !pausesConnection(error.failure)) return null;
    const b = await loadBackend();
    await b.paused({ account_id: accountId, failure: error.failure });
    return new ConnectionPausedError(error.failure, "ad_change");
  }

  async function setStatus(run: Run, c: CampaignState, status: string): Promise<void> {
    const body = await validatedWrite(
      run,
      "campaign_update",
      { campaign_id: c.id },
      { status },
      `campaign ${c.id}`,
    );
    if (body["success"] !== true) {
      throw new AdChangeError(
        `Meta didn't confirm the change to "${c.name}" — I'll check again.`,
        true,
      );
    }
  }

  async function setBudget(run: Run, c: CampaignState, metaValue: number): Promise<void> {
    const body = await validatedWrite(
      run,
      "campaign_update",
      { campaign_id: c.id },
      { daily_budget: String(metaValue) },
      `campaign ${c.id}`,
    );
    if (body["success"] !== true) {
      throw new AdChangeError(
        `Meta didn't confirm the change to "${c.name}" — I'll check again.`,
        true,
      );
    }
  }

  const fmt = (minor: number, currency: string) => format(money(minor, currency));

  return {
    id: "meta_ads",
    external: true,

    async preflight(op, params, pctx) {
      const log = (outcome: string, run?: Run) =>
        logAdChange({
          account_id: pctx.account_id,
          op,
          phase: "preflight",
          outcome,
          access_tier: run?.access_tier ?? null,
          usage_pct: run?.usage_pct ?? null,
        });
      let run: Run | undefined;
      try {
        if (!isAdOp(op))
          return { code: "refused", message: `"${op}" is not an ad change SYB makes` };
        run = await open(pctx.account_id);
        if (op === "create_campaign_paused") {
          const p = createParams(params);
          const account = await readAccount(run);
          if (p.daily_budget_minor !== null) {
            if (p.currency !== account.currency) {
              throw new AdChangeError(
                `You approved this budget in ${p.currency}, but the ad account bills in ${account.currency}. Nothing was changed; it needs approving again.`,
              );
            }
            const floor = dailyBudgetFloor(account.currency, account.min_daily_minor);
            const sent = toMetaBudget(p.daily_budget_minor, account.currency).sent_minor;
            if (floor === null || sent < floor) {
              throw new AdChangeError(
                floor === null
                  ? `I don't know Meta's minimum daily budget in ${account.currency}, so I won't set one. Nothing was changed.`
                  : `I didn't create "${p.name}": its daily budget of ${fmt(sent, account.currency)} is under Meta's minimum of ${fmt(floor, account.currency)} a day. Nothing was changed.`,
              );
            }
          }
        } else {
          const c = await readCampaign(run, campaignIdOf(params));
          touchable(c);
          if (op === "pause_campaign" && c.status === "PAUSED") {
            throw new AdChangeError(`"${c.name}" is already paused. Nothing was sent.`);
          }
          if (op === "resume_campaign" && c.status === "ACTIVE") {
            throw new AdChangeError(`"${c.name}" is already running. Nothing was sent.`);
          }
          if (op === "set_daily_budget") {
            if (c.daily_budget === null) {
              throw new AdChangeError(
                `"${c.name}" has its budget on its ad sets, not the campaign, and SYB changes campaign budgets only. Nothing was changed.`,
              );
            }
            const account = await readAccount(run);
            await guardedBudget(run, {
              profile_id: pctx.profile_id,
              campaign: c,
              account,
              baseline_minor: fromMetaBudget(c.daily_budget, account.currency),
              share: shareOf(params),
              currency: approvedCurrency(params),
            });
          }
        }
        if (run.usage_pct !== null && run.usage_pct >= META_ADS_BACKOFF_PCT) {
          log("deferred", run);
          return {
            code: "deferred",
            message: `Meta says this ad account has used ${run.usage_pct}% of its hourly call limit (at standard access Meta allows 300 + 40 × active ads calls an hour). Nothing was sent; it runs on the next run.`,
          };
        }
        log("ok", run);
        return null;
      } catch (error) {
        const paused = await pauseOn(error, pctx.account_id);
        if (paused) {
          log("paused", run);
          return { code: "refused", message: paused.message };
        }
        if (error instanceof MetaRequestError) {
          log("meta_refused", run);
          return {
            code: error.failure.retryable ? "deferred" : "refused",
            message: adRefusal(error.failure, false).message,
          };
        }
        if (error instanceof AdChangeError || error instanceof RangeError) {
          log("refused", run);
          return { code: "refused", message: error.message };
        }
        if (error instanceof UnknownMetaCurrencyError) {
          log("refused", run);
          return { code: "refused", message: error.message };
        }
        throw error;
      }
    },

    async captureUndo(op, params, pctx) {
      // The irreversible op has no undo; the engine never asks for one (registry: reversible false).
      if (op === "create_campaign_paused" || !isAdOp(op)) return null;
      const capture = async (): Promise<unknown> => {
        const run = await open(pctx.account_id);
        const c = await readCampaign(run, campaignIdOf(params));
        touchable(c);
        if (op === "set_daily_budget") {
          if (c.daily_budget === null) {
            throw new AdChangeError(
              `"${c.name}" has no campaign budget to record. Nothing was changed.`,
            );
          }
          const account = await readAccount(run);
          return {
            campaign_id: c.id,
            campaign_name: c.name,
            daily_budget: c.daily_budget,
            daily_budget_minor: fromMetaBudget(c.daily_budget, account.currency),
            currency: account.currency,
          };
        }
        return { campaign_id: c.id, campaign_name: c.name, status: c.status };
      };
      try {
        return await capture();
      } catch (error) {
        // P3-24b: a refused sign-in at capture pauses the connection; the run waits.
        throw (await pauseOn(error, pctx.account_id)) ?? error;
      }
    },

    async execute(op, params, pctx) {
      if (!isAdOp(op)) throw new AdChangeError(`"${op}" is not an ad change SYB makes`);
      const run = await open(pctx.account_id);
      if (pctx.halted) run.halted = pctx.halted;
      const log = (outcome: string, extra: Record<string, unknown> = {}) =>
        logAdChange({
          account_id: pctx.account_id,
          execution_id: pctx.execution_id ?? null,
          op,
          phase: "execute",
          outcome,
          access_tier: run.access_tier,
          usage_pct: run.usage_pct,
          ...extra,
        });
      try {
        if (op === "create_campaign_paused") {
          const p = createParams(params);
          const account = await readAccount(run);
          let budget: { meta_value: number; sent_minor: number } | null = null;
          if (p.daily_budget_minor !== null) {
            if (p.currency !== account.currency) {
              throw new AdChangeError(
                `You approved this budget in ${p.currency}, but the ad account bills in ${account.currency}. Nothing was changed.`,
              );
            }
            budget = toMetaBudget(p.daily_budget_minor, account.currency);
            const floor = dailyBudgetFloor(account.currency, account.min_daily_minor);
            if (floor === null || budget.sent_minor < floor) {
              throw new AdChangeError(
                `I didn't create "${p.name}": its daily budget is under Meta's minimum, or the minimum isn't known. Nothing was changed.`,
              );
            }
          }
          const body = await validatedWrite(
            run,
            "campaign_create",
            { ad_account_id: run.cred.ad_account_id as string },
            {
              name: p.name,
              objective: p.objective,
              status: "PAUSED",
              special_ad_categories: JSON.stringify(p.special_ad_categories),
              buying_type: "AUCTION",
              ...(budget ? { daily_budget: String(budget.meta_value) } : {}),
            },
            `ad account act_${run.cred.ad_account_id}`,
          );
          const id = stringId(body, "id");
          if (id === null) {
            throw new AdChangeError(
              "I may have created this campaign — check Ads Manager. Meta didn't confirm it, and I won't create it again.",
            );
          }
          await run.b.changed(pctx.profile_id, `Created "${p.name}" on Meta, paused.`, {
            campaign_id: id,
            op,
          });
          log("created", { campaign_id: id });
          return {
            campaign_id: id,
            campaign_name: p.name,
            status: "PAUSED",
            ...(budget
              ? { daily_budget_minor: budget.sent_minor, currency: account.currency }
              : {}),
            access_tier: run.access_tier,
          };
        }

        const c = await readCampaign(run, campaignIdOf(params));
        touchable(c);
        if (op === "pause_campaign" || op === "resume_campaign") {
          const target = op === "pause_campaign" ? "PAUSED" : "ACTIVE";
          // Already there: an earlier attempt landed and its answer was lost. Setting a status twice is harmless.
          if (c.status !== target) await setStatus(run, c, target);
          await run.b.changed(
            pctx.profile_id,
            `${target === "PAUSED" ? "Paused" : "Resumed"} "${c.name}" on Meta.`,
            { campaign_id: c.id, op },
          );
          log("changed", { campaign_id: c.id, status: target });
          return {
            campaign_id: c.id,
            campaign_name: c.name,
            status: target,
            previous_status: c.status === target ? null : c.status,
            access_tier: run.access_tier,
          };
        }

        // set_daily_budget — from the budget captured before attempt one, never the live one.
        const captured = (
          pctx.execution_id ? await run.b.capturedUndo(pctx.execution_id) : null
        ) as { daily_budget_minor?: unknown; currency?: unknown } | null;
        const baseline = captured?.daily_budget_minor;
        if (typeof baseline !== "number" || typeof captured?.currency !== "string") {
          throw new AdChangeError(
            "The budget before this change wasn't recorded, so I won't change it. Nothing was changed.",
          );
        }
        const account = await readAccount(run);
        const { meta_value, sent_minor } = await guardedBudget(run, {
          profile_id: pctx.profile_id,
          campaign: c,
          account,
          baseline_minor: baseline,
          share: shareOf(params),
          currency: approvedCurrency(params),
        });
        if (c.daily_budget !== meta_value) await setBudget(run, c, meta_value);
        await run.b.changed(
          pctx.profile_id,
          `Changed "${c.name}"'s daily budget on Meta from ${fmt(baseline, account.currency)} to ${fmt(sent_minor, account.currency)}.`,
          { campaign_id: c.id, op },
        );
        log("changed", { campaign_id: c.id, daily_budget: meta_value });
        return {
          campaign_id: c.id,
          campaign_name: c.name,
          daily_budget_before_minor: baseline,
          daily_budget_minor: sent_minor,
          currency: account.currency,
          sent_daily_budget: meta_value,
          access_tier: run.access_tier,
        };
      } catch (error) {
        if (error instanceof StopError) {
          log("halted");
          throw error;
        }
        const paused = await pauseOn(error, pctx.account_id);
        if (paused) {
          log("paused");
          throw paused;
        }
        log("failed", { error: error instanceof Error ? error.name : "unknown" });
        if (error instanceof MetaRequestError) {
          const refusal = adRefusal(error.failure, false);
          throw op === "create_campaign_paused" ? new AdChangeError(refusal.message) : refusal;
        }
        if (op === "create_campaign_paused" && !(error instanceof AdChangeError)) {
          // Whatever went wrong, a create is never sent twice by the engine's loop.
          throw new AdChangeError(
            error instanceof UnknownMetaCurrencyError
              ? error.message
              : "Something went wrong creating the campaign. Check Ads Manager before approving it again.",
          );
        }
        throw error;
      }
    },

    async undo(op, undoPayload, pctx) {
      const u = (undoPayload ?? {}) as {
        campaign_id?: unknown;
        status?: unknown;
        daily_budget?: unknown;
        daily_budget_minor?: unknown;
        currency?: unknown;
      };
      const run = await open(pctx.account_id);
      const c = await readCampaign(run, campaignIdOf({ campaign_id: u.campaign_id }));
      touchable(c);
      if (op === "pause_campaign" || op === "resume_campaign") {
        if (typeof u.status !== "string" || !AD_STATUSES.includes(u.status)) {
          throw new AdChangeError(
            "the stored undo names no status SYB may set — nothing was changed",
          );
        }
        if (c.status !== u.status) await setStatus(run, c, u.status);
        await run.b.changed(
          pctx.profile_id,
          `Undid: "${c.name}" is ${STATUS_WORD[u.status] ?? u.status} on Meta again.`,
          { campaign_id: c.id, op, undo: true },
        );
        logAdChange({
          account_id: pctx.account_id,
          op,
          phase: "undo",
          outcome: "restored",
          campaign_id: c.id,
          access_tier: run.access_tier,
        });
        return { campaign_id: c.id, status: u.status };
      }
      if (op === "set_daily_budget") {
        const previous = metaInt(u.daily_budget);
        if (previous === null || typeof u.currency !== "string") {
          throw new AdChangeError("the stored undo names no budget — nothing was changed");
        }
        if (c.daily_budget !== previous) await setBudget(run, c, previous);
        const minor =
          typeof u.daily_budget_minor === "number"
            ? u.daily_budget_minor
            : fromMetaBudget(previous, u.currency);
        await run.b.changed(
          pctx.profile_id,
          `Undid: "${c.name}"'s daily budget on Meta is ${fmt(minor, u.currency)} again.`,
          { campaign_id: c.id, op, undo: true },
        );
        logAdChange({
          account_id: pctx.account_id,
          op,
          phase: "undo",
          outcome: "restored",
          campaign_id: c.id,
          access_tier: run.access_tier,
        });
        return { campaign_id: c.id, daily_budget: previous };
      }
      throw new AdChangeError(
        `"${op}" can't be undone — it was labelled irreversible before approval`,
      );
    },
  };
}

/* ══════════ THE READBACK — P3-23a (Session D, layer D4) ══════════
 *
 * One published post's own figures, read through the execute connection's
 * READ-ONLY readback scopes and nothing else. Every request below is a GET
 * (META_EXEC_REQUESTS), and each one relies only on scopes meta_publish
 * declares as readback_scopes — META_READBACK_REQUESTS names them, and
 * meta.test.ts pins that none is a write scope. A token cannot be split, so
 * the guarantee is in what is sent: no insight read touches a write path.
 *
 * What is read, views-based only (Meta retired the *_unique Page metrics on
 * 2026-06-15, and Instagram `impressions` for media created after
 * 2024-07-02 — so neither is ever asked for):
 *
 *   Instagram  GET /{ig-media-id}/insights?metric=views,reach,total_interactions
 *              with the system-user token (instagram_basic,
 *              instagram_manage_insights, pages_read_engagement)
 *   Facebook   GET /{post-id}/insights?metric=post_media_view,post_reactions_by_type_total
 *              with the Page token (read_insights, pages_read_engagement);
 *              Facebook's views-based reach is a *_unique metric, so a
 *              Facebook post carries views and interactions only
 *   FB Reels   NOT read: /{video-id}/video_insights needs
 *              pages_manage_engagement, which this consent does not hold
 *
 * Meta reports post insights as LIFETIME totals (docs read 2026-10-19), so
 * each read is the post's total to date. A metric Meta leaves out is null —
 * "unavailable" is not zero (rule 5). _verify at build_: the exact metric
 * names on v26.0, the response shape (values[0].value vs total_value.value),
 * and whether a system-user token needs ads_read for media of a Page with a
 * Business Manager role (Meta's media-insights page says so).
 */

/** The readback reads, and the readback scopes each one relies on. Never a write scope. */
export const META_READBACK_REQUESTS = {
  page: ["pages_show_list", "pages_read_engagement"],
  page_post_insights: ["read_insights", "pages_read_engagement"],
  ig_media_insights: ["instagram_basic", "instagram_manage_insights", "pages_read_engagement"],
} as const satisfies Partial<Record<MetaExecRequest, readonly string[]>>;

/** Instagram media metrics asked for: views-based, no impressions. */
export const IG_POST_METRICS = ["views", "reach", "total_interactions"] as const;
/** Facebook post metrics asked for: views-based, no *_unique. */
export const FB_POST_METRICS = ["post_media_view", "post_reactions_by_type_total"] as const;

export interface PostInsightsTarget {
  platform: PublishPlatform;
  platform_post_id: string;
  /** A Facebook Reel (published by its video id): not readable under this consent. */
  reel: boolean;
}

/** A post's lifetime totals as Meta reports them; null = Meta gave no figure. */
export interface PostFigures {
  views: number | null;
  reach: number | null;
  interactions: number | null;
}

export type PostInsights = { figures: PostFigures } | { unreadable: string };

export interface MetaReadback {
  /** Read every post's insights. Throws only when the connection itself is refused (auth, permission). */
  read(
    cred: MetaExecutionCredential,
    posts: readonly PostInsightsTarget[],
    accountId: string,
  ): Promise<{ post: PostInsightsTarget; insights: PostInsights }[]>;
}

export const FB_REEL_UNREADABLE =
  "Facebook Reel insights need pages_manage_engagement, which this consent does not hold, so they are not read";

/** A non-negative whole count, or null. */
function count(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : null;
}

/** One insights entry's value: values[0].value, else total_value.value. */
function insightValue(entry: Record<string, unknown>): unknown {
  const values = entry["values"];
  if (Array.isArray(values) && values.length > 0) {
    const first = values[0] as { value?: unknown } | null;
    if (first && first.value !== undefined) return first.value;
  }
  const total = entry["total_value"] as { value?: unknown } | null | undefined;
  return total?.value;
}

function insightEntries(body: Record<string, unknown>): Map<string, unknown> {
  const out = new Map<string, unknown>();
  const data = Array.isArray(body["data"]) ? body["data"] : [];
  for (const d of data) {
    if (d === null || typeof d !== "object") continue;
    const e = d as Record<string, unknown>;
    if (typeof e["name"] === "string") out.set(e["name"], insightValue(e));
  }
  return out;
}

/** Pure: an Instagram media insights answer → figures. Missing metrics stay null. */
export function parseIgInsights(body: Record<string, unknown>): PostFigures {
  const e = insightEntries(body);
  return {
    views: count(e.get("views")),
    reach: count(e.get("reach")),
    interactions: count(e.get("total_interactions")),
  };
}

/** Pure: a Facebook post insights answer → figures. Reactions are summed across types. */
export function parseFbPostInsights(body: Record<string, unknown>): PostFigures {
  const e = insightEntries(body);
  const reactions = e.get("post_reactions_by_type_total");
  let interactions: number | null = null;
  if (reactions !== null && typeof reactions === "object") {
    interactions = 0;
    for (const v of Object.values(reactions as Record<string, unknown>)) {
      interactions += count(v) ?? 0;
    }
  } else if (reactions !== undefined) {
    interactions = count(reactions);
  }
  return { views: count(e.get("post_media_view")), reach: null, interactions };
}

/**
 * A refusal about the connection, not the one post: stop the run. Code 100
 * with subcode 33 ("object does not exist or missing permissions") is what
 * Meta says of a post deleted on the platform, so it stays that post's gap.
 */
function connectionRefused(error: unknown): boolean {
  if (!(error instanceof MetaRequestError)) return false;
  const f = error.failure;
  return f.kind === "auth" || (f.kind === "permission" && f.code !== 100);
}

function readbackCalls(ctx: Context): MetaReadback {
  return {
    async read(cred, posts, accountId) {
      const out: { post: PostInsightsTarget; insights: PostInsights }[] = [];
      let pageToken: string | null = null;
      for (const post of posts) {
        if (post.platform === "facebook" && post.reel) {
          out.push({ post, insights: { unreadable: FB_REEL_UNREADABLE } });
          continue;
        }
        try {
          if (post.platform === "instagram") {
            const body = await metaRequest(
              ctx,
              { bearer: cred.access_token },
              "ig_media_insights",
              { ig_media_id: post.platform_post_id },
              { metric: IG_POST_METRICS.join(",") },
              `Instagram post ${post.platform_post_id}`,
              { account_id: accountId },
            );
            out.push({ post, insights: { figures: parseIgInsights(body) } });
            continue;
          }
          if (cred.page_id === null) {
            out.push({ post, insights: { unreadable: "no Page on this connection" } });
            continue;
          }
          if (pageToken === null) {
            const page = await metaRequest(
              ctx,
              { bearer: cred.access_token },
              "page",
              { page_id: cred.page_id },
              { fields: "id,access_token" },
              `Page ${cred.page_id}`,
              { account_id: accountId },
            );
            pageToken = stringId(page, "access_token");
            if (pageToken === null) {
              throw new MetaRequestError(
                classifyMetaError({ status: 200, code: 200 }),
                `Page ${cred.page_id}`,
              );
            }
          }
          const body = await metaRequest(
            ctx,
            { bearer: pageToken },
            "page_post_insights",
            { post_id: post.platform_post_id },
            { metric: FB_POST_METRICS.join(",") },
            `Facebook post ${post.platform_post_id}`,
            { account_id: accountId },
          );
          out.push({ post, insights: { figures: parseFbPostInsights(body) } });
        } catch (error) {
          if (connectionRefused(error)) throw error;
          // One post Meta won't answer for (deleted on the platform, too new,
          // too few viewers) is that post's gap, not the run's failure.
          out.push({
            post,
            insights: {
              unreadable:
                error instanceof MetaRequestError
                  ? error.message
                  : "Meta gave no usable answer for this post",
            },
          });
        }
      }
      return out;
    },
  };
}

export function createMetaExecution(options: MetaExecutionOptions = {}): MetaExecution {
  const ctx: Context = {
    fetch: options.fetch ?? defaultFetch,
    sleep: options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
  };

  return {
    verifier: (provider) => async (secret) => {
      const cred = parseMetaExecutionCredential(secret, provider);
      const granted = await grantedPermissions(ctx, cred.access_token);
      // Refused by name before any asset is touched; connectForExecution checks again.
      verifyExecutionScopes(provider, granted);

      if (provider === "meta_publish") {
        await provePage(ctx, cred, cred.page_id as string);
        if (cred.ig_user_id !== null) {
          const ig = await metaRequest(
            ctx,
            { bearer: cred.access_token },
            "ig_user",
            { ig_user_id: cred.ig_user_id },
            { fields: "id,username" },
            `Instagram account ${cred.ig_user_id}. Link it to the Page and assign it to the system user`,
          );
          sameId(ig, cred.ig_user_id, "Instagram account");
        }
      } else {
        const account = cred.ad_account_id as string;
        const body = await metaRequest(
          ctx,
          { bearer: cred.access_token },
          "ad_account",
          { ad_account_id: account },
          { fields: "id,name,currency" },
          `ad account act_${account}. Assign the ad account to the system user with ads_management`,
        );
        sameId(body, account, "ad account");
      }
      return { granted_scopes: granted };
    },
    login: loginCalls(ctx),
    publish: publishProvider(ctx, async () => {
      if (options.backend) return options.backend;
      // The database side lives in lib/content; loaded on first use so the
      // provider map stays importable without a database.
      const { dbPublishBackend } = await import("../../content/publishing");
      return dbPublishBackend();
    }),
    ads: adsProvider(ctx, async () => {
      if (options.adsBackend) return options.adsBackend;
      // The database side lives in lib/ads, loaded on first use like the publish backend.
      const { dbAdsBackend } = await import("../../ads/executing");
      return dbAdsBackend();
    }),
    readback: readbackCalls(ctx),
    instagram: (a) =>
      publishInstagram(ctx, {
        igUserId: a.igUserId,
        token: a.token,
        media: a.media,
        caption: a.caption,
        hooks: {
          account_id: a.account_id,
          note: async () => undefined,
          ...(a.halted ? { halted: a.halted } : {}),
        },
      }),
  };
}

export const metaExecution = createMetaExecution();
export const metaPublishExecutor = metaExecution.publish;
export const metaAdsExecutor = metaExecution.ads;
export const metaReadback = metaExecution.readback;
