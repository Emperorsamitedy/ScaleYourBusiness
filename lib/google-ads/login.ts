// Connecting Google Ads — P2-20 / P3-22, mirroring the Business Profile
// sign-in (I-45a) and reusing its OAuth plumbing: the authorize URL, the
// PKCE challenge and the fenced token exchange (lib/google-business).
//
// The owner types the consent phrase on OUR screen first; only then does SYB
// send them to Google's consent screen, asking for exactly the registry's one
// scope (adwords), offline with prompt=consent so Google returns a refresh
// token. Google sends them back with a code; the server trades it for tokens
// and lists the Google Ads accounts the grant reaches directly. One ad
// account connects at once; with several, the owner picks. Manager accounts
// are listed as not connectable: SYB reads and changes the ad account itself.
//
// What protects each step (the Business Profile flow's, with its own keys):
//   · state — signed under a key derived for Google Ads alone, ten minutes,
//     bound to the account, the business, a nonce and the phrase's hash
//   · single use — the nonce also sits in an httpOnly cookie scoped to
//     /api/connections/google-ads, cleared by the callback whatever happens
//   · PKCE (S256) — the verifier is derived from that nonce under its own key
//   · the refresh token — never sent to the browser; between the callback and
//     the pick it lives encrypted in an httpOnly ten-minute cookie
//   · the pick — looked up again in Google's own list for that grant
//
// No line logs a token, a code or the client secret.

import { createHmac, randomBytes } from "node:crypto";
import { derivedKey } from "../core/derived-key";
import { logSafeError } from "../core/log-safe";
import { secretMatches } from "../core/secret-compare";
import { decryptSecret, encryptSecret } from "../connectors/secrets";
import type { GoogleAdsEnv } from "../env";
import { appUrl } from "../env";
import type { PublicExecutionConnection } from "../execution/connections";
import {
  ExecutionConnectionError,
  activeExecutionConnection,
  expectedExecutionScopes,
  verifyExecutionScopes,
} from "../execution/connections";
import { phraseHash } from "../execution/meta-login";
import {
  GOOGLE_AUTHORIZE_URL,
  GbpRequestError,
  exchangeCode,
  refreshAccess,
} from "../google-business/client";
import { codeChallengeFor } from "../google-business/login";
import type { FetchLike, GadsCustomer, GadsHeaderEnv } from "./client";
import { GadsRequestError, listAccessibleCustomers, readCustomer } from "./client";
import {
  GOOGLE_ADS_PHRASE,
  GOOGLE_ADS_PROVIDER,
  consentToGoogleAds,
  googleAdsPhraseMatches,
} from "./consent";
import type { GoogleAdsReason } from "./reasons";

export const GADS_LOGIN_TTL_MS = 10 * 60 * 1000;
const SKEW_MS = 60 * 1000;

export const GADS_COOKIE_PATH = "/api/connections/google-ads";
export const GADS_CALLBACK_PATH = "/api/connections/google-ads/callback";
export const GADS_NONCE_COOKIE = "syb_google_ads_nonce";
export const GADS_PENDING_COOKIE = "syb_google_ads_pending";
/** The most ad accounts described for the owner to pick from. */
export const GADS_CUSTOMERS_CAP = 20;

export class GoogleAdsLoginError extends ExecutionConnectionError {
  readonly reason: GoogleAdsReason;
  constructor(reason: GoogleAdsReason, message: string, status: number) {
    super(message, status);
    this.name = "GoogleAdsLoginError";
    this.reason = reason;
  }
}

const START_AGAIN =
  "That Google sign-in expired or was already used. Start again from Connections.";
const NOT_SET_UP = "Google Ads isn't set up yet.";

/* ── configuration ─────────────────────────────────────────────────── */

export interface GoogleAdsLoginConfig {
  client: Pick<GoogleAdsEnv, "client_id" | "client_secret">;
  headers: GadsHeaderEnv;
  redirect_uri: string;
  app_origin: string;
}

/** Null while Google Ads isn't configured (lib/env googleAdsEnv). */
export function googleAdsLoginConfig(
  env: GoogleAdsEnv | null,
  requestOrigin: string,
): GoogleAdsLoginConfig | null {
  if (env === null) return null;
  const app_origin = (env.app_url ?? requestOrigin).replace(/\/+$/, "");
  return {
    client: { client_id: env.client_id, client_secret: env.client_secret },
    headers: { developer_token: env.developer_token, login_customer_id: env.login_customer_id },
    redirect_uri: env.redirect_uri ?? `${app_origin}${GADS_CALLBACK_PATH}`,
    app_origin,
  };
}

export function googleAdsFlowOrigin(
  config: GoogleAdsLoginConfig | null,
  requestOrigin: string,
): string {
  return config?.app_origin ?? (appUrl() ?? requestOrigin).replace(/\/+$/, "");
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function googleAdsCookieOptions(origin: string, maxAgeSeconds = GADS_LOGIN_TTL_MS / 1000) {
  const host = new URL(origin).hostname;
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: !(LOCAL_HOSTS.has(host) || host.endsWith(".localhost")),
    path: GADS_COOKIE_PATH,
    maxAge: maxAgeSeconds,
  };
}

/** /connections with the flow's outcome as a closed code: what the Google Ads section reads. */
export function googleAdsReturnUrl(
  origin: string,
  outcome:
    { kind: "connected" | "pick" | "cancelled" } | { kind: "failed"; reason: GoogleAdsReason },
): string {
  const url = new URL("/connections", origin);
  url.searchParams.set("gads", outcome.kind === "failed" ? "error" : outcome.kind);
  if (outcome.kind === "failed") url.searchParams.set("reason", outcome.reason);
  return url.toString();
}

/* ── state and PKCE ────────────────────────────────────────────────── */

export interface GoogleAdsLoginState {
  v: 1;
  account_id: string;
  profile_id: string;
  nonce: string;
  phrase_hash: string;
  issued_at: number;
}

function stateMac(body: string): string {
  return createHmac("sha256", derivedKey("syb-google-ads-state-v1"))
    .update(`google-ads-state:${body}`)
    .digest("base64url");
}

export function signGoogleAdsState(state: GoogleAdsLoginState): string {
  const body = Buffer.from(JSON.stringify(state)).toString("base64url");
  return `${body}.${stateMac(body)}`;
}

/** The PKCE verifier for a nonce, under Google Ads' own key. */
export function adsCodeVerifierFor(nonce: string): string {
  return createHmac("sha256", derivedKey("syb-google-ads-pkce-v1"))
    .update(nonce)
    .digest("base64url");
}

function readState(token: string | null | undefined): GoogleAdsLoginState {
  const fail = () => new GoogleAdsLoginError("start_again", START_AGAIN, 400);
  if (!token) throw fail();
  const dot = token.lastIndexOf(".");
  if (dot <= 0) throw fail();
  const body = token.slice(0, dot);
  if (!secretMatches(token.slice(dot + 1), stateMac(body))) throw fail();
  let s: Record<string, unknown>;
  try {
    s = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    throw fail();
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
    throw fail();
  }
  return s as unknown as GoogleAdsLoginState;
}

/** Pure: signed by us, under ten minutes old, its nonce the cookie's, this account's, this phrase's. */
export function verifyGoogleAdsState(
  token: string | null | undefined,
  args: { nonceCookie: string | null | undefined; accountId: string; now?: Date },
): GoogleAdsLoginState {
  const state = readState(token);
  const now = (args.now ?? new Date()).getTime();
  if (now - state.issued_at > GADS_LOGIN_TTL_MS || state.issued_at - now > SKEW_MS) {
    throw new GoogleAdsLoginError("start_again", START_AGAIN, 400);
  }
  if (!args.nonceCookie || !secretMatches(args.nonceCookie, state.nonce)) {
    throw new GoogleAdsLoginError("start_again", START_AGAIN, 400);
  }
  if (state.account_id !== args.accountId) {
    throw new GoogleAdsLoginError(
      "foreign",
      "That Google sign-in was started from a different ScaleX account.",
      403,
    );
  }
  if (state.phrase_hash !== phraseHash(GOOGLE_ADS_PHRASE)) {
    throw new GoogleAdsLoginError("phrase", "The confirmation phrase didn't match.", 422);
  }
  return state;
}

/** EXACTLY the registry's one scope, refused by name otherwise. */
export function googleAdsScopeParam(
  scopes: readonly string[] = expectedExecutionScopes(GOOGLE_ADS_PROVIDER),
): string {
  verifyExecutionScopes(GOOGLE_ADS_PROVIDER, scopes);
  return [...scopes].sort().join(" ");
}

export function buildGoogleAdsAuthorizeUrl(args: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  const url = new URL(GOOGLE_AUTHORIZE_URL);
  url.searchParams.set("client_id", args.clientId);
  url.searchParams.set("redirect_uri", args.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", googleAdsScopeParam());
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", args.state);
  url.searchParams.set("code_challenge", args.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

/* ── the pending grant ─────────────────────────────────────────────── */

export interface PendingGoogleAds {
  v: 1;
  account_id: string;
  profile_id: string;
  refresh_token: string;
  expires_at: number;
}

export function sealGoogleAdsPending(p: PendingGoogleAds): string {
  return Buffer.from(encryptSecret(JSON.stringify(p))).toString("base64url");
}

const NO_PENDING = "There's no Google sign-in waiting, or it expired. Sign in with Google again.";

export function openGoogleAdsPending(
  raw: string | null | undefined,
  args: { accountId: string; profileId: string; now?: Date },
): PendingGoogleAds {
  if (!raw) throw new GoogleAdsLoginError("start_again", NO_PENDING, 409);
  let p: Record<string, unknown>;
  try {
    p = JSON.parse(decryptSecret(Buffer.from(raw, "base64url").toString("utf8"))) as Record<
      string,
      unknown
    >;
  } catch {
    throw new GoogleAdsLoginError("start_again", NO_PENDING, 409);
  }
  if (
    p["v"] !== 1 ||
    typeof p["refresh_token"] !== "string" ||
    typeof p["expires_at"] !== "number" ||
    (args.now ?? new Date()).getTime() > p["expires_at"]
  ) {
    throw new GoogleAdsLoginError("start_again", NO_PENDING, 409);
  }
  if (p["account_id"] !== args.accountId || p["profile_id"] !== args.profileId) {
    throw new GoogleAdsLoginError("foreign", NO_PENDING, 403);
  }
  return p as unknown as PendingGoogleAds;
}

function log(event: string, accountId: string | null, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event, account_id: accountId, ...fields }));
}

/** A refusal's reason code. */
export function reasonForGoogleAdsFailure(error: unknown): GoogleAdsReason {
  if (error instanceof GoogleAdsLoginError) return error.reason;
  if (error instanceof GadsRequestError || error instanceof GbpRequestError) {
    switch (error.kind) {
      case "access_level":
        return "access_level";
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

/** Every ad account the grant reaches directly, described, managers included (and marked). */
export async function describeAccessible(
  accessToken: string,
  headers: GadsHeaderEnv,
  fetchImpl?: FetchLike,
): Promise<GadsCustomer[]> {
  const ids = (await listAccessibleCustomers({ accessToken, env: headers }, fetchImpl)).slice(
    0,
    GADS_CUSTOMERS_CAP,
  );
  const out: GadsCustomer[] = [];
  for (const customerId of ids) {
    try {
      out.push(await readCustomer({ accessToken, env: headers, customerId }, fetchImpl));
    } catch (error) {
      // The access level refuses every real account alike: say so, don't skip quietly.
      if (error instanceof GadsRequestError && error.kind === "access_level") throw error;
      // One account Google won't describe is left off the list, not a failed sign-in.
    }
  }
  return out;
}

/* ── the steps ─────────────────────────────────────────────────────── */

/** Step 1, before any redirect: configured, the phrase typed, nothing live already. */
export async function startGoogleAdsLogin(args: {
  accountId: string;
  profileId: string;
  confirmation: unknown;
  config: GoogleAdsLoginConfig | null;
  now?: Date;
}): Promise<{ authorize_url: string; nonce: string }> {
  if (args.config === null) throw new GoogleAdsLoginError("unavailable", NOT_SET_UP, 503);
  const typed = typeof args.confirmation === "string" ? args.confirmation : "";
  if (!googleAdsPhraseMatches(typed)) {
    log("google_ads_login_start", args.accountId, { outcome: "phrase_mismatch" });
    throw new GoogleAdsLoginError(
      "phrase",
      `Type "${GOOGLE_ADS_PHRASE}" to confirm. Nothing was sent to Google.`,
      422,
    );
  }
  if (await activeExecutionConnection(args.accountId, GOOGLE_ADS_PROVIDER)) {
    throw new GoogleAdsLoginError(
      "already_connected",
      "Google Ads is already connected. Revoke it first.",
      409,
    );
  }
  const nonce = randomBytes(24).toString("base64url");
  const state = signGoogleAdsState({
    v: 1,
    account_id: args.accountId,
    profile_id: args.profileId,
    nonce,
    phrase_hash: phraseHash(typed),
    issued_at: (args.now ?? new Date()).getTime(),
  });
  log("google_ads_login_start", args.accountId, { outcome: "redirected" });
  return {
    authorize_url: buildGoogleAdsAuthorizeUrl({
      clientId: args.config.client.client_id,
      redirectUri: args.config.redirect_uri,
      state,
      codeChallenge: codeChallengeFor(adsCodeVerifierFor(nonce)),
    }),
    nonce,
  };
}

export type GoogleAdsCallbackOutcome =
  | { kind: "connected"; connection: PublicExecutionConnection }
  | { kind: "pick"; pending: string; count: number }
  | { kind: "cancelled" }
  | { kind: "failed"; reason: GoogleAdsReason };

/**
 * Step 2, Google's redirect back. The state must verify against the nonce
 * cookie and the signed-in account; the code is exchanged with the PKCE
 * verifier; the grant must hold exactly the one scope and a refresh token.
 * One ad account connects now; several wait, encrypted, for the owner's pick.
 */
export async function completeGoogleAdsCallback(args: {
  accountId: string | null;
  userId: string | null;
  query: { code: string | null; state: string | null; error: string | null };
  nonceCookie: string | null | undefined;
  config: GoogleAdsLoginConfig | null;
  fetchImpl?: FetchLike;
  now?: Date;
}): Promise<GoogleAdsCallbackOutcome> {
  const done = (outcome: GoogleAdsCallbackOutcome, extra: Record<string, unknown> = {}) => {
    log("google_ads_login_callback", args.accountId, {
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
    const state = verifyGoogleAdsState(args.query.state, {
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
        codeVerifier: adsCodeVerifierFor(state.nonce),
      },
      args.fetchImpl,
    );
    // Exactly the one scope, before anything is read with it.
    verifyExecutionScopes(GOOGLE_ADS_PROVIDER, tokens.scopes);
    if (tokens.refresh_token === null) return done({ kind: "failed", reason: "no_refresh" });
    const all = await describeAccessible(tokens.access_token, args.config.headers, args.fetchImpl);
    if (all.length === 0) return done({ kind: "failed", reason: "no_accounts" });
    const connectable = all.filter((c) => !c.manager);
    if (connectable.length === 0) return done({ kind: "failed", reason: "managers_only" });
    if (connectable.length === 1) {
      const { connection } = await consentToGoogleAds({
        accountId: state.account_id,
        profileId: state.profile_id,
        userId: args.userId,
        confirmation: GOOGLE_ADS_PHRASE,
        refreshToken: tokens.refresh_token,
        customer: connectable[0] as GadsCustomer,
        client: args.config.client,
        ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}),
      });
      return done({ kind: "connected", connection }, { connection_id: connection.id });
    }
    return done(
      {
        kind: "pick",
        count: connectable.length,
        pending: sealGoogleAdsPending({
          v: 1,
          account_id: state.account_id,
          profile_id: state.profile_id,
          refresh_token: tokens.refresh_token,
          expires_at: (args.now ?? new Date()).getTime() + GADS_LOGIN_TTL_MS,
        }),
      },
      { count: connectable.length },
    );
  } catch (error) {
    const reason = reasonForGoogleAdsFailure(error);
    if (reason === "internal") {
      console.error(
        JSON.stringify({
          event: "google_ads_login_callback_failed",
          account_id: args.accountId,
          ...logSafeError(error),
        }),
      );
    }
    return done({ kind: "failed", reason });
  }
}

/** The picker's list: re-read from Google with the waiting grant, which never leaves. */
export async function listPendingAdAccounts(args: {
  accountId: string;
  profileId: string;
  pendingCookie: string | null | undefined;
  config: GoogleAdsLoginConfig | null;
  fetchImpl?: FetchLike;
  now?: Date;
}): Promise<GadsCustomer[]> {
  if (args.config === null) throw new GoogleAdsLoginError("unavailable", NOT_SET_UP, 503);
  const pending = openGoogleAdsPending(args.pendingCookie, {
    accountId: args.accountId,
    profileId: args.profileId,
    ...(args.now ? { now: args.now } : {}),
  });
  const tokens = await refreshAccess(args.config.client, pending.refresh_token, args.fetchImpl);
  return describeAccessible(tokens.access_token, args.config.headers, args.fetchImpl);
}

/** Step 3, the pick: found again in Google's own list, then the consent. */
export async function finishGoogleAdsLogin(args: {
  accountId: string;
  profileId: string;
  userId: string | null;
  customerId: unknown;
  pendingCookie: string | null | undefined;
  config: GoogleAdsLoginConfig | null;
  fetchImpl?: FetchLike;
  now?: Date;
}): Promise<PublicExecutionConnection> {
  if (args.config === null) throw new GoogleAdsLoginError("unavailable", NOT_SET_UP, 503);
  const pending = openGoogleAdsPending(args.pendingCookie, {
    accountId: args.accountId,
    profileId: args.profileId,
    ...(args.now ? { now: args.now } : {}),
  });
  const tokens = await refreshAccess(args.config.client, pending.refresh_token, args.fetchImpl);
  const picked =
    typeof args.customerId === "string" ? args.customerId.replace(/-/g, "").trim() : "";
  const customer = (
    await describeAccessible(tokens.access_token, args.config.headers, args.fetchImpl)
  ).find((c) => c.customer_id === picked && !c.manager);
  if (!customer) {
    throw new GoogleAdsLoginError("start_again", "Pick one of the ad accounts listed.", 422);
  }
  const { connection } = await consentToGoogleAds({
    accountId: args.accountId,
    profileId: args.profileId,
    userId: args.userId,
    confirmation: GOOGLE_ADS_PHRASE,
    refreshToken: pending.refresh_token,
    customer,
    client: args.config.client,
    ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}),
  });
  log("google_ads_login_finish", args.accountId, {
    outcome: "connected",
    connection_id: connection.id,
  });
  return connection;
}
