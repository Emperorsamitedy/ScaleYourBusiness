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
//
// Idea 52: one email may now be on several businesses' teams — a users
// row in each, never one row across them. A sign-in for such an email
// opens a session for the business used most recently and says so
// (`choose`), so the screen can ask "Which business?". Moving to another
// is a switch (lib/auth/switch.ts), never a session that spans two.

import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { db } from "../../db";
import {
  accounts,
  authSessions,
  businessProfiles,
  loginTokens,
  pushSubscriptions,
  users,
} from "../../db/schema";
import { isIsoCurrency } from "../core/currencies";
import { withinRateLimit } from "../core/rate-limit";
import { normaliseEmail } from "../intake/resume";
import type { AppLocale } from "../i18n/locales";
import { isAppLocale } from "../i18n/locales";
import { adoptLanguage } from "../i18n/service";
import type { Role } from "./role-actions";

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

// Security review 2026-11-09: an unbounded /api/auth/login is a path to
// email-bombing one victim's inbox (burying the real sign-in link, or as
// cover for a separate attack) and to running up enough Resend volume to
// trip ITS abuse controls — which would throttle EMAIL_FROM for every
// SYB user, not just the attacker's target, i.e. a single-endpoint path
// to a site-wide sign-in outage. Both limits apply to every caller of
// requestLogin (this route and the invite-join route's unauthenticated
// branch), not just one.
const LOGIN_WINDOW_MS = 60 * 60_000; // 1 hour
const LOGIN_LIMIT_PER_EMAIL = 5; // generous for a real owner who fat-fingers their address
const LOGIN_LIMIT_PER_IP = 20; // looser: an office/NAT shares one address

export function hash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// 2026-11-16: every sign-in email carries a 6-digit code beside the link,
// for an owner reading their email on one device and signing in on another.
// The code proves the same thing the link does (they can read that inbox),
// lives exactly as long (LOGIN_TTL_MINUTES) and is spent with it. A million
// codes is a small space, so guessing is capped per address and per network
// (5 and 30 tries in 15 minutes); wrong, expired and used all fail alike.
const CODE_WINDOW_MS = 15 * 60_000;
const CODE_LIMIT_PER_EMAIL = 5;
const CODE_LIMIT_PER_IP = 30;
export const CODE_REFUSED =
  "that code isn't right, or it has expired: check it, or use the link in the email";
export const CODE_TOO_MANY =
  "too many codes tried for that address: use the link in the email, or try again later";

/** A fresh code: six digits, leading zeros kept. */
export function newLoginCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

/** Pure: the stored form of a code, salted with its own token's hash. */
export function codeHash(tokenHash: string, code: string): string {
  return hash(`login-code:${tokenHash}:${code}`);
}

/** Pure: six digits from what was typed (spaces and dashes allowed), else null. */
export function normaliseCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const digits = raw.replace(/[\s-]/g, "");
  return /^\d{6}$/.test(digits) ? digits : null;
}

/**
 * L-1: the language and currency a browser chose before signing in (the
 * sign-up screen's first step). Used only when a sign-in creates the
 * account (its currency) or meets a person who never chose a language;
 * anything unrecognised is ignored, never stored.
 */
export interface SignInChoices {
  language?: string | null | undefined;
  currency?: string | null | undefined;
}

function cleanChoices(c: SignInChoices | undefined): {
  language: AppLocale | null;
  currency: string | null;
} {
  return {
    language: isAppLocale(c?.language) ? c.language : null,
    currency: typeof c?.currency === "string" && isIsoCurrency(c.currency) ? c.currency : null,
  };
}

export interface LoginRequest {
  /** Goes into the emailed link. Never stored. */
  token: string;
  /** Goes into the same email, beside the link. Never stored. */
  code: string;
  email: string;
  expires_at: string;
  /** L-6: the language the link carries (login_tokens.language), for the email itself. */
  language: AppLocale | null;
}

/**
 * Ask for a sign-in link. `profileId` is whatever intake session the
 * browser currently holds — it is remembered on the token so that
 * redeeming can bind that profile's account to the email.
 */
export async function requestLogin(
  rawEmail: string,
  profileId: string | null,
  /** Idea 52: the invite this link was asked for from — redeeming it joins that business. */
  inviteId: string | null = null,
  /** L-1: carried by the link, so a link opened on another device still brings them. */
  choices?: SignInChoices,
  /** The caller's address, as the platform reports it — for the per-IP limit only. */
  clientIp?: string | null,
): Promise<LoginRequest> {
  const email = normaliseEmail(rawEmail);
  if (!(await withinRateLimit(`login:email:${email}`, LOGIN_LIMIT_PER_EMAIL, LOGIN_WINDOW_MS))) {
    throw new AuthError("too many sign-in links requested for that address — try again later", 429);
  }
  const ip = clientIp?.trim();
  if (ip && !(await withinRateLimit(`login:ip:${ip}`, LOGIN_LIMIT_PER_IP, LOGIN_WINDOW_MS))) {
    throw new AuthError("too many sign-in requests from this network — try again later", 429);
  }
  const chosen = cleanChoices(choices);
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  const code = newLoginCode();
  const tokenHash = hash(token);
  const expires = new Date(Date.now() + LOGIN_TTL_MINUTES * 60_000).toISOString();

  await db.insert(loginTokens).values({
    email,
    token_hash: tokenHash,
    code_hash: codeHash(tokenHash, code),
    profile_id: profileId,
    expires_at: expires,
    invite_id: inviteId,
    language: chosen.language,
    currency: chosen.currency,
  });

  return { token, code, email, expires_at: expires, language: chosen.language };
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
  /**
   * Idea 52: this email belongs to more than one business, so the sign-in
   * lands on "Which business?" rather than straight in. The session is for
   * the one used most recently; choosing another is a switch.
   */
  choose: boolean;
  /**
   * L-1: the person's own language after this sign-in (null = never
   * chosen). The route writes it into the language cookie, so the choice
   * follows the person to a new device.
   */
  language?: AppLocale | null;
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
  return spendLogin(row, now, "that sign-in link is no longer valid");
}

/**
 * Redeem the 6-digit code from a sign-in email instead of its link. Any of
 * the address's live codes works (a resend issues another without killing
 * the first); the one that matches is spent exactly as its link would be.
 */
export async function redeemLoginCode(
  rawEmail: string,
  rawCode: unknown,
  /** The caller's address, as the platform reports it — for the per-IP limit only. */
  clientIp?: string | null,
): Promise<RedeemedSession> {
  const email = normaliseEmail(rawEmail);
  if (!(await withinRateLimit(`login-code:email:${email}`, CODE_LIMIT_PER_EMAIL, CODE_WINDOW_MS))) {
    throw new AuthError(CODE_TOO_MANY, 429);
  }
  const ip = clientIp?.trim();
  if (ip && !(await withinRateLimit(`login-code:ip:${ip}`, CODE_LIMIT_PER_IP, CODE_WINDOW_MS))) {
    throw new AuthError(CODE_TOO_MANY, 429);
  }
  const code = normaliseCode(rawCode);
  if (!code) throw new AuthError(CODE_REFUSED, 401);

  const now = new Date().toISOString();
  const live = await db
    .select()
    .from(loginTokens)
    .where(
      and(
        eq(loginTokens.email, email),
        isNull(loginTokens.used_at),
        gt(loginTokens.expires_at, now),
      ),
    );
  const row = live.find((r) => {
    if (!r.code_hash) return false;
    const want = Buffer.from(r.code_hash);
    const got = Buffer.from(codeHash(r.token_hash, code));
    return want.length === got.length && timingSafeEqual(want, got);
  });
  if (!row) throw new AuthError(CODE_REFUSED, 401);
  return spendLogin(row, now, CODE_REFUSED);
}

/** Spend a live login token — link or code — and sign its owner in. */
async function spendLogin(
  row: typeof loginTokens.$inferSelect,
  now: string,
  refusal: string,
): Promise<RedeemedSession> {
  // Claimed atomically: of two concurrent redeems, only the one that flips
  // used_at from null wins — the other gets the same refusal as a used link.
  const claimed = await db
    .update(loginTokens)
    .set({ used_at: now })
    .where(and(eq(loginTokens.id, row.id), isNull(loginTokens.used_at)))
    .returning({ id: loginTokens.id });
  if (claimed.length === 0) throw new AuthError(refusal, 401);

  if (row.invite_id) {
    // Imported here: members.ts builds its sessions with this file's helpers.
    const { joinByInviteId } = await import("./members");
    const joined = await joinByInviteId(row.invite_id, row.email);
    return { ...joined, language: await adoptLanguage(joined.user_id, row.language) };
  }
  return signInWithEmail(row.email, row.profile_id, {
    language: row.language,
    currency: row.currency,
  });
}

/**
 * The account side of any proven sign-in — shared by the emailed link
 * and the OAuth callbacks, which each prove email ownership their own
 * way before landing here.
 *
 * Existing user for this email → their account (the most recently used
 * one, when there are several). Otherwise create the user on the account
 * of the profile the browser held — the "claim your anonymous intake"
 * path. With neither, a fresh account: the intake starts after sign-in
 * instead of before.
 */
export async function signInWithEmail(
  rawEmail: string,
  profileId: string | null,
  /** L-1: the browser's language and currency choices (see SignInChoices). */
  choices?: SignInChoices,
): Promise<RedeemedSession> {
  const email = normaliseEmail(rawEmail);
  const chosen = cleanChoices(choices);
  // Removed rows sign in to nothing. The most recently used business first.
  const rows = await db
    .select()
    .from(users)
    .where(and(eq(users.email, email), isNull(users.removed_at)))
    .orderBy(
      sql`(select max(${authSessions.created_at}) from ${authSessions} where ${authSessions.user_id} = ${users.id}) desc nulls last`,
      users.created_at,
    );
  let user = rows[0];
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
        .values({
          // L-1: the currency chosen at sign-up, else the default the intake may set from the country.
          reporting_currency: chosen.currency ?? "HUF",
          reporting_currency_chosen_at: chosen.currency ? new Date().toISOString() : null,
          locale: "en-GB",
        })
        .returning({ id: accounts.id });
      if (!account) throw new AuthError("could not create the account", 500);
      accountId = account.id;
    }
    user = await createOwner(accountId, email);
  }

  return {
    ...(await openSession(user)),
    choose: rows.length > 1,
    language: await adoptLanguage(user.id, chosen.language),
  };
}

export type UserRow = typeof users.$inferSelect;

/** The first owner of an account: the users row, and the account's pointer to it. */
export async function createOwner(accountId: string, email: string): Promise<UserRow> {
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
  await db
    .update(accounts)
    .set({ owner_user_id: created.id })
    .where(and(eq(accounts.id, accountId), isNull(accounts.owner_user_id)));
  return created;
}

/** A fresh auth session for one users row — a sign-in, a switch, a join. */
export async function openSession(
  user: Pick<UserRow, "id" | "account_id" | "email">,
): Promise<Omit<RedeemedSession, "choose">> {
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
  /** Idea 52: the users row's role, read on every request — a change applies at once. */
  role: Role;
  /** The auth_sessions row: idea 53 ties a phone's alerts to the sign-in that switched them on. */
  session_id?: string;
  /**
   * L-4a: the person's own language (users.language; null until chosen),
   * for the few refusals answered before a request translator exists
   * (lib/auth/roles requireRole). Still gated: a review language is used
   * only for a named reviewer.
   */
  language?: string | null;
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
      role: users.role,
      language: users.language,
    })
    .from(authSessions)
    .innerJoin(users, eq(users.id, authSessions.user_id))
    .where(
      and(
        eq(authSessions.token_hash, hash(token)),
        isNull(authSessions.revoked_at),
        gt(authSessions.expires_at, now),
        // Written together, so they never disagree; checked anyway. And a
        // member taken off the team signs in to nothing (idea 52).
        eq(users.account_id, authSessions.account_id),
        isNull(users.removed_at),
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
 *
 * Review 2026-10-30: a switch of business (or joining one) also retires the
 * browser's session, but the browser is still signed in, just to another
 * business. With `handOverTo` (the new session's token) its phone alerts are
 * re-pointed at the new sign-in instead of deleted: they keep their business
 * and person, and from then on live and die with the sign-in this browser
 * actually holds (signing out of it, or its 90 days, ends them).
 */
export async function revokeSession(
  token: string | undefined,
  opts: { handOverTo?: string } = {},
): Promise<void> {
  if (!token) return;
  await db.transaction(async (tx) => {
    const revoked = await tx
      .update(authSessions)
      .set({ revoked_at: new Date().toISOString() })
      .where(eq(authSessions.token_hash, hash(token)))
      .returning({ id: authSessions.id });
    const [next] = opts.handOverTo
      ? await tx
          .select({ id: authSessions.id })
          .from(authSessions)
          .where(
            and(
              eq(authSessions.token_hash, hash(opts.handOverTo)),
              isNull(authSessions.revoked_at),
            ),
          )
      : [];
    for (const r of revoked) {
      if (next) {
        await tx
          .update(pushSubscriptions)
          .set({ session_id: next.id })
          .where(eq(pushSubscriptions.session_id, r.id));
      } else {
        await tx.delete(pushSubscriptions).where(eq(pushSubscriptions.session_id, r.id));
      }
    }
  });
}
