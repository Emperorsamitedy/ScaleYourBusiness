// Connecting TikTok posting — the owner override of 2026-11-08, rule 13.
//
// Write access is its own consent: an execute connection holding EXACTLY the
// registry's tiktok_publish scopes (video.publish, plus the reads
// user.info.basic and video.list), through connectForExecution's door, its
// secret AES-256-GCM-encrypted under CONNECTOR_KEY like every other.
//
// The flow mirrors Google's (I-45a) and Meta's (P3-20j):
//   1. start — the owner types the phrase on SYB's screen; only then a 303 to
//      TikTok's Login Kit screen asking for exactly those scopes, with a
//      signed, ten-minute, single-use `state` bound to the account, the
//      business, a nonce (also an httpOnly cookie) and the phrase's hash.
//   2. callback — the cookie cleared whatever happens; a cancel is a plain
//      sentence; otherwise the state verified, the code exchanged server-side
//      (TikTok's web flow takes no PKCE), the granted scopes matched exactly,
//      creator_info read to prove the grant can post and to name the account,
//      and the consent written to the decision log. If the log row can't be
//      written, the connection is disconnected again.
//   3. revoke — the secret wiped here at once (the row kept for provenance),
//      and TikTok asked to revoke the token too (best effort; the screen says
//      where to check in the app if that fails).
//
// One account per sign-in, so there is no picker. No line logs a token, a
// code or the client secret.

import { createHash, createHmac, randomBytes } from "node:crypto";
import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "../../db";
import { businessProfiles, contentItems, decisionLog } from "../../db/schema";
import { derivedKey } from "../core/derived-key";
import { logSafeError } from "../core/log-safe";
import { secretMatches } from "../core/secret-compare";
import type { TikTokAuditStatus, TikTokPostingEnv } from "../env";
import { appUrl } from "../env";
import type { PublicExecutionConnection } from "./connections";
import {
  ExecutionConnectionError,
  activeExecutionConnection,
  connectForExecution,
  disconnectExecution,
  executionSecret,
  expectedExecutionScopes,
  verifyExecutionScopes,
} from "./connections";
import { phraseHash } from "./meta-login";
import type { TikTokCalls } from "./providers/tiktok";
import {
  TIKTOK_AUTHORIZE_URL,
  TIKTOK_PROVIDER,
  TikTokRequestError,
  credentialFromGrant,
  parseTikTokCredential,
} from "./providers/tiktok";
import { resumeAfterReconnect } from "./pause";
import { EXECUTION_SCOPE_REGISTRY } from "./scopes";

export const TIKTOK_PHRASE = "allow tiktok posting";
export const TIKTOK_LOGIN_TTL_MS = 10 * 60 * 1000;
const SKEW_MS = 60 * 1000;
export const TIKTOK_COOKIE_PATH = "/api/connections/tiktok-posting";
export const TIKTOK_CALLBACK_PATH = "/api/connections/tiktok-posting/callback";
export const TIKTOK_NONCE_COOKIE = "syb_tiktok_posting_nonce";

export function tiktokPhraseMatches(typed: string): boolean {
  return typed.trim().toLowerCase() === TIKTOK_PHRASE;
}

/** The consent lines, verbatim from the registry, in the order the screen shows them. */
export function tiktokConsentLines(): string[] {
  return EXECUTION_SCOPE_REGISTRY[TIKTOK_PROVIDER].consent.map((c) => c.why);
}

/* ── the card's plain words ─────────────────────────────────────────── */

/** Access honesty: what TikTok allows until it has audited SYB's app. */
export const TIKTOK_ACCESS_WORDS: Readonly<Record<TikTokAuditStatus, string>> = {
  unaudited:
    'Until TikTok audits ScaleX\'s app, everything ScaleX posts goes out private: only you can see it on TikTok ("Only me"). Once the audit passes you can choose who sees each post. TikTok also lets an unaudited app post for only a few accounts a day.',
  audited:
    "TikTok has audited ScaleX's app: you choose who can see each post, from TikTok's own options.",
};

/** What must be in place before it works. */
export const TIKTOK_NEEDS: readonly string[] = [
  "ScaleX's own TikTok app, with Login Kit and the Content Posting API (Direct Post) switched on.",
  "You sign in with the TikTok account the posts go to, and allow what TikTok asks about.",
  "Each post is a video you approve, with who can see it chosen by you on Content first.",
];

export const TIKTOK_NOT_SET_UP =
  "Not set up yet: ScaleX's TikTok app keys aren't in place. Until then, nothing can be posted to TikTok.";

export const TIKTOK_REVOKE_NOTE =
  "Disconnecting deletes ScaleX's access here at once and asks TikTok to revoke it too. Posts already on TikTok stay there. To check on TikTok's side, open Settings and privacy, then Security and permissions, then Apps and services permissions.";

/* ── configuration ─────────────────────────────────────────────────── */

export interface TikTokLoginConfig {
  redirect_uri: string;
  app_origin: string;
  client_key: string;
}

export function tiktokLoginConfig(
  env: TikTokPostingEnv | null,
  requestOrigin: string,
): TikTokLoginConfig | null {
  if (env === null) return null;
  const app_origin = (env.app_url ?? requestOrigin).replace(/\/+$/, "");
  return {
    client_key: env.client_key,
    redirect_uri: env.redirect_uri ?? `${app_origin}${TIKTOK_CALLBACK_PATH}`,
    app_origin,
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

/** Why a TikTok sign-in came back without connecting: a closed set the URL may carry. */
export const TIKTOK_REASONS = [
  "start_here",
  "signed_out",
  "owner_only",
  "unavailable",
  "phrase",
  "already_connected",
  "start_again",
  "foreign",
  "tiktok_error",
  "scope",
  "tiktok_refused",
  "internal",
] as const;
export type TikTokReason = (typeof TIKTOK_REASONS)[number];

export function isTikTokReason(v: unknown): v is TikTokReason {
  return typeof v === "string" && (TIKTOK_REASONS as readonly string[]).includes(v);
}

/** /connections with the flow's outcome as a closed code. */
export function tiktokReturnUrl(
  origin: string,
  outcome: { kind: "connected" | "cancelled" } | { kind: "failed"; reason: TikTokReason },
): string {
  const url = new URL("/connections", origin);
  url.searchParams.set("tiktok", outcome.kind === "failed" ? "error" : outcome.kind);
  if (outcome.kind === "failed") url.searchParams.set("reason", outcome.reason);
  return url.toString();
}

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
  return createHmac("sha256", derivedKey("syb-tiktok-posting-state-v1"))
    .update(`tiktok-posting-state:${body}`)
    .digest("base64url");
}

export function signTikTokState(state: TikTokLoginState): string {
  const body = Buffer.from(JSON.stringify(state)).toString("base64url");
  return `${body}.${stateMac(body)}`;
}

/** Pure: signed by us, under ten minutes old, its nonce the cookie's, this account's, this phrase's. */
export function verifyTikTokState(
  token: string | null | undefined,
  args: { nonceCookie: string | null | undefined; accountId: string; now?: Date },
): TikTokLoginState {
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
  const state = s as unknown as TikTokLoginState;
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
      "That TikTok sign-in was started from a different ScaleX account.",
      403,
    );
  }
  if (state.phrase_hash !== phraseHash(TIKTOK_PHRASE)) {
    throw new TikTokLoginError("phrase", "The confirmation phrase didn't match.", 422);
  }
  return state;
}

/** EXACTLY the registry's scopes, comma-separated as TikTok takes them; refused by name otherwise. */
export function tiktokScopeParam(
  scopes: readonly string[] = expectedExecutionScopes(TIKTOK_PROVIDER),
): string {
  verifyExecutionScopes(TIKTOK_PROVIDER, scopes);
  return [...scopes].sort().join(",");
}

export function buildTikTokAuthorizeUrl(args: {
  clientKey: string;
  redirectUri: string;
  state: string;
}): string {
  const url = new URL(TIKTOK_AUTHORIZE_URL);
  url.searchParams.set("client_key", args.clientKey);
  url.searchParams.set("scope", tiktokScopeParam());
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", args.redirectUri);
  url.searchParams.set("state", args.state);
  // Always TikTok's own screen, even with a live TikTok session: the owner sees what is granted.
  url.searchParams.set("disable_auto_auth", "1");
  return url.toString();
}

function log(event: string, accountId: string | null, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event, account_id: accountId, ...fields }));
}

export function reasonForTikTokFailure(error: unknown): TikTokReason {
  if (error instanceof TikTokLoginError) return error.reason;
  if (error instanceof TikTokRequestError) return "tiktok_refused";
  if (error instanceof ExecutionConnectionError && error.status === 422) return "scope";
  return "internal";
}

async function defaultCalls(): Promise<TikTokCalls> {
  const { tiktokExecution } = await import("./providers/tiktok");
  return tiktokExecution.calls;
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
    throw new TikTokLoginError("unavailable", "TikTok posting isn't set up yet.", 503);
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
  const live = await activeExecutionConnection(args.accountId, TIKTOK_PROVIDER);
  // A paused connection is reconnected through this same door (connectForExecution).
  if (live && live.status !== "paused") {
    throw new TikTokLoginError(
      "already_connected",
      "TikTok posting is already connected. Disconnect it first.",
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
      clientKey: args.config.client_key,
      redirectUri: args.config.redirect_uri,
      state,
    }),
    nonce,
  };
}

export function hashTikTokConsent(p: {
  account_id: string;
  connection_id: string;
  granted_scopes: readonly string[];
  consent_lines: readonly string[];
  typed_confirmation: string;
  open_id: string;
  audit: TikTokAuditStatus;
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
        open_id: p.open_id,
        // What the card said about access when the owner consented.
        access_words: TIKTOK_ACCESS_WORDS[p.audit],
      }),
    )
    .digest("hex");
}

export type TikTokCallbackOutcome =
  | { kind: "connected"; connection: PublicExecutionConnection; proposed: number }
  | { kind: "cancelled" }
  | { kind: "failed"; reason: TikTokReason };

/**
 * Step 2, TikTok's redirect back: state verified against the nonce cookie
 * and the signed-in account; the code exchanged; exactly the consent's
 * scopes; creator_info proving the grant can post; the consent on record.
 */
export async function completeTikTokCallback(args: {
  accountId: string | null;
  userId: string | null;
  query: { code: string | null; state: string | null; error: string | null };
  nonceCookie: string | null | undefined;
  config: TikTokLoginConfig | null;
  audit: TikTokAuditStatus;
  calls?: TikTokCalls;
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
  const now = args.now ?? new Date();
  try {
    const state = verifyTikTokState(args.query.state, {
      nonceCookie: args.nonceCookie,
      accountId: args.accountId,
      now,
    });
    if (!args.query.code) return done({ kind: "failed", reason: "start_again" });
    const calls = args.calls ?? (await defaultCalls());
    const grant = await calls.exchangeCode(args.query.code, args.config.redirect_uri);
    // Exactly the consent's scopes, before anything is read with them.
    verifyExecutionScopes(TIKTOK_PROVIDER, grant.scopes);
    const { connection, proposed } = await consentToTikTokPosting({
      accountId: state.account_id,
      profileId: state.profile_id,
      userId: args.userId,
      confirmation: TIKTOK_PHRASE,
      grant,
      audit: args.audit,
      calls,
      now,
    });
    return done({ kind: "connected", connection, proposed }, { connection_id: connection.id });
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

/**
 * The consent itself: refused, with nothing stored, unless the phrase
 * matches and the business is this account's; then proven with TikTok
 * (creator_info names the account and proves video.publish works),
 * scope-matched exactly, encrypted, stored and logged.
 */
export async function consentToTikTokPosting(args: {
  accountId: string;
  profileId: string;
  userId: string | null;
  confirmation: string;
  grant: Parameters<typeof credentialFromGrant>[0];
  audit: TikTokAuditStatus;
  calls: TikTokCalls;
  now?: Date;
}): Promise<{ connection: PublicExecutionConnection; consent_hash: string; proposed: number }> {
  if (!tiktokPhraseMatches(args.confirmation)) {
    throw new ExecutionConnectionError(
      `type "${TIKTOK_PHRASE}" to confirm — nothing was connected`,
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

  const creator = await args.calls.creatorInfo(args.grant.access_token, args.accountId);
  const cred = credentialFromGrant(args.grant, args.now ?? new Date(), {
    username: creator.username,
    nickname: creator.nickname,
  });
  const connection = await connectForExecution({
    accountId: args.accountId,
    provider: TIKTOK_PROVIDER,
    secret: JSON.stringify(cred),
    // Proven above: the token exchange names the scopes, creator_info proves posting works.
    verify: async (plain) => ({ granted_scopes: parseTikTokCredential(plain).scopes }),
  });
  const consent_hash = hashTikTokConsent({
    account_id: args.accountId,
    connection_id: connection.id,
    granted_scopes: connection.granted_scopes,
    consent_lines: tiktokConsentLines(),
    typed_confirmation: TIKTOK_PHRASE,
    open_id: cred.open_id,
    audit: args.audit,
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
  });
  // A reconnect after a pause: the held posts go back in the queue, the held
  // runs become runnable — every guard again on the next run (lib/execution/pause.ts).
  try {
    await resumeAfterReconnect({
      accountId: args.accountId,
      provider: TIKTOK_PROVIDER,
      announce: true,
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "consent_resume_failed",
        account_id: args.accountId,
        provider: TIKTOK_PROVIDER,
        ...logSafeError(error),
      }),
    );
  }
  return { connection, consent_hash, proposed: await proposeWaiting(profile.id, args.accountId) };
}

/** After the consent: offer every waiting draft for publishing. Logged, never thrown. */
async function proposeWaiting(profileId: string, accountId: string): Promise<number> {
  try {
    const waiting = await db
      .select({ id: contentItems.id })
      .from(contentItems)
      .where(
        and(
          eq(contentItems.profile_id, profileId),
          eq(contentItems.status, "drafted"),
          isNull(contentItems.publish_proposal_id),
        ),
      )
      .orderBy(asc(contentItems.created_at));
    const { proposePublishing } = await import("../content/publish");
    const run = await proposePublishing(
      profileId,
      waiting.map((w) => w.id),
    );
    return run.created.length;
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "consent_publish_proposals_failed",
        account_id: accountId,
        provider: TIKTOK_PROVIDER,
        ...logSafeError(error),
      }),
    );
    return 0;
  }
}

/**
 * Disconnect: the access deleted here at once (the row stays, its secret
 * wiped), then TikTok asked to revoke the token. Only this account's TikTok
 * connection; anything else is "not found".
 */
export async function revokeTikTokPosting(
  accountId: string,
  connectionId: string,
  opts: { calls?: TikTokCalls; now?: Date } = {},
): Promise<{ connection: PublicExecutionConnection; revoked_on_tiktok: boolean }> {
  const row = await activeExecutionConnection(accountId, TIKTOK_PROVIDER);
  if (!row || row.id !== connectionId) {
    throw new ExecutionConnectionError("connection not found", 404);
  }
  let token: string | null;
  let calls: TikTokCalls | null = null;
  try {
    const stored = parseTikTokCredential(executionSecret(row));
    token = stored.access_token;
    // The access token lives two hours; TikTok's grant lives on with the
    // refresh token. A stale one is refreshed first (best effort) so the
    // revoke reaches the grant itself (review 2026-11-08).
    try {
      calls = opts.calls ?? (await defaultCalls());
      token = (await calls.fresh(stored, opts.now ?? new Date())).cred.access_token;
    } catch {
      // Revoke with what is stored; the screen says so if TikTok refuses it.
    }
  } catch {
    token = null;
  }
  const connection = await disconnectExecution(accountId, connectionId);
  let revoked = false;
  if (token !== null) {
    try {
      calls = calls ?? opts.calls ?? (await defaultCalls());
      await calls.revoke(token);
      revoked = true;
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: "tiktok_revoke_failed",
          account_id: accountId,
          ...logSafeError(error),
        }),
      );
    }
  }
  log("execution_disconnected", accountId, {
    provider: TIKTOK_PROVIDER,
    connection_id: connection.id,
    revoked_on_tiktok: revoked,
  });
  return { connection, revoked_on_tiktok: revoked };
}
