// The TikTok Marketing API fence — TikTok Ads (specs/tiktok-ads-api-v1.md).
//
// Every request SYB can make to TikTok is a line in TIKTOK_REQUESTS: a verb,
// a path at the pinned v1.3, and — for the two campaign writes — the only
// body fields it may carry. tiktokCall refuses anything else BEFORE a byte
// is sent: an unregistered request, a body field outside its list, or the
// one status SYB never sends (DELETE: TikTok says "the status of deleted
// campaigns cannot be modified", so it is permanent). api.test.ts pins the
// table, and its source scan fails the build if any module in lib/tiktok
// or the executor names a TikTok path outside it.
//
// Reads and writes are split by type, not by convention: tiktokRead takes
// only the three GET requests the daily read needs, and is all
// lib/tiktok/read.ts may call (read.test.ts holds that). The writes go
// through tiktokCall from the executor alone, which the engine reaches only
// on an approved proposal with SESSION_D_REAL_WRITES=on (rules 12, 13).
//
// Rule 18: no registered path or body field names billing, payment,
// funding, invoices or anything like them (api.test.ts runs the money
// audit over the table). `po_number`, a field /campaign/update/ accepts,
// is not in the list: SYB never sends it.
//
// The token travels in the `Access-Token` header (TikTok's own SDK sets it
// so), never in a URL. Retries are capped at 3 attempts in all; the token
// exchange is never retried, because an auth code works once. No line logs
// a token, an auth code or the app secret.

export const TIKTOK_API_ORIGIN = "https://business-api.tiktok.com";
export const TIKTOK_API_VERSION = "v1.3";
export const TIKTOK_MAX_ATTEMPTS = 3;
export const TIKTOK_TIMEOUT_MS = 20_000;

interface RequestSpec {
  method: "GET" | "POST";
  path: string;
  /** "token": sent with the Access-Token header; "app": the OAuth exchange, with the app's secret. */
  auth: "token" | "app";
  /** POST only: the body fields it may carry. Anything else is refused before sending. */
  body_fields?: readonly string[];
}

export const TIKTOK_REQUESTS = {
  /** The OAuth exchange (auth_code → long-term token). */
  access_token: {
    method: "POST",
    path: "/open_api/v1.3/oauth2/access_token/",
    auth: "app",
    body_fields: ["app_id", "secret", "auth_code"],
  },
  /** Read: the ad account's currency, time zone and name. */
  advertiser_info: { method: "GET", path: "/open_api/v1.3/advertiser/info/", auth: "token" },
  /** Read: the per-campaign, per-day report. */
  report: { method: "GET", path: "/open_api/v1.3/report/integrated/get/", auth: "token" },
  /** Read: one campaign's status and budget, before any change and before any undo. */
  campaign_get: { method: "GET", path: "/open_api/v1.3/campaign/get/", auth: "token" },
  /** Write: a campaign's daily budget. */
  campaign_update: {
    method: "POST",
    path: "/open_api/v1.3/campaign/update/",
    auth: "token",
    body_fields: ["advertiser_id", "campaign_id", "budget"],
  },
  /** Write: pause (DISABLE) or resume (ENABLE). DELETE is refused by tiktokCall. */
  campaign_status_update: {
    method: "POST",
    path: "/open_api/v1.3/campaign/status/update/",
    auth: "token",
    body_fields: ["advertiser_id", "campaign_ids", "operation_status"],
  },
} as const satisfies Record<string, RequestSpec>;

export type TikTokRequest = keyof typeof TIKTOK_REQUESTS;

/** What the daily read may call — GET only. */
export const TIKTOK_READ_REQUESTS = ["advertiser_info", "report", "campaign_get"] as const;
export type TikTokReadRequest = (typeof TIKTOK_READ_REQUESTS)[number];

/** The only statuses SYB sends: pause and resume. */
export const TIKTOK_STATUSES = ["ENABLE", "DISABLE"] as const;

export interface TikTokRequestInit {
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
}

export interface TikTokResponse {
  status: number;
  json(): Promise<unknown>;
}

export type TikTokFetch = (url: string, init: TikTokRequestInit) => Promise<TikTokResponse>;

export interface TikTokContext {
  fetch: TikTokFetch;
  sleep: (ms: number) => Promise<void>;
}

export type TikTokFailureKind =
  | "auth"
  | "permission"
  | "rate_limit"
  | "unavailable"
  | "invalid"
  | "not_found"
  | "network"
  | "unknown";

/** TikTok's return codes, from its "Return codes" page (read 2026-11-08). */
export const TIKTOK_RATE_LIMIT_CODES: ReadonlySet<number> = new Set([40016, 40100, 40133]);
export const TIKTOK_UNAVAILABLE_CODES: ReadonlySet<number> = new Set([50000, 50002]);
export const TIKTOK_AUTH_CODES: ReadonlySet<number> = new Set([40101, 40102, 40104, 40105, 40106]);
export const TIKTOK_PERMISSION_CODES: ReadonlySet<number> = new Set([40001]);
export const TIKTOK_INVALID_CODES: ReadonlySet<number> = new Set([40000, 40002]);
export const TIKTOK_NOT_FOUND_CODES: ReadonlySet<number> = new Set([40007]);

/** A TikTok refusal, classified. `tiktok_message` is TikTok's own words, for the owner to read. */
export class TikTokRequestError extends Error {
  readonly kind: TikTokFailureKind;
  readonly code: number | null;
  readonly tiktok_message: string | null;
  readonly retryable: boolean;
  constructor(
    kind: TikTokFailureKind,
    code: number | null,
    tiktokMessage: string | null,
    message: string,
  ) {
    super(message);
    this.name = "TikTokRequestError";
    this.kind = kind;
    this.code = code;
    this.tiktok_message = tiktokMessage;
    this.retryable = kind === "rate_limit" || kind === "unavailable" || kind === "network";
  }
}

/** Refused before sending: the request isn't one SYB makes. A bug, never a TikTok answer. */
export class TikTokFenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TikTokFenceError";
  }
}

export function classifyTikTokCode(code: number | null, status: number): TikTokFailureKind {
  if (code !== null) {
    if (TIKTOK_RATE_LIMIT_CODES.has(code)) return "rate_limit";
    if (TIKTOK_UNAVAILABLE_CODES.has(code)) return "unavailable";
    if (TIKTOK_AUTH_CODES.has(code)) return "auth";
    if (TIKTOK_PERMISSION_CODES.has(code)) return "permission";
    if (TIKTOK_INVALID_CODES.has(code)) return "invalid";
    if (TIKTOK_NOT_FOUND_CODES.has(code)) return "not_found";
  }
  if (status === 429) return "rate_limit";
  if (status >= 500) return "unavailable";
  if (status === 401) return "auth";
  if (status === 403) return "permission";
  return "unknown";
}

/** The owner's sentence for a failure kind. */
export function tiktokFailureSentence(
  kind: TikTokFailureKind,
  tiktokMessage: string | null,
): string {
  switch (kind) {
    case "auth":
      return "TikTok didn't accept ScaleX's access. It may have been revoked: reconnect TikTok on Connections.";
    case "permission":
      return "TikTok says ScaleX's access can't do that on this ad account. Reconnect TikTok and allow the listed permissions.";
    case "rate_limit":
      return "TikTok kept asking ScaleX to slow down. Nothing was changed. I'll try again.";
    case "unavailable":
    case "network":
      return "TikTok didn't answer. Nothing was changed. I'll try again.";
    case "not_found":
      return "TikTok has no such campaign on the connected ad account.";
    case "invalid":
    case "unknown":
      return tiktokMessage
        ? `TikTok refused the request: ${tiktokMessage}`
        : "TikTok refused the request.";
  }
}

function backoffMs(attempt: number): number {
  return 1000 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
}

function queryString(query: Readonly<Record<string, unknown>>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    // TikTok takes arrays and objects as JSON strings in the query (its docs' own examples).
    params.set(k, typeof v === "string" ? v : JSON.stringify(v));
  }
  const s = params.toString();
  return s ? `?${s}` : "";
}

/** Pure: why this body may not go to TikTok, or null when it may. */
export function tiktokBodyViolation(
  which: TikTokRequest,
  body: Readonly<Record<string, unknown>>,
): string | null {
  const spec: RequestSpec = TIKTOK_REQUESTS[which];
  if (spec.method !== "POST") return `${which} is a GET and carries no body`;
  const allowed = spec.body_fields ?? [];
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) return `"${key}" is not a field ScaleX sends on ${which}`;
  }
  if (which === "campaign_status_update") {
    const status = body["operation_status"];
    if (!(TIKTOK_STATUSES as readonly unknown[]).includes(status)) {
      return `"${String(status)}" is not a status ScaleX sends (only ENABLE and DISABLE)`;
    }
    const ids = body["campaign_ids"];
    if (!Array.isArray(ids) || ids.length !== 1) {
      return "ScaleX changes one campaign at a time";
    }
  }
  return null;
}

export interface TikTokCallArgs {
  /** The Access-Token. Required for every request but the OAuth exchange. */
  token?: string;
  query?: Readonly<Record<string, unknown>>;
  body?: Readonly<Record<string, unknown>>;
  /** Log context: the SYB account (never a token). */
  account_id?: string | null;
}

/**
 * One call to TikTok through the fence. Returns the response's `data`
 * object when TikTok answers code 0; throws TikTokRequestError otherwise,
 * after at most TIKTOK_MAX_ATTEMPTS attempts for a retryable failure (the
 * OAuth exchange: one attempt only).
 */
export async function tiktokCall(
  ctx: TikTokContext,
  which: TikTokRequest,
  args: TikTokCallArgs = {},
): Promise<Record<string, unknown>> {
  if (!Object.prototype.hasOwnProperty.call(TIKTOK_REQUESTS, which)) {
    throw new TikTokFenceError(`"${String(which)}" is not a TikTok request ScaleX makes`);
  }
  const spec: RequestSpec = TIKTOK_REQUESTS[which];
  if (spec.method === "POST") {
    const violation = tiktokBodyViolation(which, args.body ?? {});
    if (violation !== null) throw new TikTokFenceError(violation);
  } else if (args.body !== undefined) {
    throw new TikTokFenceError(`${which} is a GET and carries no body`);
  }
  if (spec.auth === "token" && (!args.token || /\s/.test(args.token))) {
    throw new TikTokFenceError(`${which} needs the connection's access token`);
  }
  if (spec.auth === "app" && args.token !== undefined) {
    throw new TikTokFenceError("the OAuth exchange is sent without an access token");
  }

  const url = `${TIKTOK_API_ORIGIN}${spec.path}${spec.method === "GET" ? queryString(args.query ?? {}) : ""}`;
  const headers: Record<string, string> = { accept: "application/json" };
  if (spec.auth === "token") headers["Access-Token"] = args.token as string;
  if (spec.method === "POST") headers["content-type"] = "application/json";
  const init: TikTokRequestInit = {
    method: spec.method,
    headers,
    ...(spec.method === "POST" ? { body: JSON.stringify(args.body ?? {}) } : {}),
  };
  const maxAttempts = spec.auth === "app" ? 1 : TIKTOK_MAX_ATTEMPTS;

  for (let attempt = 1; ; attempt += 1) {
    let failure: TikTokRequestError;
    try {
      const response = await ctx.fetch(url, init);
      const body = (await response.json().catch(() => null)) as {
        code?: unknown;
        message?: unknown;
        data?: unknown;
      } | null;
      const code = typeof body?.code === "number" ? body.code : null;
      if (response.status === 200 && code === 0) {
        const data = body?.data;
        return data !== null && typeof data === "object" && !Array.isArray(data)
          ? (data as Record<string, unknown>)
          : {};
      }
      const tiktokMessage =
        typeof body?.message === "string" && body.message.trim() !== ""
          ? body.message.trim().slice(0, 300)
          : null;
      const kind = classifyTikTokCode(code, response.status);
      failure = new TikTokRequestError(
        kind,
        code,
        tiktokMessage,
        tiktokFailureSentence(kind, tiktokMessage),
      );
    } catch (error) {
      if (error instanceof TikTokFenceError) throw error;
      failure = new TikTokRequestError(
        "network",
        null,
        null,
        tiktokFailureSentence("network", null),
      );
    }
    console.log(
      JSON.stringify({
        event: "tiktok_call_failed",
        account_id: args.account_id ?? null,
        request: which,
        attempt,
        kind: failure.kind,
        code: failure.code,
      }),
    );
    if (!failure.retryable || attempt >= maxAttempts) throw failure;
    await ctx.sleep(backoffMs(attempt));
  }
}

/** The daily read's door: GET requests only, by type. */
export function tiktokRead(
  ctx: TikTokContext,
  which: TikTokReadRequest,
  args: Omit<TikTokCallArgs, "body"> & { token: string },
): Promise<Record<string, unknown>> {
  if (!(TIKTOK_READ_REQUESTS as readonly string[]).includes(which)) {
    return Promise.reject(new TikTokFenceError(`"${which}" is not a read`));
  }
  return tiktokCall(ctx, which, args);
}

/** The real network, with a timeout. Tests inject a fake instead. */
export const defaultTikTokFetch: TikTokFetch = async (url, init) => {
  const response = await fetch(url, {
    method: init.method,
    headers: init.headers,
    ...(init.body !== undefined ? { body: init.body } : {}),
    cache: "no-store",
    signal: AbortSignal.timeout(TIKTOK_TIMEOUT_MS),
  });
  return { status: response.status, json: () => response.json() as Promise<unknown> };
};

export function defaultTikTokContext(overrides: Partial<TikTokContext> = {}): TikTokContext {
  return {
    fetch: overrides.fetch ?? defaultTikTokFetch,
    sleep: overrides.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
  };
}

/* ── the credential at rest ── */

/** What the encrypted secret of a tiktok_ads connection holds. */
export interface TikTokCredential {
  v: 1;
  access_token: string;
  /** The ad accounts the token reaches, as TikTok listed them at the exchange. */
  advertiser_ids: string[];
  /** TikTok's own scope ids, as the exchange reported them. */
  scope_ids: number[];
}

export function parseTikTokCredential(secret: string): TikTokCredential {
  let raw: unknown;
  try {
    raw = JSON.parse(secret);
  } catch {
    throw new TikTokFenceError("the stored TikTok access couldn't be read");
  }
  const c = (raw ?? {}) as Record<string, unknown>;
  const token = typeof c["access_token"] === "string" ? c["access_token"].trim() : "";
  const ids = Array.isArray(c["advertiser_ids"]) ? c["advertiser_ids"] : [];
  const scopes = Array.isArray(c["scope_ids"]) ? c["scope_ids"] : [];
  if (
    c["v"] !== 1 ||
    token === "" ||
    /\s/.test(token) ||
    ids.length === 0 ||
    !ids.every((id) => typeof id === "string" && /^\d{5,25}$/.test(id)) ||
    !scopes.every((s) => typeof s === "number" && Number.isInteger(s) && s >= 0)
  ) {
    throw new TikTokFenceError("the stored TikTok access couldn't be read");
  }
  return {
    v: 1,
    access_token: token,
    advertiser_ids: [...new Set(ids as string[])].sort(),
    scope_ids: scopes as number[],
  };
}
