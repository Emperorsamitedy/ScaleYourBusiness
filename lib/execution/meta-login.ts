// Facebook Login for pilot route 1, testers — P3-20j (Session D, layer D1).
//
// The owner types the consent phrase on OUR screen first; only then does
// SYB send them to Meta's OAuth dialog, asking for exactly one consent's
// P3-20f scopes (write + readback, read from the registry, never typed by
// hand). Meta sends them back with a code; the server trades it for a
// short-lived user token, then a long-lived one, and lists what the token
// can reach: Pages (with their linked Instagram account) for publishing,
// ad accounts for ad management. The owner picks one, and the token and
// the picked ids go through the SAME door as a pasted token:
// consentToExecution → connectForExecution — /me/permissions matched
// exactly (one scope too many is refused by name), encrypted at rest, and
// a consent row in the decision log, undone if that row can't be written.
//
// What protects each step:
//   · state — signed (HMAC under a key derived from the server secret),
//     short-lived (10 minutes), bound to the account, the profile, the
//     provider, a nonce and the hash of the phrase typed. Its signature is
//     compared in constant time.
//   · single use — the nonce also sits in an httpOnly cookie scoped to
//     /api/connections/meta, cleared by the callback whatever happens, so
//     a replayed or foreign state finds no matching nonce.
//   · the token — never sent to the browser. Between the callback and the
//     pick it lives AES-256-GCM-encrypted (the connection-secret cipher,
//     CONNECTOR_KEY) in an httpOnly cookie that expires in 10 minutes, and
//     the encrypted payload carries its own expiry and account.
//   · the pick — the ids the owner chose are looked up again in Meta's own
//     list for that token; nothing the browser says about an asset is
//     trusted, and the Instagram id comes from Meta, not the client.
//   · Meta's side — only reads and the OAuth token exchange, through the
//     provider's capped, timed request helper; no write-scope call exists
//     anywhere in this flow (meta.test.ts's source scan holds it).
//
// No line here logs a token, a code or the app secret: one structured line
// per step with the account id, and logSafeError for anything unexpected.

import { createHash, createHmac, randomBytes } from "node:crypto";
import { derivedKey } from "../core/derived-key";
import { logSafeError } from "../core/log-safe";
import { secretMatches } from "../core/secret-compare";
import { decryptSecret, encryptSecret } from "../connectors/secrets";
import type { MetaLoginEnv } from "../env";
import { appUrl } from "../env";
import type { LimitLlm } from "../proposals/hard-limits";
import type { PublicExecutionConnection } from "./connections";
import {
  ExecutionConnectionError,
  activeExecutionConnection,
  expectedExecutionScopes,
  verifyExecutionScopes,
} from "./connections";
import { consentToExecution } from "./consent";
import type {
  MetaAdAccountCandidate,
  MetaAppCredentials,
  MetaExecution,
  MetaExecutionProviderId,
  MetaPageCandidate,
} from "./providers/meta";
import { META_EXEC_API_VERSION, MetaRequestError } from "./providers/meta";
import type { MetaFailure } from "./meta-errors";
import type { ConnectionsReason } from "./meta-login-reasons";
import { EXECUTION_SCOPE_REGISTRY } from "./scopes";
import { EXECUTION_SETUP, OFFERED_EXECUTION, confirmationMatches } from "./setup";

/** Meta's OAuth dialog, at the pinned Graph version. */
export const META_DIALOG_URL = `https://www.facebook.com/${META_EXEC_API_VERSION}/dialog/oauth`;
/** How long a started sign-in, and a signed-in-but-unpicked token, may wait. */
export const META_LOGIN_TTL_MS = 10 * 60 * 1000;
/** Clock skew tolerated on a state's issue time. */
const SKEW_MS = 60 * 1000;

export const META_LOGIN_COOKIE_PATH = "/api/connections/meta";
export const META_LOGIN_CALLBACK_PATH = "/api/connections/meta/callback";
/** The single-use nonce, set by start and cleared by the callback. */
export const META_LOGIN_NONCE_COOKIE = "syb_meta_login_nonce";
/** The encrypted long-lived token between the callback and the pick. */
export const META_LOGIN_PENDING_COOKIE = "syb_meta_login_pending";

export type MetaLoginFailure =
  | "unavailable"
  | "provider"
  | "phrase"
  | "already_connected"
  | "missing_state"
  | "tampered"
  | "expired"
  | "no_nonce"
  | "nonce_mismatch"
  | "foreign"
  | "no_pending"
  | "bad_pick";

/** A refusal in the flow, with the reason the tests and the routes read. */
export class MetaLoginError extends ExecutionConnectionError {
  readonly reason: MetaLoginFailure;
  constructor(reason: MetaLoginFailure, message: string, status: number) {
    super(message, status);
    this.name = "MetaLoginError";
    this.reason = reason;
  }
}

const START_AGAIN =
  "That Facebook sign-in expired or was already used. Start again from Connections.";

export function isMetaLoginProvider(value: unknown): value is MetaExecutionProviderId {
  return (
    (value === "meta_publish" || value === "meta_ads") &&
    OFFERED_EXECUTION.includes(value as MetaExecutionProviderId)
  );
}

function phraseFor(provider: MetaExecutionProviderId): string {
  const phrase = EXECUTION_SETUP[provider]?.confirm_phrase;
  if (phrase === undefined) throw new Error(`${provider} has no confirmation phrase`);
  return phrase;
}

/** The typed phrase, normalised as consent.ts records it, then hashed. */
export function phraseHash(typed: string): string {
  return createHash("sha256")
    .update(`syb-consent-phrase-v1:${typed.trim().toLowerCase()}`)
    .digest("hex");
}

/**
 * The scope parameter: EXACTLY the provider's write + readback scopes from
 * the registry. A list with one scope more or fewer is refused by name —
 * the same check connectForExecution makes on what Meta grants.
 */
export function loginScopes(
  provider: MetaExecutionProviderId,
  scopes: readonly string[] = expectedExecutionScopes(provider),
): string {
  verifyExecutionScopes(provider, scopes);
  return [...scopes].sort().join(",");
}

/* ── configuration ─────────────────────────────────────────────────── */

export interface MetaLoginConfig {
  app: MetaAppCredentials;
  redirect_uri: string;
  /** Where the owner comes back to: APP_URL, or the request's own origin. */
  app_origin: string;
}

/**
 * The flow's configuration, mirroring lib/auth's sign-in redirects:
 * APP_URL, else the request's origin. META_OAUTH_REDIRECT_URI wins for the
 * redirect when set — it must be byte-identical to the one registered in
 * Meta's app, so production pins it. Null when the app keys aren't set.
 */
export function metaLoginConfig(
  env: MetaLoginEnv | null,
  requestOrigin: string,
): MetaLoginConfig | null {
  if (env === null) return null;
  const app_origin = (env.app_url ?? requestOrigin).replace(/\/+$/, "");
  return {
    app: { app_id: env.app_id, app_secret: env.app_secret },
    redirect_uri: env.redirect_uri ?? `${app_origin}${META_LOGIN_CALLBACK_PATH}`,
    app_origin,
  };
}

/** The origin the flow's redirects and cookies use, configured or not: APP_URL, else the request's. */
export function flowOrigin(config: MetaLoginConfig | null, requestOrigin: string): string {
  return config?.app_origin ?? (appUrl() ?? requestOrigin).replace(/\/+$/, "");
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** Secure everywhere except a local development host, where there is no TLS. */
export function cookieSecure(origin: string): boolean {
  const host = new URL(origin).hostname;
  return !(LOCAL_HOSTS.has(host) || host.endsWith(".localhost"));
}

export function loginCookieOptions(origin: string, maxAgeSeconds = META_LOGIN_TTL_MS / 1000) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: cookieSecure(origin),
    path: META_LOGIN_COOKIE_PATH,
    maxAge: maxAgeSeconds,
  };
}

/* ── the signed state ──────────────────────────────────────────────── */

export interface MetaLoginState {
  v: 1;
  account_id: string;
  profile_id: string;
  provider: MetaExecutionProviderId;
  nonce: string;
  phrase_hash: string;
  /** Milliseconds since the epoch. */
  issued_at: number;
}

function stateMac(body: string): string {
  return createHmac("sha256", derivedKey("syb-meta-login-state-v1"))
    .update(`meta-login-state:${body}`)
    .digest("base64url");
}

/** `<base64url payload>.<base64url hmac>`. Opaque to Meta, which echoes it back. */
export function signLoginState(state: MetaLoginState): string {
  const body = Buffer.from(JSON.stringify(state)).toString("base64url");
  return `${body}.${stateMac(body)}`;
}

function parseState(raw: unknown): MetaLoginState | null {
  if (raw === null || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  const str = (k: string) => typeof s[k] === "string" && s[k] !== "";
  if (
    s["v"] !== 1 ||
    !str("account_id") ||
    !str("profile_id") ||
    !str("nonce") ||
    !str("phrase_hash") ||
    typeof s["issued_at"] !== "number" ||
    !isMetaLoginProvider(s["provider"])
  ) {
    return null;
  }
  return s as unknown as MetaLoginState;
}

/** The signature checked in constant time, then the shape. No claims are trusted yet. */
function readState(token: string | null | undefined): MetaLoginState {
  if (!token) throw new MetaLoginError("missing_state", START_AGAIN, 400);
  const dot = token.lastIndexOf(".");
  if (dot <= 0) throw new MetaLoginError("tampered", START_AGAIN, 400);
  const body = token.slice(0, dot);
  if (!secretMatches(token.slice(dot + 1), stateMac(body))) {
    throw new MetaLoginError("tampered", START_AGAIN, 400);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    throw new MetaLoginError("tampered", START_AGAIN, 400);
  }
  const state = parseState(parsed);
  if (state === null) throw new MetaLoginError("tampered", START_AGAIN, 400);
  return state;
}

/** The provider a state names, if its signature holds. For wording only — never for access. */
export function stateProvider(token: string | null | undefined): MetaExecutionProviderId | null {
  try {
    return readState(token).provider;
  } catch {
    return null;
  }
}

/**
 * Pure: the state as the callback must find it — signed by us, under ten
 * minutes old, its nonce equal to the cookie's (single use: the callback
 * clears that cookie), started by the account now signed in, and carrying
 * the hash of the phrase this provider asks for.
 */
export function verifyLoginState(
  token: string | null | undefined,
  args: { nonceCookie: string | null | undefined; accountId: string; now?: Date },
): MetaLoginState {
  const state = readState(token);
  const now = (args.now ?? new Date()).getTime();
  if (now - state.issued_at > META_LOGIN_TTL_MS || state.issued_at - now > SKEW_MS) {
    throw new MetaLoginError("expired", START_AGAIN, 400);
  }
  if (!args.nonceCookie) throw new MetaLoginError("no_nonce", START_AGAIN, 400);
  if (!secretMatches(args.nonceCookie, state.nonce)) {
    throw new MetaLoginError("nonce_mismatch", START_AGAIN, 400);
  }
  if (state.account_id !== args.accountId) {
    throw new MetaLoginError(
      "foreign",
      "That Facebook sign-in was started from a different SYB account. Sign in to SYB as that account, or start again.",
      403,
    );
  }
  if (state.phrase_hash !== phraseHash(phraseFor(state.provider))) {
    throw new MetaLoginError("phrase", "The confirmation phrase didn't match. Start again.", 422);
  }
  return state;
}

/** Meta's OAuth dialog for one consent: exactly its registry scopes, the signed state. */
export function buildAuthorizeUrl(args: {
  appId: string;
  redirectUri: string;
  provider: MetaExecutionProviderId;
  state: string;
}): string {
  const url = new URL(META_DIALOG_URL);
  url.searchParams.set("client_id", args.appId);
  url.searchParams.set("redirect_uri", args.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", loginScopes(args.provider));
  url.searchParams.set("state", args.state);
  return url.toString();
}

/* ── the pending token ─────────────────────────────────────────────── */

export interface PendingLogin {
  v: 1;
  account_id: string;
  profile_id: string;
  provider: MetaExecutionProviderId;
  access_token: string;
  phrase_hash: string;
  /** Milliseconds since the epoch. */
  expires_at: number;
}

/** Encrypted with the connection-secret cipher, then base64url so it is a plain cookie value. */
export function sealPending(pending: PendingLogin): string {
  return Buffer.from(encryptSecret(JSON.stringify(pending))).toString("base64url");
}

const NO_PENDING =
  "There's no Facebook sign-in waiting, or it expired. Sign in with Facebook again.";

/** The pending token, only for this account and provider, and only within its ten minutes. */
export function openPending(
  raw: string | null | undefined,
  args: { accountId: string; provider: MetaExecutionProviderId; now?: Date },
): PendingLogin {
  if (!raw) throw new MetaLoginError("no_pending", NO_PENDING, 409);
  let p: Record<string, unknown>;
  try {
    p = JSON.parse(decryptSecret(Buffer.from(raw, "base64url").toString("utf8"))) as Record<
      string,
      unknown
    >;
  } catch {
    throw new MetaLoginError("no_pending", NO_PENDING, 409);
  }
  if (
    p["v"] !== 1 ||
    typeof p["access_token"] !== "string" ||
    typeof p["expires_at"] !== "number" ||
    typeof p["phrase_hash"] !== "string" ||
    typeof p["profile_id"] !== "string"
  ) {
    throw new MetaLoginError("no_pending", NO_PENDING, 409);
  }
  if ((args.now ?? new Date()).getTime() > p["expires_at"]) {
    throw new MetaLoginError("no_pending", NO_PENDING, 409);
  }
  if (p["account_id"] !== args.accountId) {
    throw new MetaLoginError("foreign", NO_PENDING, 403);
  }
  if (p["provider"] !== args.provider) {
    throw new MetaLoginError("no_pending", NO_PENDING, 409);
  }
  return p as unknown as PendingLogin;
}

/* ── where the owner lands ─────────────────────────────────────────── */

export type CallbackOutcome =
  | { kind: "pick"; provider: MetaExecutionProviderId; pending: string; count: number }
  | { kind: "cancelled"; provider: MetaExecutionProviderId | null }
  | {
      kind: "failed";
      provider: MetaExecutionProviderId | null;
      /** What the URL carries (review D #9): a code from a closed set, never text. */
      reason: ConnectionsReason;
      /** The server's own sentence, for the log line and tests — never put in a URL. */
      message: string;
    };

/**
 * /connections with the flow's outcome in the query: what the Execution
 * section reads. A failure carries its reason CODE only (review 2026-10-23,
 * Session D #9); the screen maps it to a fixed sentence (connectionsMessage),
 * so no text from a URL is ever shown as SYB's.
 */
export function connectionsReturnUrl(
  origin: string,
  outcome:
    | { kind: "pick" | "cancelled"; provider: MetaExecutionProviderId | null }
    | { kind: "failed"; provider: MetaExecutionProviderId | null; reason: ConnectionsReason },
): string {
  const url = new URL("/connections", origin);
  url.searchParams.set("meta", outcome.kind === "failed" ? "error" : outcome.kind);
  if (outcome.provider !== null) url.searchParams.set("provider", outcome.provider);
  if (outcome.kind === "failed") url.searchParams.set("reason", outcome.reason);
  return url.toString();
}

/** A flow refusal's reason code, for the way back to /connections (review D #9). */
export function reasonForLoginFailure(reason: MetaLoginFailure): ConnectionsReason {
  switch (reason) {
    case "unavailable":
    case "provider":
    case "phrase":
    case "already_connected":
    case "foreign":
      return reason;
    default:
      return "start_again";
  }
}

/** A Meta refusal's reason code, by the P3-24a taxonomy (review D #9). */
export function reasonForMetaFailure(failure: MetaFailure | null): ConnectionsReason {
  switch (failure?.kind) {
    case "auth":
      return "meta_auth";
    case "permission":
      return "meta_permission";
    case "rate_limit":
    case "page_limit":
    case "unavailable":
      return "meta_busy";
    default:
      return "meta_refused";
  }
}

function log(event: string, accountId: string | null, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event, account_id: accountId, ...fields }));
}

/* ── the steps ─────────────────────────────────────────────────────── */

/**
 * Step 1, before any redirect: the provider is offered, Facebook Login is
 * configured, the phrase is the one this consent asks for, and nothing is
 * already connected (a paused connection may be reconnected — P3-24b).
 * Only then a nonce and a signed state.
 */
export async function startMetaLogin(args: {
  accountId: string;
  profileId: string;
  provider: unknown;
  confirmation: unknown;
  config: MetaLoginConfig | null;
  now?: Date;
}): Promise<{ authorize_url: string; nonce: string; provider: MetaExecutionProviderId }> {
  if (!isMetaLoginProvider(args.provider)) {
    throw new MetaLoginError("provider", "That isn't a Meta connection SYB offers.", 422);
  }
  const provider = args.provider;
  if (args.config === null) {
    throw new MetaLoginError(
      "unavailable",
      "Facebook sign-in isn't available yet. Use your own Meta app instead.",
      503,
    );
  }
  const typed = typeof args.confirmation === "string" ? args.confirmation : "";
  if (!confirmationMatches(provider, typed)) {
    log("meta_login_start", args.accountId, { provider, outcome: "phrase_mismatch" });
    throw new MetaLoginError(
      "phrase",
      `Type "${phraseFor(provider)}" to confirm. Nothing was sent to Meta.`,
      422,
    );
  }
  // P3-24b: a paused connection is reconnected through this same sign-in.
  const live = await activeExecutionConnection(args.accountId, provider);
  if (live && live.status !== "paused") {
    throw new MetaLoginError(
      "already_connected",
      `${EXECUTION_SCOPE_REGISTRY[provider].label} is already connected. Disconnect it first.`,
      409,
    );
  }
  const nonce = randomBytes(24).toString("base64url");
  const state = signLoginState({
    v: 1,
    account_id: args.accountId,
    profile_id: args.profileId,
    provider,
    nonce,
    phrase_hash: phraseHash(typed),
    issued_at: (args.now ?? new Date()).getTime(),
  });
  log("meta_login_start", args.accountId, { provider, outcome: "redirected" });
  return {
    authorize_url: buildAuthorizeUrl({
      appId: args.config.app.app_id,
      redirectUri: args.config.redirect_uri,
      provider,
      state,
    }),
    nonce,
    provider,
  };
}

async function candidatesFor(
  exec: MetaExecution,
  provider: MetaExecutionProviderId,
  token: string,
): Promise<MetaPageCandidate[] | MetaAdAccountCandidate[]> {
  return provider === "meta_publish" ? exec.login.pages(token) : exec.login.adAccounts(token);
}

function nothingToPick(provider: MetaExecutionProviderId): string {
  return provider === "meta_publish"
    ? "Meta showed SYB no Pages for that Facebook account. In Meta's dialog, choose the Page (and its Instagram account) you want SYB to publish to, then try again."
    : "Meta showed SYB no ad accounts for that Facebook account. In Meta's dialog, choose the ad account you want SYB to manage, then try again.";
}

/**
 * Step 2, Meta's redirect back. A cancel is a plain message; anything else
 * must carry a state that verifies against the nonce cookie and the
 * signed-in account. The code is exchanged server-side, the token made
 * long-lived, and the candidates listed; the token leaves this function
 * only encrypted.
 */
export async function completeMetaCallback(args: {
  accountId: string | null;
  query: {
    code: string | null;
    state: string | null;
    error: string | null;
    error_reason: string | null;
  };
  nonceCookie: string | null | undefined;
  config: MetaLoginConfig | null;
  exec: MetaExecution;
  now?: Date;
}): Promise<CallbackOutcome> {
  const { query } = args;
  const hinted = stateProvider(query.state);
  const done = (outcome: CallbackOutcome, extra: Record<string, unknown> = {}) => {
    log("meta_login_callback", args.accountId, {
      provider: outcome.provider,
      outcome: outcome.kind,
      ...extra,
    });
    return outcome;
  };

  if (query.error !== null || query.error_reason !== null) {
    if (query.error === "access_denied" || query.error_reason === "user_denied") {
      return done({ kind: "cancelled", provider: hinted });
    }
    return done(
      {
        kind: "failed",
        provider: hinted,
        reason: "meta_error",
        message: "Facebook sign-in didn't finish. Nothing was connected.",
      },
      { reason: "meta_error" },
    );
  }
  if (args.config === null) {
    return done(
      {
        kind: "failed",
        provider: hinted,
        reason: "unavailable",
        message: "Facebook sign-in isn't available yet. Nothing was connected.",
      },
      { reason: "unavailable" },
    );
  }
  if (args.accountId === null) {
    return done(
      {
        kind: "failed",
        provider: hinted,
        reason: "signed_out",
        message: "Sign in to SYB first, then connect Meta again.",
      },
      { reason: "signed_out" },
    );
  }

  try {
    const state = verifyLoginState(query.state, {
      nonceCookie: args.nonceCookie,
      accountId: args.accountId,
      ...(args.now ? { now: args.now } : {}),
    });
    if (!query.code) {
      return done(
        { kind: "failed", provider: state.provider, reason: "start_again", message: START_AGAIN },
        { reason: "no_code" },
      );
    }
    const shortLived = await args.exec.login.exchangeCode(
      args.config.app,
      query.code,
      args.config.redirect_uri,
    );
    const longLived = await args.exec.login.longLived(args.config.app, shortLived);
    log("meta_login_token_exchanged", args.accountId, { provider: state.provider });

    const found = await candidatesFor(args.exec, state.provider, longLived);
    if (found.length === 0) {
      return done(
        {
          kind: "failed",
          provider: state.provider,
          reason: state.provider === "meta_publish" ? "no_pages" : "no_ad_accounts",
          message: nothingToPick(state.provider),
        },
        { reason: "no_candidates" },
      );
    }
    const pending = sealPending({
      v: 1,
      account_id: state.account_id,
      profile_id: state.profile_id,
      provider: state.provider,
      access_token: longLived,
      phrase_hash: state.phrase_hash,
      expires_at: (args.now ?? new Date()).getTime() + META_LOGIN_TTL_MS,
    });
    return done(
      { kind: "pick", provider: state.provider, pending, count: found.length },
      { count: found.length },
    );
  } catch (error) {
    if (error instanceof MetaLoginError) {
      return done(
        {
          kind: "failed",
          provider: hinted,
          reason: reasonForLoginFailure(error.reason),
          message: error.message,
        },
        { reason: error.reason },
      );
    }
    if (error instanceof ExecutionConnectionError) {
      // A Meta refusal, already in the owner's words by the P3-24a taxonomy.
      return done(
        {
          kind: "failed",
          provider: hinted,
          reason: reasonForMetaFailure(error instanceof MetaRequestError ? error.failure : null),
          message: `Facebook sign-in didn't finish. ${error.message}`,
        },
        { reason: "meta_refused", ...logSafeError(error) },
      );
    }
    console.error(
      JSON.stringify({
        event: "meta_login_callback_failed",
        account_id: args.accountId,
        ...logSafeError(error),
      }),
    );
    return {
      kind: "failed",
      provider: hinted,
      reason: "internal",
      message: "Something went wrong on our side. Nothing was connected.",
    };
  }
}

export type CandidateList =
  | { provider: "meta_publish"; kind: "pages"; candidates: MetaPageCandidate[] }
  | { provider: "meta_ads"; kind: "ad_accounts"; candidates: MetaAdAccountCandidate[] };

/** Step 3, the picker's list: re-read from Meta with the pending token, which never leaves. */
export async function listMetaCandidates(args: {
  accountId: string;
  provider: unknown;
  pendingCookie: string | null | undefined;
  exec: MetaExecution;
  now?: Date;
}): Promise<CandidateList> {
  if (!isMetaLoginProvider(args.provider)) {
    throw new MetaLoginError("provider", "That isn't a Meta connection SYB offers.", 422);
  }
  const provider = args.provider;
  const pending = openPending(args.pendingCookie, {
    accountId: args.accountId,
    provider,
    ...(args.now ? { now: args.now } : {}),
  });
  const list: CandidateList =
    provider === "meta_publish"
      ? { provider, kind: "pages", candidates: await args.exec.login.pages(pending.access_token) }
      : {
          provider,
          kind: "ad_accounts",
          candidates: await args.exec.login.adAccounts(pending.access_token),
        };
  log("meta_login_candidates", args.accountId, { provider, count: list.candidates.length });
  return list;
}

/**
 * Step 4, the pick. The pending token is opened for this account and
 * provider, the phrase hash checked against the one the state carried,
 * the picked id found again in Meta's own list, and the result handed to
 * consentToExecution: the same exact-scope check, encryption at rest and
 * consent row as a pasted token.
 */
export async function finishMetaLogin(args: {
  accountId: string;
  profileId: string;
  provider: unknown;
  assetId: unknown;
  pendingCookie: string | null | undefined;
  exec: MetaExecution;
  limitLlm?: LimitLlm;
  now?: Date;
}): Promise<PublicExecutionConnection> {
  if (!isMetaLoginProvider(args.provider)) {
    throw new MetaLoginError("provider", "That isn't a Meta connection SYB offers.", 422);
  }
  const provider = args.provider;
  const pending = openPending(args.pendingCookie, {
    accountId: args.accountId,
    provider,
    ...(args.now ? { now: args.now } : {}),
  });
  if (pending.profile_id !== args.profileId) {
    throw new MetaLoginError("foreign", NO_PENDING, 403);
  }
  const phrase = phraseFor(provider);
  if (pending.phrase_hash !== phraseHash(phrase)) {
    throw new MetaLoginError("phrase", "The confirmation phrase didn't match. Start again.", 422);
  }

  const assetId = typeof args.assetId === "string" ? args.assetId.trim() : "";
  let secret: string;
  if (provider === "meta_publish") {
    const page = (await args.exec.login.pages(pending.access_token)).find((p) => p.id === assetId);
    if (!page) {
      throw new MetaLoginError("bad_pick", "Pick one of the Pages listed.", 422);
    }
    secret = JSON.stringify({
      access_token: pending.access_token,
      page_id: page.id,
      ig_user_id: page.instagram?.id ?? null,
    });
  } else {
    const account = (await args.exec.login.adAccounts(pending.access_token)).find(
      (a) => a.id === assetId,
    );
    if (!account) {
      throw new MetaLoginError("bad_pick", "Pick one of the ad accounts listed.", 422);
    }
    secret = JSON.stringify({ access_token: pending.access_token, ad_account_id: account.id });
  }

  try {
    const { connection } = await consentToExecution({
      accountId: args.accountId,
      provider,
      secret,
      confirmation: phrase,
      verify: args.exec.verifier(provider),
      ...(args.limitLlm ? { limitLlm: args.limitLlm } : {}),
      ...(args.now ? { now: args.now } : {}),
    });
    log("meta_login_finish", args.accountId, {
      provider,
      outcome: "connected",
      connection_id: connection.id,
    });
    return connection;
  } catch (error) {
    log("meta_login_finish", args.accountId, {
      provider,
      outcome: "refused",
      ...logSafeError(error),
    });
    throw error;
  }
}
