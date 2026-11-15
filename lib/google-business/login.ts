// Connecting Google Business Profile — I-45a, mirroring Meta's sign-in (P3-20j).
//
// The owner types the consent phrase on OUR screen first; only then does SYB
// send them to Google's consent screen, asking for exactly the registry's one
// scope (business.manage), with access_type=offline and prompt=consent so
// Google returns a refresh token the daily read can use. Google sends them
// back with a code; the server trades it for tokens and lists the Business
// Profile locations the grant reaches. One location connects at once; with
// several, the owner picks, and the pick goes through consentToGoogleReviews.
//
// What protects each step (Meta's flow, plus PKCE):
//   · state — signed (HMAC under a key derived from the server secret),
//     ten minutes, bound to the account, the business, a nonce and the hash
//     of the phrase typed. Compared in constant time.
//   · single use — the nonce also sits in an httpOnly cookie scoped to
//     /api/connections/google-business, cleared by the callback whatever
//     happens.
//   · PKCE (S256) — the code verifier is derived from that nonce under its
//     own key, so it never leaves the server and needs no store; a code
//     carried off without the cookie can't be exchanged.
//   · the refresh token — never sent to the browser. Between the callback
//     and the pick it lives AES-256-GCM-encrypted in an httpOnly ten-minute
//     cookie that carries its own expiry, account and business.
//   · the pick — looked up again in Google's own list for that grant;
//     nothing the browser says about a location is trusted.
//   · Google's side — only the token endpoint and GET reads, through
//     ./client.ts's fence.
//
// No line logs a token, a code or the client secret.

import { createHash, createHmac, randomBytes } from "node:crypto";
import { derivedKey } from "../core/derived-key";
import { logSafeError } from "../core/log-safe";
import { secretMatches } from "../core/secret-compare";
import { decryptSecret, encryptSecret } from "../connectors/secrets";
import type { GoogleBusinessEnv } from "../env";
import { appUrl } from "../env";
import type { PublicExecutionConnection } from "../execution/connections";
import {
  ExecutionConnectionError,
  activeExecutionConnection,
  expectedExecutionScopes,
  verifyExecutionScopes,
} from "../execution/connections";
import { phraseHash } from "../execution/meta-login";
import type { FetchLike, GbpLocation } from "./client";
import {
  GOOGLE_AUTHORIZE_URL,
  GbpRequestError,
  exchangeCode,
  listLocations,
  refreshAccess,
} from "./client";
import {
  GOOGLE_PROVIDER,
  GOOGLE_REVIEWS_PHRASE,
  consentToGoogleReviews,
  googlePhraseMatches,
} from "./consent";
import type { GoogleReason } from "./reasons";

export const GOOGLE_LOGIN_TTL_MS = 10 * 60 * 1000;
const SKEW_MS = 60 * 1000;

export const GOOGLE_COOKIE_PATH = "/api/connections/google-business";
export const GOOGLE_CALLBACK_PATH = "/api/connections/google-business/callback";
export const GOOGLE_NONCE_COOKIE = "syb_google_business_nonce";
export const GOOGLE_PENDING_COOKIE = "syb_google_business_pending";

export class GoogleLoginError extends ExecutionConnectionError {
  readonly reason: GoogleReason;
  constructor(reason: GoogleReason, message: string, status: number) {
    super(message, status);
    this.name = "GoogleLoginError";
    this.reason = reason;
  }
}

const START_AGAIN =
  "That Google sign-in expired or was already used. Start again from Connections.";

/* ── configuration ─────────────────────────────────────────────────── */

export interface GoogleLoginConfig {
  client: Pick<GoogleBusinessEnv, "client_id" | "client_secret">;
  redirect_uri: string;
  app_origin: string;
}

/** Null while the Google client or the API approval isn't configured (lib/env googleBusinessEnv). */
export function googleLoginConfig(
  env: GoogleBusinessEnv | null,
  requestOrigin: string,
): GoogleLoginConfig | null {
  if (env === null) return null;
  const app_origin = (env.app_url ?? requestOrigin).replace(/\/+$/, "");
  return {
    client: { client_id: env.client_id, client_secret: env.client_secret },
    redirect_uri: env.redirect_uri ?? `${app_origin}${GOOGLE_CALLBACK_PATH}`,
    app_origin,
  };
}

export function googleFlowOrigin(config: GoogleLoginConfig | null, requestOrigin: string): string {
  return config?.app_origin ?? (appUrl() ?? requestOrigin).replace(/\/+$/, "");
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function googleCookieOptions(origin: string, maxAgeSeconds = GOOGLE_LOGIN_TTL_MS / 1000) {
  const host = new URL(origin).hostname;
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: !(LOCAL_HOSTS.has(host) || host.endsWith(".localhost")),
    path: GOOGLE_COOKIE_PATH,
    maxAge: maxAgeSeconds,
  };
}

/** /connections with the flow's outcome as a closed code: what the Google section reads. */
export function googleReturnUrl(
  origin: string,
  outcome: { kind: "connected" | "pick" | "cancelled" } | { kind: "failed"; reason: GoogleReason },
): string {
  const url = new URL("/connections", origin);
  url.searchParams.set("google", outcome.kind === "failed" ? "error" : outcome.kind);
  if (outcome.kind === "failed") url.searchParams.set("reason", outcome.reason);
  return url.toString();
}

/* ── state and PKCE ────────────────────────────────────────────────── */

export interface GoogleLoginState {
  v: 1;
  account_id: string;
  profile_id: string;
  nonce: string;
  phrase_hash: string;
  issued_at: number;
}

function stateMac(body: string): string {
  return createHmac("sha256", derivedKey("syb-google-business-state-v1"))
    .update(`google-business-state:${body}`)
    .digest("base64url");
}

export function signGoogleState(state: GoogleLoginState): string {
  const body = Buffer.from(JSON.stringify(state)).toString("base64url");
  return `${body}.${stateMac(body)}`;
}

/** The PKCE verifier for a nonce: 43 base64url characters, never sent until the exchange. */
export function codeVerifierFor(nonce: string): string {
  return createHmac("sha256", derivedKey("syb-google-business-pkce-v1"))
    .update(nonce)
    .digest("base64url");
}

export function codeChallengeFor(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function readState(token: string | null | undefined): GoogleLoginState {
  if (!token) throw new GoogleLoginError("start_again", START_AGAIN, 400);
  const dot = token.lastIndexOf(".");
  if (dot <= 0) throw new GoogleLoginError("start_again", START_AGAIN, 400);
  const body = token.slice(0, dot);
  if (!secretMatches(token.slice(dot + 1), stateMac(body))) {
    throw new GoogleLoginError("start_again", START_AGAIN, 400);
  }
  let s: Record<string, unknown>;
  try {
    s = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new GoogleLoginError("start_again", START_AGAIN, 400);
  }
  const str = (k: string) => typeof s[k] === "string" && s[k] !== "";
  if (
    s["v"] !== 1 ||
    !str("account_id") ||
    !str("profile_id") ||
    !str("nonce") ||
    !str("phrase_hash") ||
    typeof s["issued_at"] !== "number"
  ) {
    throw new GoogleLoginError("start_again", START_AGAIN, 400);
  }
  return s as unknown as GoogleLoginState;
}

/** Pure: signed by us, under ten minutes old, its nonce the cookie's, this account's, this phrase's. */
export function verifyGoogleState(
  token: string | null | undefined,
  args: { nonceCookie: string | null | undefined; accountId: string; now?: Date },
): GoogleLoginState {
  const state = readState(token);
  const now = (args.now ?? new Date()).getTime();
  if (now - state.issued_at > GOOGLE_LOGIN_TTL_MS || state.issued_at - now > SKEW_MS) {
    throw new GoogleLoginError("start_again", START_AGAIN, 400);
  }
  if (!args.nonceCookie || !secretMatches(args.nonceCookie, state.nonce)) {
    throw new GoogleLoginError("start_again", START_AGAIN, 400);
  }
  if (state.account_id !== args.accountId) {
    throw new GoogleLoginError(
      "foreign",
      "That Google sign-in was started from a different ScaleX account.",
      403,
    );
  }
  if (state.phrase_hash !== phraseHash(GOOGLE_REVIEWS_PHRASE)) {
    throw new GoogleLoginError("phrase", "The confirmation phrase didn't match.", 422);
  }
  return state;
}

/** EXACTLY the registry's scope, refused by name otherwise. */
export function googleScopeParam(
  scopes: readonly string[] = expectedExecutionScopes(GOOGLE_PROVIDER),
): string {
  verifyExecutionScopes(GOOGLE_PROVIDER, scopes);
  return [...scopes].sort().join(" ");
}

export function buildGoogleAuthorizeUrl(args: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  const url = new URL(GOOGLE_AUTHORIZE_URL);
  url.searchParams.set("client_id", args.clientId);
  url.searchParams.set("redirect_uri", args.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", googleScopeParam());
  // A refresh token for the daily read, asked for every time so it comes back.
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", args.state);
  url.searchParams.set("code_challenge", args.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

/* ── the pending grant ─────────────────────────────────────────────── */

export interface PendingGoogle {
  v: 1;
  account_id: string;
  profile_id: string;
  refresh_token: string;
  expires_at: number;
}

export function sealGooglePending(p: PendingGoogle): string {
  return Buffer.from(encryptSecret(JSON.stringify(p))).toString("base64url");
}

const NO_PENDING = "There's no Google sign-in waiting, or it expired. Sign in with Google again.";

export function openGooglePending(
  raw: string | null | undefined,
  args: { accountId: string; profileId: string; now?: Date },
): PendingGoogle {
  if (!raw) throw new GoogleLoginError("start_again", NO_PENDING, 409);
  let p: Record<string, unknown>;
  try {
    p = JSON.parse(decryptSecret(Buffer.from(raw, "base64url").toString("utf8"))) as Record<
      string,
      unknown
    >;
  } catch {
    throw new GoogleLoginError("start_again", NO_PENDING, 409);
  }
  if (
    p["v"] !== 1 ||
    typeof p["refresh_token"] !== "string" ||
    typeof p["expires_at"] !== "number" ||
    (args.now ?? new Date()).getTime() > p["expires_at"]
  ) {
    throw new GoogleLoginError("start_again", NO_PENDING, 409);
  }
  if (p["account_id"] !== args.accountId || p["profile_id"] !== args.profileId) {
    throw new GoogleLoginError("foreign", NO_PENDING, 403);
  }
  return p as unknown as PendingGoogle;
}

function log(event: string, accountId: string | null, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event, account_id: accountId, ...fields }));
}

/** A Google refusal's reason code. */
export function reasonForGoogleFailure(error: unknown): GoogleReason {
  if (error instanceof GoogleLoginError) return error.reason;
  if (error instanceof GbpRequestError) {
    switch (error.kind) {
      case "auth":
        return "google_auth";
      case "permission":
        return "google_permission";
      case "quota":
      case "unavailable":
        return "google_busy";
      default:
        return "google_refused";
    }
  }
  if (error instanceof ExecutionConnectionError && error.status === 422) return "scope";
  return "internal";
}

/* ── the steps ─────────────────────────────────────────────────────── */

/** Step 1, before any redirect: configured, the phrase typed, nothing live already. */
export async function startGoogleLogin(args: {
  accountId: string;
  profileId: string;
  confirmation: unknown;
  config: GoogleLoginConfig | null;
  now?: Date;
}): Promise<{ authorize_url: string; nonce: string }> {
  if (args.config === null) {
    throw new GoogleLoginError("unavailable", "Reading reviews from Google isn't set up yet.", 503);
  }
  const typed = typeof args.confirmation === "string" ? args.confirmation : "";
  if (!googlePhraseMatches(typed)) {
    log("google_login_start", args.accountId, { outcome: "phrase_mismatch" });
    throw new GoogleLoginError(
      "phrase",
      `Type "${GOOGLE_REVIEWS_PHRASE}" to confirm. Nothing was sent to Google.`,
      422,
    );
  }
  if (await activeExecutionConnection(args.accountId, GOOGLE_PROVIDER)) {
    throw new GoogleLoginError(
      "already_connected",
      "Google Business Profile is already connected. Revoke it first.",
      409,
    );
  }
  const nonce = randomBytes(24).toString("base64url");
  const state = signGoogleState({
    v: 1,
    account_id: args.accountId,
    profile_id: args.profileId,
    nonce,
    phrase_hash: phraseHash(typed),
    issued_at: (args.now ?? new Date()).getTime(),
  });
  log("google_login_start", args.accountId, { outcome: "redirected" });
  return {
    authorize_url: buildGoogleAuthorizeUrl({
      clientId: args.config.client.client_id,
      redirectUri: args.config.redirect_uri,
      state,
      codeChallenge: codeChallengeFor(codeVerifierFor(nonce)),
    }),
    nonce,
  };
}

export type GoogleCallbackOutcome =
  | { kind: "connected"; connection: PublicExecutionConnection }
  | { kind: "pick"; pending: string; count: number }
  | { kind: "cancelled" }
  | { kind: "failed"; reason: GoogleReason };

/**
 * Step 2, Google's redirect back. The state must verify against the nonce
 * cookie and the signed-in account; the code is exchanged with the PKCE
 * verifier; the grant must hold exactly the one scope and a refresh token.
 * One location connects now; several wait, encrypted, for the owner's pick.
 */
export async function completeGoogleCallback(args: {
  accountId: string | null;
  userId: string | null;
  query: { code: string | null; state: string | null; error: string | null };
  nonceCookie: string | null | undefined;
  config: GoogleLoginConfig | null;
  fetchImpl?: FetchLike;
  now?: Date;
}): Promise<GoogleCallbackOutcome> {
  const done = (outcome: GoogleCallbackOutcome, extra: Record<string, unknown> = {}) => {
    log("google_login_callback", args.accountId, {
      outcome: outcome.kind,
      ...(outcome.kind === "failed" ? { reason: outcome.reason } : {}),
      ...extra,
    });
    return outcome;
  };
  if (args.query.error !== null) {
    return done(
      args.query.error === "access_denied"
        ? { kind: "cancelled" }
        : { kind: "failed", reason: "google_error" },
    );
  }
  if (args.config === null) return done({ kind: "failed", reason: "unavailable" });
  if (args.accountId === null) return done({ kind: "failed", reason: "signed_out" });
  try {
    const state = verifyGoogleState(args.query.state, {
      nonceCookie: args.nonceCookie,
      accountId: args.accountId,
      ...(args.now ? { now: args.now } : {}),
    });
    if (!args.query.code) return done({ kind: "failed", reason: "start_again" });
    const tokens = await exchangeCode(
      args.config.client,
      {
        code: args.query.code,
        redirectUri: args.config.redirect_uri,
        codeVerifier: codeVerifierFor(state.nonce),
      },
      args.fetchImpl,
    );
    // Exactly the one scope, before anything is read with it.
    verifyExecutionScopes(GOOGLE_PROVIDER, tokens.scopes);
    if (tokens.refresh_token === null) return done({ kind: "failed", reason: "no_refresh" });
    const locations = await listLocations(tokens.access_token, args.fetchImpl);
    if (locations.length === 0) return done({ kind: "failed", reason: "no_locations" });
    if (locations.length === 1) {
      const { connection } = await consentToGoogleReviews({
        accountId: state.account_id,
        profileId: state.profile_id,
        userId: args.userId,
        confirmation: GOOGLE_REVIEWS_PHRASE,
        refreshToken: tokens.refresh_token,
        location: locations[0] as GbpLocation,
        client: args.config.client,
        ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}),
      });
      return done({ kind: "connected", connection }, { connection_id: connection.id });
    }
    return done(
      {
        kind: "pick",
        count: locations.length,
        pending: sealGooglePending({
          v: 1,
          account_id: state.account_id,
          profile_id: state.profile_id,
          refresh_token: tokens.refresh_token,
          expires_at: (args.now ?? new Date()).getTime() + GOOGLE_LOGIN_TTL_MS,
        }),
      },
      { count: locations.length },
    );
  } catch (error) {
    const reason = reasonForGoogleFailure(error);
    if (reason === "internal") {
      console.error(
        JSON.stringify({
          event: "google_login_callback_failed",
          account_id: args.accountId,
          ...logSafeError(error),
        }),
      );
    }
    return done({ kind: "failed", reason });
  }
}

/** The picker's list: re-read from Google with the waiting grant, which never leaves. */
export async function listPendingLocations(args: {
  accountId: string;
  profileId: string;
  pendingCookie: string | null | undefined;
  config: GoogleLoginConfig | null;
  fetchImpl?: FetchLike;
  now?: Date;
}): Promise<GbpLocation[]> {
  if (args.config === null) {
    throw new GoogleLoginError("unavailable", "Reading reviews from Google isn't set up yet.", 503);
  }
  const pending = openGooglePending(args.pendingCookie, {
    accountId: args.accountId,
    profileId: args.profileId,
    ...(args.now ? { now: args.now } : {}),
  });
  const tokens = await refreshAccess(args.config.client, pending.refresh_token, args.fetchImpl);
  return listLocations(tokens.access_token, args.fetchImpl);
}

/** Step 3, the pick: found again in Google's own list, then the consent. */
export async function finishGoogleLogin(args: {
  accountId: string;
  profileId: string;
  userId: string | null;
  location: unknown;
  pendingCookie: string | null | undefined;
  config: GoogleLoginConfig | null;
  fetchImpl?: FetchLike;
  now?: Date;
}): Promise<PublicExecutionConnection> {
  if (args.config === null) {
    throw new GoogleLoginError("unavailable", "Reading reviews from Google isn't set up yet.", 503);
  }
  const pending = openGooglePending(args.pendingCookie, {
    accountId: args.accountId,
    profileId: args.profileId,
    ...(args.now ? { now: args.now } : {}),
  });
  const tokens = await refreshAccess(args.config.client, pending.refresh_token, args.fetchImpl);
  const picked = typeof args.location === "string" ? args.location.trim() : "";
  const location = (await listLocations(tokens.access_token, args.fetchImpl)).find(
    (l) => `${l.account}/${l.location}` === picked,
  );
  if (!location) {
    throw new GoogleLoginError("start_again", "Pick one of the locations listed.", 422);
  }
  const { connection } = await consentToGoogleReviews({
    accountId: args.accountId,
    profileId: args.profileId,
    userId: args.userId,
    confirmation: GOOGLE_REVIEWS_PHRASE,
    refreshToken: pending.refresh_token,
    location,
    client: args.config.client,
    ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}),
  });
  log("google_login_finish", args.accountId, {
    outcome: "connected",
    connection_id: connection.id,
  });
  return connection;
}
