// Auth — Session I (P1-49). The resume-link philosophy at account level:
// an email and a signed link, no password, only sha256 hashes at rest.
//
// Signup and login are the same motion. Requesting a link for an email
// nobody has used yet creates nothing; the account/user pair is created
// at REDEEM time, from the profile the browser held when it asked — so
// an abandoned login request leaves no orphan rows, and the intake work
// the owner did anonymously is claimed by their email the moment they
// prove they own it.
//
// Redeeming returns both the auth session token AND the account's
// profile id: the caller sets the auth cookie (durable identity) and
// re-points the existing intake cookie (working credential). Every
// intake/profile/report route keeps working untouched.

import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { db } from "../../db";
import {
  accounts,
  authSessions,
  businessProfiles,
  loginTokens,
  pushSubscriptions,
  users,
} from "../../db/schema";
import { normaliseEmail } from "../intake/resume";

export class AuthError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "AuthError";
    this.status = status;
  }
}

const TOKEN_BYTES = 32;
export const LOGIN_TTL_MINUTES = 15;
export const SESSION_TTL_DAYS = 90;

function hash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface LoginRequest {
  /** Goes into the emailed link. Never stored. */
  token: string;
  email: string;
  expires_at: string;
}

/**
 * Ask for a sign-in link. `profileId` is whatever intake session the
 * browser currently holds — it is remembered on the token so that
 * redeeming can bind that profile's account to the email.
 */
export async function requestLogin(
  rawEmail: string,
  profileId: string | null,
): Promise<LoginRequest> {
  const email = normaliseEmail(rawEmail);
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  const expires = new Date(Date.now() + LOGIN_TTL_MINUTES * 60_000).toISOString();

  await db.insert(loginTokens).values({
    email,
    token_hash: hash(token),
    profile_id: profileId,
    expires_at: expires,
  });

  return { token, email, expires_at: expires };
}

export interface RedeemedSession {
  /** Goes into the auth cookie. Never stored. */
  session_token: string;
  session_expires_at: string;
  account_id: string;
  user_id: string;
  email: string;
  /** The account's profile — re-point the intake cookie here. */
  profile_id: string | null;
}

/**
 * Redeem a login link. One-shot: a token that has been used, expired,
 * or never existed all fail the same way, with nothing to enumerate.
 */
/**
 * The address a sign-in link was sent to, WITHOUT using the link up — the
 * confirm page (login CSRF, security audit 2026-10-17) shows it before the
 * person signs in, so a link someone else sent them names its real owner.
 * A GET also never burns the link, so a mail scanner opening it can't.
 */
export async function peekLogin(token: string): Promise<{ email: string }> {
  const [row] = await db
    .select({ email: loginTokens.email })
    .from(loginTokens)
    .where(
      and(
        eq(loginTokens.token_hash, hash(token)),
        isNull(loginTokens.used_at),
        gt(loginTokens.expires_at, new Date().toISOString()),
      ),
    );
  if (!row) throw new AuthError("that sign-in link is no longer valid", 401);
  return { email: row.email };
}

export async function redeemLogin(token: string): Promise<RedeemedSession> {
  const now = new Date().toISOString();
  const [row] = await db
    .select()
    .from(loginTokens)
    .where(
      and(
        eq(loginTokens.token_hash, hash(token)),
        isNull(loginTokens.used_at),
        gt(loginTokens.expires_at, now),
      ),
    );
  if (!row) throw new AuthError("that sign-in link is no longer valid", 401);

  // Claimed atomically: of two concurrent redeems, only the one that flips
  // used_at from null wins — the other gets the same refusal as a used link.
  const claimed = await db
    .update(loginTokens)
    .set({ used_at: now })
    .where(and(eq(loginTokens.id, row.id), isNull(loginTokens.used_at)))
    .returning({ id: loginTokens.id });
  if (claimed.length === 0) throw new AuthError("that sign-in link is no longer valid", 401);

  return signInWithEmail(row.email, row.profile_id);
}

/**
 * The account side of any proven sign-in — shared by the emailed link
 * and the OAuth callbacks, which each prove email ownership their own
 * way before landing here.
 *
 * Existing user for this email → their account. Otherwise create the
 * user on the account of the profile the browser held — the "claim
 * your anonymous intake" path. With neither, a fresh account: the
 * intake starts after sign-in instead of before.
 */
export async function signInWithEmail(
  rawEmail: string,
  profileId: string | null,
): Promise<RedeemedSession> {
  const email = normaliseEmail(rawEmail);
  let user = (await db.select().from(users).where(eq(users.email, email)))[0];
  if (!user) {
    let accountId: string | null = null;
    if (profileId) {
      const [profile] = await db
        .select({ account_id: businessProfiles.account_id })
        .from(businessProfiles)
        .where(eq(businessProfiles.id, profileId));
      if (!profile) throw new AuthError("that sign-in is no longer valid", 401);
      // Never join an account that already has a user: a profile id is not
      // proof of anything (the security review of 2026-10-17). Such a
      // sign-in gets its own fresh account instead.
      const [someone] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.account_id, profile.account_id))
        .limit(1);
      if (!someone) accountId = profile.account_id;
    }
    if (accountId === null) {
      const [account] = await db
        .insert(accounts)
        .values({ reporting_currency: "HUF", locale: "en-GB" })
        .returning({ id: accounts.id });
      if (!account) throw new AuthError("could not create the account", 500);
      accountId = account.id;
    }
    const [created] = await db
      .insert(users)
      .values({
        account_id: accountId,
        email,
        display_name: email.split("@")[0] ?? email,
        role: "owner",
      })
      .returning();
    if (!created) throw new AuthError("could not create the account", 500);
    user = created;
    await db
      .update(accounts)
      .set({ owner_user_id: created.id })
      .where(and(eq(accounts.id, accountId), isNull(accounts.owner_user_id)));
  }

  const sessionToken = randomBytes(TOKEN_BYTES).toString("base64url");
  const sessionExpires = new Date(Date.now() + SESSION_TTL_DAYS * 86_400_000).toISOString();
  await db.insert(authSessions).values({
    account_id: user.account_id,
    user_id: user.id,
    token_hash: hash(sessionToken),
    expires_at: sessionExpires,
  });

  const [profile] = await db
    .select({ id: businessProfiles.id })
    .from(businessProfiles)
    .where(eq(businessProfiles.account_id, user.account_id));

  return {
    session_token: sessionToken,
    session_expires_at: sessionExpires,
    account_id: user.account_id,
    user_id: user.id,
    email: user.email,
    profile_id: profile?.id ?? null,
  };
}

export interface AuthedSession {
  account_id: string;
  user_id: string;
  email: string;
  profile_id: string | null;
  /** The auth_sessions row: idea 53 ties a phone's alerts to the sign-in that switched them on. */
  session_id?: string;
}

/** Resolve the auth cookie's token to a live session, or null. */
export async function currentSession(token: string | undefined): Promise<AuthedSession | null> {
  if (!token) return null;
  const now = new Date().toISOString();
  const [row] = await db
    .select({
      session_id: authSessions.id,
      account_id: authSessions.account_id,
      user_id: authSessions.user_id,
      email: users.email,
    })
    .from(authSessions)
    .innerJoin(users, eq(users.id, authSessions.user_id))
    .where(
      and(
        eq(authSessions.token_hash, hash(token)),
        isNull(authSessions.revoked_at),
        gt(authSessions.expires_at, now),
      ),
    );
  if (!row) return null;
  const [profile] = await db
    .select({ id: businessProfiles.id })
    .from(businessProfiles)
    .where(eq(businessProfiles.account_id, row.account_id));
  return { ...row, profile_id: profile?.id ?? null };
}

/**
 * Sign out: the session stops resolving without being deleted. Idea 53:
 * the phone alerts switched on in this sign-in go with it, in the same
 * transaction: a signed-out phone gets nothing more.
 */
export async function revokeSession(token: string | undefined): Promise<void> {
  if (!token) return;
  await db.transaction(async (tx) => {
    const revoked = await tx
      .update(authSessions)
      .set({ revoked_at: new Date().toISOString() })
      .where(eq(authSessions.token_hash, hash(token)))
      .returning({ id: authSessions.id });
    for (const r of revoked) {
      await tx.delete(pushSubscriptions).where(eq(pushSubscriptions.session_id, r.id));
    }
  });
}
