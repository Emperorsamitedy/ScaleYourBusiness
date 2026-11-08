// Connecting TikTok Ads — TikTok Ads (specs/tiktok-ads-api-v1.md), mirroring
// Google's and Meta's sign-ins (I-45a, P3-20j).
//
// The owner types the consent phrase on OUR screen first; only then does SYB
// send them to TikTok's advertiser authorization page for SYB's app. TikTok
// shows the app's permission list; the advertiser confirms, verifies by an
// emailed code, and TikTok sends them back with an `auth_code`, valid for an
// hour and once. The server trades it (app id + secret, never the browser)
// for a long-term token, the ad accounts it reaches and its scope ids. The
// scopes must be EXACTLY the registry's (P3-20b: one more or fewer is refused
// by name); then the token is proven by reading the ad accounts' currencies,
// encrypted at rest, and the consent is a decision-log row whose hash covers
// what was shown, what was typed, the scopes and the ad accounts. Consent and
// connection stand or fall together.
//
// What protects each step (Google's flow; TikTok has no PKCE):
//   · state — signed (HMAC under a key derived from the server secret), ten
//     minutes, bound to the account, the business, a nonce and the hash of
//     the phrase typed. Compared in constant time.
//   · single use — the nonce also sits in an httpOnly cookie scoped to
//     /api/connections/tiktok, cleared by the callback whatever happens.
//   · TikTok's side — the token exchange and GET reads only, through
//     lib/tiktok/api's fence.
//
// No line logs a token, an auth code or the app secret.

import { createHash, createHmac, randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { businessProfiles, decisionLog } from "../../db/schema";
import { derivedKey } from "../core/derived-key";
import { logSafeError } from "../core/log-safe";
import { secretMatches } from "../core/secret-compare";
import type { TikTokAdsEnv } from "../env";
import { appUrl } from "../env";
import type { PublicExecutionConnection } from "../execution/connections";
import {
  ExecutionConnectionError,
  activeExecutionConnection,
  connectForExecution,
  disconnectExecution,
  verifyExecutionScopes,
} from "../execution/connections";
import { phraseHash } from "../execution/meta-login";
import { EXECUTION_SCOPE_REGISTRY } from "../execution/scopes";
import type { TikTokContext, TikTokCredential } from "./api";
import { TikTokRequestError, defaultTikTokContext, parseTikTokCredential, tiktokCall } from "./api";
import { TIKTOK_MAX_ADVERTISERS, readAdvertiserCurrencies } from "./read";
import type { TikTokReason } from "./reasons";
import { tiktokScopeNames } from "./scopes";

export const TIKTOK_PROVIDER = "tiktok_ads" as const;
/** What the owner types to confirm: the act, in their words. */
export const TIKTOK_PHRASE = "allow tiktok ad changes";

/** TikTok's advertiser authorization page (spec: the URL's shape is verified false). */
export const TIKTOK_AUTHORIZE_URL = "https://business-api.tiktok.com/portal/auth";

export const TIKTOK_LOGIN_TTL_MS = 10 * 60 * 1000;
const SKEW_MS = 60 * 1000;

export const TIKTOK_COOKIE_PATH = "/api/connections/tiktok";
export const TIKTOK_CALLBACK_PATH = "/api/connections/tiktok/callback";
export const TIKTOK_NONCE_COOKIE = "syb_tiktok_nonce";

export class TikTokLoginError extends ExecutionConnectionError {
  readonly reason: TikTokReason;
  constructor(reason: TikTokReason, message: string, status: number) {
    super(message, status);
    this.name = "TikTokLoginError";
    this.reason = reason;
  }
}

const START_AGAIN =
  "That TikTok sign-in expired or was already used. Start again from Connections.";

export function tiktokPhraseMatches(typed: string): boolean {
  return typed.trim().toLowerCase() === TIKTOK_PHRASE;
}

/** The consent lines, verbatim from the registry, in the order the screen shows them. */
export function tiktokConsentLines(): string[] {
  return EXECUTION_SCOPE_REGISTRY[TIKTOK_PROVIDER].consent.map((c) => c.why);
}

/* ── configuration ─────────────────────────────────────────────────── */

export interface TikTokLoginConfig {
  app: Pick<TikTokAdsEnv, "app_id" | "secret">;
  redirect_uri: string;
  app_origin: string;
}

export function tiktokLoginConfig(
  env: TikTokAdsEnv | null,
  requestOrigin: string,
): TikTokLoginConfig | null {
  if (env === null) return null;
  return {
    app: { app_id: env.app_id, secret: env.secret },
    redirect_uri: env.redirect_uri,
    app_origin: (env.app_url ?? requestOrigin).replace(/\/+$/, ""),
  };
}

export function tiktokFlowOrigin(config: TikTokLoginConfig | null, requestOrigin: string): string {
  return config?.app_origin ?? (appUrl() ?? requestOrigin).replace(/\/+$/, "");
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function tiktokCookieOptions(origin: string, maxAgeSeconds = TIKTOK_LOGIN_TTL_MS / 1000) {
  const host = new URL(origin).hostname;
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: !(LOCAL_HOSTS.has(host) || host.endsWith(".localhost")),
    path: TIKTOK_COOKIE_PATH,
    maxAge: maxAgeSeconds,
  };
}

/** /connections with the flow's outcome as a closed code: what the TikTok card reads. */
export function tiktokReturnUrl(
  origin: string,
  outcome: { kind: "connected" | "cancelled" } | { kind: "failed"; reason: TikTokReason },
): string {
  const url = new URL("/connections", origin);
  url.searchParams.set("tiktok", outcome.kind === "failed" ? "error" : outcome.kind);
  if (outcome.kind === "failed") url.searchParams.set("reason", outcome.reason);
  return url.toString();
}

/* ── state ─────────────────────────────────────────────────────────── */

export interface TikTokLoginState {
  v: 1;
  account_id: string;
  profile_id: string;
  nonce: string;
  phrase_hash: string;
  issued_at: number;
}

function stateMac(body: string): string {
  return createHmac("sha256", derivedKey("syb-tiktok-ads-state-v1"))
    .update(`tiktok-ads-state:${body}`)
    .digest("base64url");
}

export function signTikTokState(state: TikTokLoginState): string {
  const body = Buffer.from(JSON.stringify(state)).toString("base64url");
  return `${body}.${stateMac(body)}`;
}

function readState(token: string | null | undefined): TikTokLoginState {
  if (!token) throw new TikTokLoginError("start_again", START_AGAIN, 400);
  const dot = token.lastIndexOf(".");
  if (dot <= 0) throw new TikTokLoginError("start_again", START_AGAIN, 400);
  const body = token.slice(0, dot);
  if (!secretMatches(token.slice(dot + 1), stateMac(body))) {
    throw new TikTokLoginError("start_again", START_AGAIN, 400);
  }
  let s: Record<string, unknown>;
  try {
    s = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new TikTokLoginError("start_again", START_AGAIN, 400);
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
    throw new TikTokLoginError("start_again", START_AGAIN, 400);
  }
  return s as unknown as TikTokLoginState;
}

/** Pure: signed by us, under ten minutes old, its nonce the cookie's, this account's, this phrase's. */
export function verifyTikTokState(
  token: string | null | undefined,
  args: { nonceCookie: string | null | undefined; accountId: string; now?: Date },
): TikTokLoginState {
  const state = readState(token);
  const now = (args.now ?? new Date()).getTime();
  if (now - state.issued_at > TIKTOK_LOGIN_TTL_MS || state.issued_at - now > SKEW_MS) {
    throw new TikTokLoginError("start_again", START_AGAIN, 400);
  }
  if (!args.nonceCookie || !secretMatches(args.nonceCookie, state.nonce)) {
    throw new TikTokLoginError("start_again", START_AGAIN, 400);
  }
  if (state.account_id !== args.accountId) {
    throw new TikTokLoginError(
      "foreign",
      "That TikTok sign-in was started from a different SYB account.",
      403,
    );
  }
  if (state.phrase_hash !== phraseHash(TIKTOK_PHRASE)) {
    throw new TikTokLoginError("phrase", "The confirmation phrase didn't match.", 422);
  }
  return state;
}

export function buildTikTokAuthorizeUrl(args: {
  appId: string;
  redirectUri: string;
  state: string;
}): string {
  const url = new URL(TIKTOK_AUTHORIZE_URL);
  url.searchParams.set("app_id", args.appId);
  url.searchParams.set("state", args.state);
  url.searchParams.set("redirect_uri", args.redirectUri);
  return url.toString();
}

function log(event: string, accountId: string | null, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event, account_id: accountId, ...fields }));
}

/** A refusal's reason code. */
export function reasonForTikTokFailure(error: unknown): TikTokReason {
  if (error instanceof TikTokLoginError) return error.reason;
  if (error instanceof TikTokRequestError) {
    switch (error.kind) {
      case "auth":
        return "tiktok_auth";
      case "permission":
        return "tiktok_permission";
      case "rate_limit":
      case "unavailable":
      case "network":
        return "tiktok_busy";
      default:
        return "tiktok_refused";
    }
  }
  if (error instanceof ExecutionConnectionError && error.status === 422) return "scope";
  return "internal";
}

/* ── the token exchange ────────────────────────────────────────────── */

/** auth_code → the credential SYB stores: token, ad accounts, scope ids. One attempt (a code works once). */
export async function exchangeTikTokCode(
  ctx: TikTokContext,
  app: TikTokLoginConfig["app"],
  authCode: string,
): Promise<TikTokCredential> {
  const data = await tiktokCall(ctx, "access_token", {
    body: { app_id: app.app_id, secret: app.secret, auth_code: authCode },
  });
  const token = typeof data["access_token"] === "string" ? data["access_token"] : "";
  const ids = Array.isArray(data["advertiser_ids"]) ? data["advertiser_ids"].map(String) : [];
  const scope = Array.isArray(data["scope"]) ? data["scope"] : [];
  if (token === "" || /\s/.test(token)) {
    throw new TikTokLoginError("tiktok_refused", "TikTok didn't return an access token.", 502);
  }
  if (ids.length === 0) {
    throw new TikTokLoginError("no_advertisers", "TikTok showed SYB no ad account.", 422);
  }
  if (!scope.every((s) => typeof s === "number" && Number.isInteger(s) && s >= 0)) {
    throw new TikTokLoginError("tiktok_refused", "TikTok reported a scope SYB can't read.", 502);
  }
  return parseTikTokCredential(
    JSON.stringify({
      v: 1,
      access_token: token,
      advertiser_ids: ids.slice(0, TIKTOK_MAX_ADVERTISERS),
      scope_ids: scope,
    }),
  );
}

export function hashTikTokConsent(p: {
  account_id: string;
  connection_id: string;
  granted_scopes: readonly string[];
  consent_lines: readonly string[];
  typed_confirmation: string;
  advertiser_ids: readonly string[];
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        kind: "consent",
        account_id: p.account_id,
        connection_id: p.connection_id,
        provider: TIKTOK_PROVIDER,
        granted_scopes: [...p.granted_scopes].sort(),
        consent_lines: [...p.consent_lines],
        typed_confirmation: p.typed_confirmation,
        advertiser_ids: [...p.advertiser_ids].sort(),
      }),
    )
    .digest("hex");
}

/**
 * Grant: refused, with nothing stored, unless the phrase matches and the
 * business is this account's; then scope-matched exactly, proven with
 * TikTok (each ad account's currency is read), encrypted, stored and logged.
 */
export async function consentToTikTokAds(args: {
  accountId: string;
  profileId: string;
  userId: string | null;
  confirmation: string;
  credential: TikTokCredential;
  ctx?: TikTokContext;
}): Promise<{ connection: PublicExecutionConnection; consent_hash: string }> {
  if (!tiktokPhraseMatches(args.confirmation)) {
    throw new TikTokLoginError(
      "phrase",
      `Type "${TIKTOK_PHRASE}" to confirm. Nothing was connected.`,
      422,
    );
  }
  const [profile] = await db
    .select({ id: businessProfiles.id })
    .from(businessProfiles)
    .where(
      and(eq(businessProfiles.id, args.profileId), eq(businessProfiles.account_id, args.accountId)),
    );
  if (!profile) throw new ExecutionConnectionError("no such business on this account", 404);
  const ctx = args.ctx ?? defaultTikTokContext();

  const connection = await connectForExecution({
    accountId: args.accountId,
    provider: TIKTOK_PROVIDER,
    secret: JSON.stringify(args.credential),
    // TikTok reports scopes only at the exchange; the proof is that the token reads every ad account.
    verify: async (plain) => {
      const cred = parseTikTokCredential(plain);
      const granted = tiktokScopeNames(cred.scope_ids);
      verifyExecutionScopes(TIKTOK_PROVIDER, granted);
      await readAdvertiserCurrencies(ctx, cred, args.accountId);
      return { granted_scopes: granted };
    },
  });
  const consent_hash = hashTikTokConsent({
    account_id: args.accountId,
    connection_id: connection.id,
    granted_scopes: connection.granted_scopes,
    consent_lines: tiktokConsentLines(),
    typed_confirmation: TIKTOK_PHRASE,
    advertiser_ids: args.credential.advertiser_ids,
  });
  try {
    await db.insert(decisionLog).values({
      profile_id: profile.id,
      actor: "owner",
      kind: "consent",
      ref_id: connection.id,
      payload_hash: consent_hash,
      user_id: args.userId,
    });
  } catch (error) {
    // No consent on record means no access at rest.
    await disconnectExecution(args.accountId, connection.id);
    throw error;
  }
  log("execution_consent", args.accountId, {
    provider: TIKTOK_PROVIDER,
    connection_id: connection.id,
    advertisers: args.credential.advertiser_ids.length,
  });
  return { connection, consent_hash };
}

/** Revoke: the access is deleted here at once (the row stays, its secret wiped). */
export async function revokeTikTokAds(
  accountId: string,
  connectionId: string,
): Promise<PublicExecutionConnection> {
  const row = await activeExecutionConnection(accountId, TIKTOK_PROVIDER);
  if (!row || row.id !== connectionId) {
    throw new ExecutionConnectionError("connection not found", 404);
  }
  const connection = await disconnectExecution(accountId, connectionId);
  log("execution_disconnected", accountId, {
    provider: TIKTOK_PROVIDER,
    connection_id: connection.id,
  });
  return connection;
}

/* ── the steps ─────────────────────────────────────────────────────── */

/** Step 1, before any redirect: configured, the phrase typed, nothing live already. */
export async function startTikTokLogin(args: {
  accountId: string;
  profileId: string;
  confirmation: unknown;
  config: TikTokLoginConfig | null;
  now?: Date;
}): Promise<{ authorize_url: string; nonce: string }> {
  if (args.config === null) {
    throw new TikTokLoginError("unavailable", "TikTok Ads isn't set up yet.", 503);
  }
  const typed = typeof args.confirmation === "string" ? args.confirmation : "";
  if (!tiktokPhraseMatches(typed)) {
    log("tiktok_login_start", args.accountId, { outcome: "phrase_mismatch" });
    throw new TikTokLoginError(
      "phrase",
      `Type "${TIKTOK_PHRASE}" to confirm. Nothing was sent to TikTok.`,
      422,
    );
  }
  if (await activeExecutionConnection(args.accountId, TIKTOK_PROVIDER)) {
    throw new TikTokLoginError(
      "already_connected",
      "TikTok is already connected. Revoke it first.",
      409,
    );
  }
  const nonce = randomBytes(24).toString("base64url");
  const state = signTikTokState({
    v: 1,
    account_id: args.accountId,
    profile_id: args.profileId,
    nonce,
    phrase_hash: phraseHash(typed),
    issued_at: (args.now ?? new Date()).getTime(),
  });
  log("tiktok_login_start", args.accountId, { outcome: "redirected" });
  return {
    authorize_url: buildTikTokAuthorizeUrl({
      appId: args.config.app.app_id,
      redirectUri: args.config.redirect_uri,
      state,
    }),
    nonce,
  };
}

export type TikTokCallbackOutcome =
  | { kind: "connected"; connection: PublicExecutionConnection }
  | { kind: "cancelled" }
  | { kind: "failed"; reason: TikTokReason };

/**
 * Step 2, TikTok's redirect back. The state must verify against the nonce
 * cookie and the signed-in account; the auth code is exchanged server-side;
 * the scopes must be exactly the registry's; then the consent.
 */
export async function completeTikTokCallback(args: {
  accountId: string | null;
  userId: string | null;
  query: { auth_code: string | null; state: string | null; error: string | null };
  nonceCookie: string | null | undefined;
  config: TikTokLoginConfig | null;
  ctx?: TikTokContext;
  now?: Date;
}): Promise<TikTokCallbackOutcome> {
  const done = (outcome: TikTokCallbackOutcome, extra: Record<string, unknown> = {}) => {
    log("tiktok_login_callback", args.accountId, {
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
        : { kind: "failed", reason: "tiktok_error" },
    );
  }
  if (args.config === null) return done({ kind: "failed", reason: "unavailable" });
  if (args.accountId === null) return done({ kind: "failed", reason: "signed_out" });
  const ctx = args.ctx ?? defaultTikTokContext();
  try {
    const state = verifyTikTokState(args.query.state, {
      nonceCookie: args.nonceCookie,
      accountId: args.accountId,
      ...(args.now ? { now: args.now } : {}),
    });
    if (!args.query.auth_code) return done({ kind: "failed", reason: "start_again" });
    const credential = await exchangeTikTokCode(ctx, args.config.app, args.query.auth_code);
    // Exactly the registry's scopes, before anything is read with the token.
    verifyExecutionScopes(TIKTOK_PROVIDER, tiktokScopeNames(credential.scope_ids));
    const { connection } = await consentToTikTokAds({
      accountId: state.account_id,
      profileId: state.profile_id,
      userId: args.userId,
      confirmation: TIKTOK_PHRASE,
      credential,
      ctx,
    });
    return done({ kind: "connected", connection }, { connection_id: connection.id });
  } catch (error) {
    const reason = reasonForTikTokFailure(error);
    if (reason === "internal") {
      console.error(
        JSON.stringify({
          event: "tiktok_login_callback_failed",
          account_id: args.accountId,
          ...logSafeError(error),
        }),
      );
    }
    return done({ kind: "failed", reason });
  }
}
